#!/usr/bin/env python3
"""Ensure portal config enables anonymous guest access."""
import json
from pathlib import Path

p = Path("/opt/navigation/portal/config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))
auth = cfg.setdefault("auth", {})
auth["anonymousGuest"] = True
auth["guestUsername"] = auth.get("guestUsername") or "guest"
p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("anonymousGuest enabled, guestUsername:", auth["guestUsername"])
