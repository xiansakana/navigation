#!/usr/bin/env python3
import json
import sys
from pathlib import Path

p = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/navigation/portal/config.json')
cfg = json.loads(p.read_text(encoding='utf-8'))
cfg.setdefault('server', {})
cfg['server']['host'] = '0.0.0.0'
cfg['server']['port'] = 80
p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('server ->', cfg['server'])
