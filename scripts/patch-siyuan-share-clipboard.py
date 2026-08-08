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
PREVIEW_MARKER = "/* share-preview-copy-http-patch */"

PREVIEW_OLD = """            navigator.clipboard.writeText(text);"""

PREVIEW_NEW = """            var _ta=document.createElement("textarea");_ta.value=text;_ta.style.cssText="position:fixed;top:-1000px;left:-1000px";document.body.appendChild(_ta);_ta.select();try{document.execCommand("copy")}finally{document.body.removeChild(_ta)}"""

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

    patched = False

    if OLD in text:
        text = text.replace(OLD, NEW, 1)
        patched = True
    elif OLD_MIN in text:
        text = text.replace(OLD_MIN, NEW_MIN, 1)
        patched = True
    elif NEW in text or NEW_MIN in text:
        pass
    else:
        print("error: tryCopyToClipboard pattern not found (plugin version changed?)", file=sys.stderr)
        return 1

    if PREVIEW_MARKER in text:
        text = text.replace(PREVIEW_MARKER, "", 1)

    if PREVIEW_OLD in text:
        text = text.replace(PREVIEW_OLD, PREVIEW_NEW, 1)
        patched = True
    elif PREVIEW_MARKER in text or "_ta.style.cssText=\"position:fixed;top:-1000px" in text:
        pass
    else:
        print("warn: preview copy pattern not found (plugin version changed?)", file=sys.stderr)

    if not patched and NEW in text and "_ta.style.cssText=\"position:fixed;top:-1000px" in text:
        print("already patched:", PLUGIN_INDEX)
        return 0

    markers = MARKER
    if PREVIEW_NEW in text and PREVIEW_MARKER not in text:
        markers += PREVIEW_MARKER
    if MARKER not in text:
        text = markers + text

    PLUGIN_INDEX.write_text(text, encoding="utf-8")
    print("patched:", PLUGIN_INDEX)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
