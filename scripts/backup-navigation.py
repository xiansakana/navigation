#!/usr/bin/env python3
"""Private, verified database snapshot and Navigation runtime files."""
from contextlib import closing
import argparse
import hashlib
import gzip
import shutil
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import time


def rebuildable(file, root):
    return any(part in ['__pycache__', 'node_modules', '.venv', 'venv'] or part.endswith('-venv')
               for part in file.relative_to(root).parts)


SQLITE_BINARY = 'data/navigation.db'
SQLITE_LOGICAL = 'data/navigation.sql.gz'
POSTGRES_DUMP = 'data/navigation.pgdump'
DATABASE_MEMBERS = {'sqlite': SQLITE_BINARY, 'sql-gzip': SQLITE_LOGICAL, 'postgres-custom': POSTGRES_DUMP}


def postgres_connection(service):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', service):
        raise ValueError('Invalid PostgreSQL service name')
    return f'service={service}'


def postgres_command(client):
    container = os.environ.get('NAVIGATION_POSTGRES_CLIENT_CONTAINER')
    if not container:
        return [client]
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', container):
        raise ValueError('Invalid PostgreSQL client container name')
    return ['docker', 'exec', '-i', '-e', 'PGSERVICEFILE=/var/lib/postgresql/data/navigation-backup.pg_service.conf', container, client]


def restore_postgres(snapshot, service):
    connection = postgres_connection(service)
    database, schemas = subprocess.check_output([
        *postgres_command('psql'), '--no-psqlrc', '--no-password', '--tuples-only', '--no-align',
        '--set=ON_ERROR_STOP=1', '--dbname', connection, '--command',
        """SELECT current_database(), count(*) FILTER (WHERE nspname NOT IN
        ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_toast%')
        FROM pg_namespace""",
    ], text=True).strip().split('|')
    if not re.fullmatch(r'navigation_restore_[a-z0-9_]+', database) or schemas != '0':
        raise RuntimeError('PostgreSQL restore requires an empty navigation_restore_* database')
    with snapshot.open('rb') as source:
        subprocess.run([
            *postgres_command('pg_restore'), '--no-password', '--single-transaction', '--exit-on-error',
            '--no-owner', '--no-privileges', '--dbname', connection,
        ], stdin=source, check=True)


def verify(archive, restore=True, postgres_service=None):
    with tempfile.TemporaryDirectory(prefix='navigation-restore-', dir=Path(archive).resolve().parent) as directory:
        with tarfile.open(archive, 'r:gz') as source:
            manifest = json.load(source.extractfile('manifest.json'))
            format_name = manifest.get('databaseFormat', 'sqlite')
            snapshot_member = DATABASE_MEMBERS.get(format_name)
            if not snapshot_member or snapshot_member not in manifest['files']:
                raise RuntimeError('Backup database snapshot is missing')
            for name, expected in manifest['files'].items():
                member = source.getmember(name)
                if not member.isfile():
                    raise RuntimeError('Unexpected backup member')
                stream = source.extractfile(member)
                digest = hashlib.sha256()
                if name == snapshot_member and restore:
                    target = Path(directory) / Path(snapshot_member).name
                    with target.open('wb') as output:
                        while chunk := stream.read(1024 * 1024):
                            digest.update(chunk)
                            output.write(chunk)
                else:
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                if digest.hexdigest() != expected:
                    raise RuntimeError('Backup checksum mismatch')
        if restore:
            if format_name == 'postgres-custom':
                if not postgres_service:
                    raise ValueError('PostgreSQL restore requires --restore-postgres-service')
                restore_postgres(target, postgres_service)
                return manifest
            if format_name == 'sql-gzip':
                compressed = target
                target = Path(directory) / 'navigation.db'
                with closing(sqlite3.connect(target)) as output, gzip.open(compressed, 'rt', encoding='utf-8') as sql:
                    output.execute('PRAGMA cache_size=-65536')
                    statement = ''
                    for line in sql:
                        statement += line
                        if sqlite3.complete_statement(statement):
                            output.execute(statement)
                            statement = ''
                    if statement.strip():
                        raise RuntimeError('Truncated logical backup')
            with closing(sqlite3.connect(f'{target.as_uri()}?mode=ro', uri=True)) as db:
                db.execute('PRAGMA cache_size=-65536')
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup database integrity check failed')
                if db.execute('PRAGMA foreign_key_check').fetchone():
                    raise RuntimeError('Backup database foreign key check failed')
    return manifest


