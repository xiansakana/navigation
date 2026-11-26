#!/usr/bin/env python3
"""Copy a read-only Navigation SQLite snapshot into a new PostgreSQL rehearsal schema."""

import argparse
from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import struct
import sys

import psycopg
from psycopg import sql


SCHEMA_NAME = re.compile(r"navigation_rehearsal_[a-z0-9_]{1,38}\Z")
ROW_ID = "_sqlite_rowid"
SCHEMA_METADATA = "_sqlite_schema"
TYPES = {"TEXT": "text", "INTEGER": "int8", "REAL": "float8", "BLOB": "bytea"}
BASELINE = Path(__file__).resolve().parents[1] / "shared/db/postgres/001-initial.sql"


class RehearsalError(Exception):
    pass


@dataclass(frozen=True)
class Column:
    name: str
    pg_type: str
    not_null: bool = False
    primary_position: int = 0


def sqlite_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def inspect_columns(source, name):
    if name == "sqlite_sequence":
        return [Column("name", "text"), Column("seq", "int8")]
    columns = []
    for _, column, declared_type, not_null, _, pk, hidden in source.execute(
        "SELECT * FROM pragma_table_xinfo(?)", (name,)
    ):
        pg_type = TYPES.get(declared_type.upper())
        if hidden or not pg_type or column.casefold() in {ROW_ID, "rowid", "oid", "_rowid_"}:
            raise RehearsalError(f"Unsupported column in {name}.{column}")
        columns.append(Column(column, pg_type, bool(not_null), pk))
    if not columns:
        raise RehearsalError(f"No columns found for {name}")
    return columns


