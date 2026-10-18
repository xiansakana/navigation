from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup-navigation.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_live_wal_restore_and_failure_preserves_previous_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root, destination = Path(directory) / 'repo', Path(directory) / 'backups'
            (root / 'data').mkdir(parents=True)
            (root / 'portal/data/knowledge').mkdir(parents=True)
            (root / 'portal/data/knowledge/video').write_bytes(b'video')
            with closing(sqlite3.connect(root / 'data/navigation.db')) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE sample(value TEXT)')
                db.execute("INSERT INTO sample VALUES ('committed-in-wal')")
                db.commit()
                archive = module.backup(root, destination)
                logical = module.backup(root, destination, logical=True)
                self.assertEqual(module.verify(logical)['databaseFormat'], 'sql-gzip')
                self.assertIn('portal/data/knowledge/video', module.verify(archive)['files'])
                import tarfile
                with tarfile.open(archive) as source:
                    restored = Path(directory) / 'restored.db'
                    restored.write_bytes(source.extractfile('data/navigation.db').read())
                with closing(sqlite3.connect(restored)) as check:
                    self.assertEqual(check.execute('SELECT value FROM sample').fetchone()[0], 'committed-in-wal')
                (destination / '.navigation-backup.lock').touch()
                with self.assertRaises(FileExistsError):
                    module.backup(root, destination)
                self.assertTrue(archive.exists())
            with self.assertRaises(ValueError):
                module.backup(root, root / 'data/backups')


if __name__ == '__main__':
    unittest.main()
