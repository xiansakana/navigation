#!/usr/bin/env python3
"""Private, verified SQLite online snapshot + runtime files. No live database file copying."""
from contextlib import closing
import argparse
import hashlib
import gzip
import shutil
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import time


def verify(archive, restore=True):
    with tempfile.TemporaryDirectory(prefix='navigation-restore-', dir=Path(archive).resolve().parent) as directory:
        with tarfile.open(archive, 'r:gz') as source:
            manifest = json.load(source.extractfile('manifest.json'))
            for name, expected in manifest['files'].items():
                member = source.getmember(name)
                if not member.isfile():
                    raise RuntimeError('Unexpected backup member')
                stream = source.extractfile(member)
                digest = hashlib.sha256()
                if name in ['data/navigation.db', 'data/navigation.sql.gz'] and restore:
                    target = Path(directory) / ('navigation.sql.gz' if name.endswith('.gz') else 'navigation.db')
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
            if manifest.get('databaseFormat') == 'sql-gzip':
                compressed = target
                target = Path(directory) / 'navigation.db'
                with closing(sqlite3.connect(target)) as output, gzip.open(compressed, 'rt', encoding='utf-8') as sql:
                    statement = ''
                    for line in sql:
                        statement += line
                        if sqlite3.complete_statement(statement):
                            output.execute(statement)
                            statement = ''
                    if statement.strip():
                        raise RuntimeError('Truncated logical backup')
            with closing(sqlite3.connect(f'{target.as_uri()}?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup database integrity check failed')
                if db.execute('PRAGMA foreign_key_check').fetchone():
                    raise RuntimeError('Backup database foreign key check failed')
    return manifest


def backup(root, destination, keep=7, database=None, logical=False):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    database = Path(database).resolve() if database else root / 'data/navigation.db'
    if keep < 1:
        raise ValueError('keep must be positive')
    # A destination within runtime data would recursively include its own backups.
    if destination == root or root in destination.parents:
        raise ValueError('Backup destination must be outside the repository')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not logical and shutil.disk_usage(destination).free < database.stat().st_size * 2 + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient space for snapshot and verification; use logical export with off-host restore verification')
    lock = destination / '.navigation-backup.lock'
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    archive = destination / (time.strftime('navigation-%Y%m%d-%H%M%S-', time.gmtime()) + str(time.time_ns()) + '.tar.gz')
    partial = destination / (archive.name + '.partial')
    try:
        with tempfile.TemporaryDirectory(prefix='navigation-snapshot-', dir=destination) as directory:
            snapshot = Path(directory) / ('navigation.sql.gz' if logical else 'navigation.db')
            with closing(sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True, timeout=30)) as db:
                if logical:
                    db.execute('BEGIN')
                    with gzip.open(snapshot, 'wt', encoding='utf-8', compresslevel=1) as output:
                        for index, statement in enumerate(db.iterdump()):
                            output.write(statement + '\n')
                            if index % 10000 == 0 and shutil.disk_usage(destination).free < 512 * 1024 * 1024:
                                raise RuntimeError('Backup stopped before exhausting disk space')
                else:
                    with closing(sqlite3.connect(snapshot)) as output:
                        db.backup(output)
            os.chmod(snapshot, 0o600)
            candidates = {('data/navigation.sql.gz' if logical else 'data/navigation.db'): snapshot}
            for folder in ['data', 'portal/data', 'stock-manage/data', 'qqq-dip/data', 'qq-bot/data', 'torn-toolbox-desktop/data']:
                base = root / folder
                if not base.exists():
                    continue
                for file in base.rglob('*'):
                    if file.is_symlink():
                        raise RuntimeError('Runtime symlinks need an explicit backup policy')
                    if not file.is_file() or file.name.endswith(('-wal', '-shm')) or file.resolve() == database:
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
            manifest = {'version': 1, 'databaseFormat': 'sql-gzip' if logical else 'sqlite', 'createdAt': time.time(), 'files': {},
                        'consistency': 'SQLite snapshot is atomic; mutable files span the backup interval. External storage needs separate backup.'}
            with partial.open('xb') as raw:
                os.chmod(partial, 0o600)
                with tarfile.open(fileobj=raw, mode='w:gz', compresslevel=1) as target:
                    for name, file in sorted(candidates.items()):
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
            verify(partial, restore=not logical)
            partial.replace(archive)
        for old in sorted(destination.glob('navigation-*.tar.gz'), reverse=True)[keep:]:
            old.unlink()
        return archive
    finally:
        partial.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--destination', type=Path, default=Path('/opt/backups/navigation'))
    parser.add_argument('--database', type=Path, default=os.environ.get('NAVIGATION_DB_PATH'))
    parser.add_argument('--keep', type=int, default=7)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--logical', action='store_true', help='Compressed transaction-consistent SQL export; requires off-host full restore verification')
    args = parser.parse_args()
    if args.verify:
        result = verify(args.verify)
        print(json.dumps({'ok': True, 'files': len(result['files'])}))
    else:
        print(backup(args.root, args.destination, args.keep, args.database, args.logical))