def fingerprint_row(digest, row):
    # Tagged binary values retain the difference between a BLOB and its text form.
    values = [
        {"blob": value.hex()} if isinstance(value, bytes)
        else {"float64": struct.pack("!d", value).hex()} if isinstance(value, float)
        else value
        for value in row
    ]
    digest.update(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    digest.update(b"\n")


def copy_table(source, target, namespace, name):
    columns = inspect_columns(source, name)
    table = sql.Identifier(namespace, name)
    definitions = [sql.SQL("{} bigint PRIMARY KEY").format(sql.Identifier(ROW_ID))]
    definitions.extend(
        sql.SQL("{} {}{}").format(
            sql.Identifier(col.name), sql.SQL(col.pg_type),
            sql.SQL(" NOT NULL") if col.not_null else sql.SQL(""),
        )
        for col in columns
    )
    primary_columns = sorted(
        (col for col in columns if col.primary_position),
        key=lambda col: col.primary_position,
    )
    if primary_columns:
        definitions.append(sql.SQL("UNIQUE ({})").format(
            sql.SQL(", ").join(sql.Identifier(col.name) for col in primary_columns)
        ))
    target.execute(sql.SQL("CREATE TABLE {} ({})").format(table, sql.SQL(", ").join(definitions)))
    return copy_verified(source, target, table, name, columns, ROW_ID, True)


def copy_verified(source, target, table, name, columns, order_column, include_rowid):
    column_names = [col.name for col in columns]
    source_columns = ", ".join(sqlite_identifier(column) for column in column_names)
    pg_types = [col.pg_type for col in columns]
    if include_rowid:
        column_names.insert(0, ROW_ID)
        pg_types.insert(0, "int8")
        source_columns = "rowid, " + source_columns
    insert_columns = sql.SQL(", ").join(map(sql.Identifier, column_names))
    rows = source.execute(
        f"SELECT {source_columns} FROM {sqlite_identifier(name)} ORDER BY rowid"
    )
    original = hashlib.sha256()
    count = 0
    with target.copy(sql.SQL("COPY {} ({}) FROM STDIN (FORMAT BINARY)").format(table, insert_columns)) as copy:
        copy.set_types(pg_types)
        for row in rows:
            fingerprint_row(original, row)
            copy.write_row(row)
            count += 1

    imported = hashlib.sha256()
    imported_count = 0
    with target.copy(sql.SQL(
        "COPY (SELECT {} FROM {} ORDER BY {}) TO STDOUT (FORMAT BINARY)"
    ).format(insert_columns, table, sql.Identifier(order_column))) as copy:
        copy.set_types(pg_types)
        for row in copy.rows():
            fingerprint_row(imported, row)
            imported_count += 1
    if count != imported_count or original.digest() != imported.digest():
        raise RehearsalError(f"Count or content verification failed for {name}")
    return count


def copy_baseline(source, target, namespace, tables):
    target.execute(sql.SQL("SET LOCAL search_path = {}, pg_catalog").format(sql.Identifier(namespace)))
    target.execute(BASELINE.read_text(encoding="utf-8"), prepare=False)
    schema = {}
    for table_name, column, pg_type, identity in target.execute("""
        SELECT c.relname, a.attname, t.typname, a.attidentity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = %s AND c.relkind = 'r' AND c.relname <> 'navigation_schema_migrations'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum
    """, (namespace,)):
        schema.setdefault(table_name, []).append((column, pg_type, bool(identity)))
    rowids = dict(source.execute("SELECT name, seq FROM sqlite_sequence")) if "sqlite_sequence" in tables else {}
    tables = [table for table in tables if table != "sqlite_sequence"]
    if set(tables) != set(schema):
        differences = sorted(set(tables) ^ set(schema))
        raise RehearsalError("SQLite and PostgreSQL table sets differ: " + ", ".join(differences))
    total = 0
    for name in tables:
        columns = inspect_columns(source, name)
        expected = [(col.name, col.pg_type) for col in columns]
        identities = [column for column, _, identity in schema[name] if identity]
        if len(identities) != 1:
            raise RehearsalError(f"Unexpected identity columns for {name}")
        order = identities[0]
        actual = [(column, pg_type) for column, pg_type, _ in schema[name] if column != ROW_ID]
        if actual != expected or (
            order != ROW_ID and not any(col.name == order and col.pg_type == "int8" and col.primary_position == 1 for col in columns)
        ):
            raise RehearsalError(f"SQLite and PostgreSQL columns differ for {name}")
        table = sql.Identifier(namespace, name)
        try:
            total += copy_verified(source, target, table, name, columns, order, order == ROW_ID)
            largest_id = source.execute(f"SELECT MAX(rowid) FROM {sqlite_identifier(name)}").fetchone()[0]
            first_available = max(largest_id or 0, rowids.get(name, 0), 0) + 1
            target.execute(sql.SQL("ALTER TABLE {} ALTER COLUMN {} RESTART WITH {}").format(
                table, sql.Identifier(order), sql.Literal(first_available),
            ))
        except (TypeError, ValueError, sqlite3.Error, psycopg.Error) as exc:
            code = getattr(exc, "sqlstate", None) or type(exc).__name__
            raise RehearsalError(f"Could not copy {name} ({code})") from None
    return len(tables), total


def rehearse(sqlite_path, pg_connection, namespace, baseline=False):
    if not SCHEMA_NAME.fullmatch(namespace) and not (baseline and namespace == "navigation"):
        raise RehearsalError("Use a new schema named navigation_rehearsal_<suffix>")
    source_path = Path(sqlite_path).resolve(strict=True)
    with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=30)) as source:
        source.execute("PRAGMA query_only=ON")
        source.execute("BEGIN")
        objects = source.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        ).fetchall()
        tables = [(name, ddl) for kind, name, _, ddl in objects if kind == "table"]
        if not tables:
            raise RehearsalError("The source database has no tables")
        for name, ddl in tables:
            if name in {SCHEMA_METADATA, ROW_ID} or re.search(
                r"\b(?:CREATE\s+VIRTUAL\s+TABLE|WITHOUT\s+ROWID)\b", ddl or "", re.I
            ):
                raise RehearsalError(f"Unsupported SQLite table {name}")

        # The fresh schema, data and verification are committed together.
        with pg_connection.transaction(), pg_connection.cursor() as target:
            target.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(namespace)))
            if baseline:
                count, total = copy_baseline(source, target, namespace, [name for name, _ in tables])
                return {
                    "schema": namespace,
                    "tables": count,
                    "rows": total,
                    "contentVerified": True,
                    "baseline": BASELINE.name,
                }
            schema_table = sql.Identifier(namespace, SCHEMA_METADATA)
            target.execute(sql.SQL(
                "CREATE TABLE {} (type text NOT NULL, name text NOT NULL, table_name text NOT NULL, ddl text, PRIMARY KEY (type, name))"
            ).format(schema_table))
            with target.copy(sql.SQL("COPY {} FROM STDIN").format(schema_table)) as copy:
                for row in objects:
                    copy.write_row(row)
            total = 0
            for name, _ in tables:
                try:
                    total += copy_table(source, target, namespace, name)
                except (TypeError, ValueError, sqlite3.Error, psycopg.Error) as exc:
                    code = getattr(exc, "sqlstate", None) or type(exc).__name__
                    # Database error detail may contain private field values.
                    raise RehearsalError(f"Could not copy {name} ({code})") from None
    return {
        "schema": namespace,
        "tables": len(tables),
        "rows": total,
        "schemaObjects": len(objects),
        "contentVerified": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--baseline", action="store_true",
                        help="Import into the versioned PostgreSQL schema with constraints and identities")
    args = parser.parse_args()
    try:
        # libpq supplies the destination through PGSERVICE, PGDATABASE, and related settings.
        with psycopg.connect(application_name="navigation_migration", connect_timeout=10) as connection:
            print(json.dumps(rehearse(args.sqlite, connection, args.schema, args.baseline)))
    except (RehearsalError, OSError, sqlite3.Error, psycopg.Error) as exc:
        label = str(exc) if isinstance(exc, RehearsalError) else (
            getattr(exc, "sqlstate", None) or type(exc).__name__
        )
        print(f"PostgreSQL rehearsal failed: {label}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
