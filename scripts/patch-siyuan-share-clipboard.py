#!/usr/bin/env python3
"""Patch siyuan-plugin-share clipboard copy for HTTP (non-secure context).

Portal serves SiYuan at http://<host>/notes/ where navigator.clipboard.writeText
fails silently; the plugin still shows「已复制链接」. Add textarea/execCommand fallback.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_INDEX = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else ROOT / "siyuan" / "data" / "siyuan" / "data" / "plugins" / "siyuan-plugin-share" / "index.js"
)
MARKER = "/* share-clipboard-http-patch */"

OLD = """  async tryCopyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }"""

OLD_MIN = "async tryCopyToClipboard(text){try{await navigator.clipboard.writeText(text)}catch{}}"

NEW = """  async tryCopyToClipboard(text) {
    const value = String(text ?? "");
    if (!value) throw new Error("empty clipboard text");
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        /* non-HTTPS: fall back below */
      }
    }
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
    if (!ok) throw new Error("clipboard copy failed");
  }"""

NEW_MIN = (
    'async tryCopyToClipboard(text){const value=String(text??"");if(!value)throw new Error("empty clipboard text");'
    'if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(value);return}catch{}}'
    'const ta=document.createElement("textarea");ta.value=value;ta.setAttribute("readonly","");'
    'ta.style.position="fixed";ta.style.top="-1000px";ta.style.left="-1000px";document.body.appendChild(ta);'
    'ta.select();ta.setSelectionRange(0,value.length);let ok=false;try{ok=document.execCommand("copy")}'
    'finally{document.body.removeChild(ta)}if(!ok)throw new Error("clipboard copy failed")}'
)


def main() -> int:
    if not PLUGIN_INDEX.exists():
        print("skip: plugin index not found:", PLUGIN_INDEX)
        return 0

    text = PLUGIN_INDEX.read_text(encoding="utf-8")
    if MARKER in text:
        text = text.replace(MARKER, "", 1)

    if 'document.execCommand("copy")' in text and "empty clipboard text" in text:
        print("already patched:", PLUGIN_INDEX)
        return 0

    if OLD in text:
        text = text.replace(OLD, NEW, 1)
    elif OLD_MIN in text:
        text = text.replace(OLD_MIN, NEW_MIN, 1)
    elif NEW in text or NEW_MIN in text:
        print("tryCopyToClipboard already patched:", PLUGIN_INDEX)
        return 0
    else:
        print("error: tryCopyToClipboard pattern not found (plugin version changed?)", file=sys.stderr)
        return 1

    if MARKER not in text:
        text = MARKER + text

    PLUGIN_INDEX.write_text(text, encoding="utf-8")
    print("patched:", PLUGIN_INDEX)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