def backup(root, destination, keep=7, database=None, logical=False, postgres_service=None):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    database = Path(database).resolve() if database else root / 'data/navigation.db'
    if keep < 1:
        raise ValueError('keep must be positive')
    # A destination within runtime data would recursively include its own backups.
    if destination == root or root in destination.parents:
        raise ValueError('Backup destination must be outside the repository')
    # Validate directory policy before spending minutes exporting a large database.
    folders = ['data', 'portal/data', 'stock-manage/data', 'qqq-dip/data', 'qq-bot/data', 'torn-toolbox-desktop/data']
    for folder in folders:
        base = root / folder
        if base.exists():
            for file in base.rglob('*'):
                if not rebuildable(file, root) and file.is_symlink():
                    raise RuntimeError('Runtime symlinks need an explicit backup policy')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not postgres_service and not logical and shutil.disk_usage(destination).free < database.stat().st_size * 2 + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient space for snapshot and verification; use logical export with off-host restore verification')
    lock = destination / '.navigation-backup.lock'
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    archive = destination / (time.strftime('navigation-%Y%m%d-%H%M%S-', time.gmtime()) + str(time.time_ns()) + '.tar.gz')
    partial = destination / (archive.name + '.partial')
    try:
        with tempfile.TemporaryDirectory(prefix='navigation-snapshot-', dir=destination) as directory:
            format_name = 'postgres-custom' if postgres_service else 'sql-gzip' if logical else 'sqlite'
            snapshot_member = DATABASE_MEMBERS[format_name]
            snapshot = Path(directory) / Path(snapshot_member).name
            if postgres_service:
                snapshot_postgres(postgres_service, snapshot, destination)
            else:
                snapshot_sqlite(database, snapshot, destination, logical)
            os.chmod(snapshot, 0o600)
            candidates = {snapshot_member: snapshot}
            for folder in folders:
                base = root / folder
                if not base.exists():
                    continue
                for file in base.rglob('*'):
                    if rebuildable(file, root):
                        continue
                    if file.is_symlink():
                        raise RuntimeError('Runtime symlinks need an explicit backup policy')
                    if not file.is_file() or file.name.endswith(('-wal', '-shm')) or file.resolve() == database or file.relative_to(root).as_posix() in DATABASE_MEMBERS.values():
                        continue
                    name = file.relative_to(root).as_posix()
                    with file.open('rb') as probe:
                        is_sqlite = probe.read(16) == b'SQLite format 3\x00'
                    if is_sqlite:
                        snapshot_file = Path(directory) / (hashlib.sha256(name.encode()).hexdigest() + '.db')
                        with closing(sqlite3.connect(f'{file.resolve().as_uri()}?mode=ro', uri=True, timeout=30)) as live:
                            with closing(sqlite3.connect(snapshot_file)) as output:
                                live.backup(output)
                        candidates[name] = snapshot_file
                    else:
                        candidates[name] = file
            for service in ['portal', 'stock-manage', 'qqq-dip', 'qq-bot', 'torn-toolbox-desktop', 'piclist', 'alist', 'siyuan-share']:
                for pattern in ['config*.json', '*.env', '.env', 'config.php']:
                    for file in (root / service).glob(pattern):
                        if file.is_file() and not file.is_symlink():
                            candidates[file.relative_to(root).as_posix()] = file
            manifest = {'version': 1, 'databaseFormat': format_name, 'createdAt': time.time(), 'files': {},
                        'consistency': 'Database snapshot is atomic; mutable files span the backup interval. External storage needs separate backup.'}
            with partial.open('xb') as raw:
                os.chmod(partial, 0o600)
                with tarfile.open(fileobj=raw, mode='w:gz', compresslevel=1) as target:
                    for name, file in sorted(candidates.items()):
                        if Path(directory) in file.parents:
                            # Snapshot files are immutable: stream them directly instead of making
                            # a third, temporary copy of a multi-gigabyte database export.
                            digest = hashlib.sha256()
                            with file.open('rb') as source:
                                while chunk := source.read(1024 * 1024):
                                    digest.update(chunk)
                                source.seek(0)
                                entry = tarfile.TarInfo(name)
                                entry.size, entry.mode = file.stat().st_size, 0o600
                                target.addfile(entry, source)
                            manifest['files'][name] = digest.hexdigest()
                            continue
                        # Spool each file once so the archived bytes always match the recorded digest.
                        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spool, file.open('rb') as source:
                            digest, size = hashlib.sha256(), 0
                            while chunk := source.read(1024 * 1024):
                                spool.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                            spool.seek(0)
                            entry = tarfile.TarInfo(name)
                            entry.size, entry.mode = size, 0o600
                            target.addfile(entry, spool)
                            manifest['files'][name] = digest.hexdigest()
                    payload = json.dumps(manifest).encode()
                    entry = tarfile.TarInfo('manifest.json')
                    entry.size, entry.mode = len(payload), 0o600
                    target.addfile(entry, io.BytesIO(payload))
                raw.flush()
                os.fsync(raw.fileno())
            verify(partial, restore=format_name == 'sqlite')
            partial.replace(archive)
        for old in sorted(destination.glob('navigation-*.tar.gz'), reverse=True)[keep:]:
            old.unlink()
        return archive
    finally:
        partial.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


