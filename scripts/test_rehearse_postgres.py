import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

import psycopg
from psycopg import sql


spec = importlib.util.spec_from_file_location(
    "rehearse_postgres", Path(__file__).with_name("rehearse-postgres.py")
)
rehearsal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rehearsal)


class PostgreSQLRehearsalTest(unittest.TestCase):
    def setUp(self):
        path = tempfile.TemporaryDirectory()
        self.addCleanup(path.cleanup)
        self.source_path = Path(path.name) / "navigation.db"
        self.source = sqlite3.connect(self.source_path)
        self.addCleanup(self.source.close)
        self.source.execute("PRAGMA journal_mode=WAL")
        self.assertTrue(os.environ.get("PGDATABASE", "").startswith("navigation_rehearsal"))
        self.target = psycopg.connect(autocommit=True)
        self.addCleanup(self.target.close)
        self.namespace = "navigation_rehearsal_" + uuid.uuid4().hex
        self.addCleanup(lambda: self.target.execute(
            sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(self.namespace))
        ))

    def test_copy_preserves_row_order_binary_null_and_high_water_mark(self):
        self.source.executescript("""
            CREATE TABLE records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                body TEXT, binary_data BLOB, weight REAL, amount INTEGER NOT NULL
            );
            CREATE TABLE account_settings (owner TEXT, setting TEXT, PRIMARY KEY (owner, setting));
            CREATE INDEX settings_owner ON account_settings(owner);
            INSERT INTO account_settings VALUES ('user-a','x'), ('user-b','x');
        """)
        self.source.executemany("INSERT INTO records VALUES(?, ?, ?, ?, ?)", [
            (12, "中文\n\\N\t'", b"\0\xff\n", 1.25, 2**60),
            (2, "", None, 0.0, -100),
            (80, None, b"", None, 0),
            (100, "deleted", b"", None, 0),
        ])
        self.source.execute("DELETE FROM records WHERE id=100")
        self.source.commit()

        report = rehearsal.rehearse(self.source_path, self.target, self.namespace)
        self.assertEqual(report["tables"], 3)
        self.assertEqual(report["rows"], 6)
        self.assertTrue(report["contentVerified"])
        self.assertEqual(self.target.execute(sql.SQL(
            "SELECT _sqlite_rowid,id,body,binary_data,weight,amount FROM {} ORDER BY _sqlite_rowid"
        ).format(sql.Identifier(self.namespace, "records"))).fetchall(), [
            (2, 2, "", None, 0.0, -100),
            (12, 12, "中文\n\\N\t'", b"\0\xff\n", 1.25, 2**60),
            (80, 80, None, b"", None, 0),
        ])
        self.assertEqual(self.target.execute(sql.SQL("SELECT * FROM {}").format(
            sql.Identifier(self.namespace, "sqlite_sequence")
        )).fetchall(), [(1, "records", 100)])
        self.assertEqual(self.target.execute(sql.SQL(
            "SELECT ddl FROM {} WHERE type='index' AND name='settings_owner'"
        ).format(sql.Identifier(self.namespace, rehearsal.SCHEMA_METADATA))).fetchone()[0],
            "CREATE INDEX settings_owner ON account_settings(owner)")
        with self.assertRaises(psycopg.errors.DuplicateSchema):
            rehearsal.rehearse(self.source_path, self.target, self.namespace)
        self.assertEqual(self.source.execute("SELECT count(*) FROM records").fetchone(), (3,))

    def test_unrepresentable_text_rolls_back_the_entire_schema(self):
        self.source.executescript("CREATE TABLE a (id INTEGER PRIMARY KEY); INSERT INTO a VALUES (1);"
                                  "CREATE TABLE b (data TEXT);")
        self.source.execute("INSERT INTO b VALUES (?)", ("embedded\0NUL",))
        self.source.commit()
        with self.assertRaisesRegex(rehearsal.RehearsalError, r"Could not copy b"):
            rehearsal.rehearse(self.source_path, self.target, self.namespace)
        self.assertEqual(self.target.execute("SELECT to_regnamespace(%s)", (self.namespace,)).fetchone(),
                         (None,))


if __name__ == "__main__":
    unittest.main()
