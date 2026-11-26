import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

import psycopg


spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup-navigation.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class PostgreSQLBackupTest(unittest.TestCase):
    def test_archive_and_restore_postgres_with_runtime_files(self):
        self.assertRegex(os.environ.get('PGDATABASE', ''), r'^navigation_rehearsal_')
        with psycopg.connect(autocommit=True) as db:
            self.assertRegex(db.execute('SELECT current_database()').fetchone()[0], r'^navigation_rehearsal_')
            db.execute('CREATE DATABASE navigation_restore_backup_ci')
            try:
                with db.transaction():
                    db.execute('CREATE SCHEMA navigation')
                    db.execute('CREATE TABLE navigation.sample (amount BIGINT, media BYTEA)')
                    db.execute('INSERT INTO navigation.sample VALUES (%s, %s)', (2**60, b'\x00\xff'))
                try:
                    with tempfile.TemporaryDirectory() as directory:
                        root = Path(directory) / 'repo'
                        (root / 'data').mkdir(parents=True)
                        (root / 'data' / 'navigation.db').write_bytes(b'obsolete SQLite')
                        (root / 'data' / 'settings.json').write_text('{}', encoding='utf-8')
                        archive = backup.backup(root, Path(directory) / 'archives', postgres_service='backup-source')
                        manifest = backup.verify(archive, postgres_service='backup-restore')
                        self.assertEqual(manifest['databaseFormat'], 'postgres-custom')
                        self.assertEqual(set(manifest['files']), {'data/navigation.pgdump', 'data/settings.json'})
                        with psycopg.connect(dbname='navigation_restore_backup_ci') as restored:
                            self.assertEqual(restored.execute('SELECT amount,media FROM navigation.sample').fetchall(), [(2**60, b'\x00\xff')])
                        with self.assertRaisesRegex(RuntimeError, 'restore requires an empty'):
                            backup.verify(archive, postgres_service='backup-restore')
                finally:
                    db.execute('DROP SCHEMA navigation CASCADE')
            finally:
                db.execute('DROP DATABASE navigation_restore_backup_ci')


if __name__ == '__main__':
    unittest.main()
