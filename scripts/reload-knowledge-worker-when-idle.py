"""Refresh the ECS worker after its active lease finishes; never interrupt ASR."""
import argparse
import hashlib
import json
import pathlib
import socket
import sqlite3
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--config', default='/etc/knowledge-worker/config.json')
parser.add_argument('--database', default=str(pathlib.Path(__file__).resolve().parent.parent / 'data/navigation.db'))
parser.add_argument('--wait-and-restart', action='store_true')
args = parser.parse_args()
config_file = pathlib.Path(args.config).resolve()
config = json.loads(config_file.read_text())
token_hash = hashlib.sha256(config['token'].encode()).hexdigest()
with sqlite3.connect(args.database) as db:
    owner = db.execute('SELECT user_id FROM knowledge_workers WHERE token_hash=?', (token_hash,)).fetchone()
    device = db.execute('SELECT id,user_id FROM knowledge_worker_devices WHERE token_hash=? AND revoked_at IS NULL', (token_hash,)).fetchone()
    if device:
        owner = (device[1],)
    if not owner:
        raise RuntimeError('Worker account verification failed; refusing restart')
    identity = hashlib.sha256((socket.gethostname() + ':' + str(config_file)).encode()).hexdigest()[:32]
    legacy = 'legacy-' + hashlib.sha256(config.get('label', '').encode()).hexdigest()[:24]
    own_ids = {identity, legacy, '', device[0] if device else identity}
    while True:
        active = db.execute("SELECT worker_id FROM knowledge_documents WHERE user_id=? AND status='processing'", (owner[0],)).fetchall()
        busy = any(row[0] in own_ids for row in active)
        if not args.wait_and_restart:
            print('ECS_WORKER_BUSY' if busy else 'ECS_WORKER_IDLE', flush=True)
            break
        if not busy:
            subprocess.check_call(['systemctl', 'restart', 'knowledge-worker'])
            print('ECS_WORKER_RELOADED_WITHOUT_INTERRUPTING_ACTIVE_LEASE', flush=True)
            break
        time.sleep(10)
