#!/usr/bin/env python3
"""Patch siyuan-share-web assets/app.js clipboard for HTTP.

writeClipboardText checks navigator.clipboard presence but writeText rejects on HTTP
without falling through to execCommand. Wrap writeText in try/catch.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTAINER = os.environ.get("SHARE_CONTAINER", "siyuan-share-web")
APP_JS = os.environ.get("SHARE_APP_JS", "/var/www/html/assets/app.js")
MARKER = "/* share-web-clipboard-http-patch */"

OLD = """    const writeClipboardText = async (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const helper = document.createElement("textarea");"""

NEW = """    const writeClipboardText = async (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          /* non-HTTPS: fall through to execCommand */
        }
      }
      const helper = document.createElement("textarea");"""


def read_container_file():
    proc = subprocess.run(
        ["docker", "exec", CONTAINER, "cat", APP_JS],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(f"skip: cannot read {APP_JS} from {CONTAINER}", file=sys.stderr)
        return None
    return proc.stdout


def write_container_file(content: str) -> bool:
    proc = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "tee", APP_JS],
        input=content,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(proc.stderr.strip(), file=sys.stderr)
        return False
    return True


def main() -> int:
    text = read_container_file()
    if text is None:
        return 0

    if MARKER in text:
        text = text.replace(MARKER, "", 1)

    if NEW in text:
        print("already patched:", APP_JS)
        return 0

    if OLD not in text:
        print("error: writeClipboardText pattern not found (image version changed?)", file=sys.stderr)
        return 1

    text = text.replace(OLD, NEW, 1)
    if MARKER not in text:
        text = MARKER + text

    if not write_container_file(text):
        return 1

    print("patched:", CONTAINER + ":" + APP_JS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