def snapshot_sqlite(database, snapshot, destination, logical):
    with closing(sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True, timeout=30)) as db:
        if not logical:
            with closing(sqlite3.connect(snapshot)) as output:
                db.backup(output)
            return
        db.execute('BEGIN')
        with gzip.open(snapshot, 'wt', encoding='utf-8', compresslevel=1) as output:
            for index, statement in enumerate(db.iterdump()):
                output.write(statement + '\n')
                if index % 10000 == 0 and shutil.disk_usage(destination).free < 512 * 1024 * 1024:
                    raise RuntimeError('Backup stopped before exhausting disk space')


def snapshot_postgres(service, snapshot, destination):
    command = [
        *postgres_command('pg_dump'), '--no-password', '--format=custom', '--schema=navigation',
        '--no-owner', '--no-privileges', '--dbname', postgres_connection(service),
    ]
    with snapshot.open('xb') as output, subprocess.Popen(command, stdout=subprocess.PIPE) as dump:
        try:
            while chunk := dump.stdout.read(1024 * 1024):
                if shutil.disk_usage(destination).free < 512 * 1024 * 1024:
                    raise RuntimeError('Backup stopped before exhausting disk space')
                output.write(chunk)
        finally:
            if not dump.stdout.closed:
                dump.stdout.close()
        if dump.wait():
            raise RuntimeError('PostgreSQL snapshot failed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--destination', type=Path, default=Path('/opt/backups/navigation'))
    parser.add_argument('--database', type=Path, default=os.environ.get('NAVIGATION_DB_PATH'))
    parser.add_argument('--keep', type=int, default=7)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--postgres-service', help='libpq service for a PostgreSQL snapshot')
    parser.add_argument('--restore-postgres-service', help='libpq service for an empty restore database')
    parser.add_argument('--logical', action='store_true', help='Compressed transaction-consistent SQL export; requires off-host full restore verification')
    args = parser.parse_args()
    if args.verify:
        result = verify(args.verify, postgres_service=args.restore_postgres_service)
        print(json.dumps({'ok': True, 'files': len(result['files'])}))
    else:
        print(backup(args.root, args.destination, args.keep, args.database, args.logical, args.postgres_service))
