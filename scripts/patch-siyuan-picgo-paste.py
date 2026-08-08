#!/usr/bin/env python3
"""Patch siyuan-plugin-picgo 3.0.3 paste insertBlock for phantom block IDs.

When the cursor sits in a DOM-only block (not yet in kernel blocktree), paste
upload succeeds but insertBlock fails with "block not found". This patch:
1. Restricts findCurrentBlockId to real Node* blocks
2. Validates previousID via checkBlocksExist before insertBlock
3. Falls back to appendBlock when no valid anchor exists
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_INDEX = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else ROOT / "siyuan" / "data" / "siyuan" / "data" / "plugins" / "siyuan-plugin-picgo" / "index.js"
)
MARKER = "/* picgo-paste-anchor-patch */"

OLD_FIND = (
    "findCurrentBlockId(){const i=window.getSelection?.();if(!i||i.rangeCount===0)return\"\";"
    "let n=i.getRangeAt(0).startContainer;for(;n;){if(n.nodeType===Node.ELEMENT_NODE){"
    "const t=n.getAttribute(\"data-node-id\");if(t)return t}n=n.parentNode}return\"\"}"
)

NEW_FIND = (
    "findCurrentBlockId(i){const n=i?.wysiwyg?.element,t=window.getSelection?.();"
    "if(!t||t.rangeCount===0)return\"\";let a=t.getRangeAt(0).startContainer;for(;a;){"
    "if(n&&a===n)break;if(a.nodeType===Node.ELEMENT_NODE){const u=a.getAttribute(\"data-node-id\"),"
    "o=a.getAttribute(\"data-type\");if(u&&o?.startsWith(\"Node\"))return u}a=a.parentNode}return\"\"}"
)

# Fix a broken intermediate patch that used n=n.parentNode in the loop.
BROKEN_FIND = (
    "findCurrentBlockId(i){const n=i?.wysiwyg?.element,t=window.getSelection?.();"
    "if(!t||t.rangeCount===0)return\"\";let a=t.getRangeAt(0).startContainer;for(;a;){"
    "if(n&&a===n)break;if(a.nodeType===Node.ELEMENT_NODE){const u=a.getAttribute(\"data-node-id\"),"
    "o=a.getAttribute(\"data-type\");if(u&&o?.startsWith(\"Node\"))return u}n=n.parentNode}return\"\"}"
)

OLD_TAKEOVER_FIND = "targetBlockId:this.findCurrentBlockId()||t.pageId"
NEW_TAKEOVER_FIND = "targetBlockId:this.findCurrentBlockId(t.detail?.protyle)||t.pageId"

OLD_DEFER_FIND = "targetBlockId:this.findCurrentBlockId()||i.pageId"
NEW_DEFER_FIND = "targetBlockId:this.findCurrentBlockId(i.detail?.protyle)||i.pageId"

OLD_INSERT = (
    "async insertBlock(i,n){if(typeof this.siyuanApi.insertBlock==\"function\")"
    "return await this.siyuanApi.insertBlock(i,\"markdown\",{previousID:n.targetBlockId,parentID:n.pageId});"
    "if(typeof this.siyuanApi.siyuanRequest==\"function\")"
    "return await this.siyuanApi.siyuanRequest(\"/api/block/insertBlock\","
    "{dataType:\"markdown\",data:i,previousID:n.targetBlockId,parentID:n.pageId,nextID:\"\"});"
    "throw new Error(\"当前 Siyuan API 适配器不支持 insertBlock\")}"
)

NEW_INSERT = (
    "async insertBlock(i,n){const t=await this.resolvePasteAnchor(n);"
    "if(typeof this.siyuanApi.insertBlock==\"function\"){"
    "if(t.previousID)return await this.siyuanApi.insertBlock(i,\"markdown\",{previousID:t.previousID,parentID:n.pageId});"
    "return await this.siyuanApi.insertBlock(i,\"markdown\",{parentID:n.pageId})}"
    "if(typeof this.siyuanApi.siyuanRequest==\"function\"){"
    "if(t.previousID)return await this.siyuanApi.siyuanRequest(\"/api/block/insertBlock\","
    "{dataType:\"markdown\",data:i,previousID:t.previousID,parentID:n.pageId,nextID:\"\"});"
    "return await this.siyuanApi.siyuanRequest(\"/api/block/appendBlock\","
    "{dataType:\"markdown\",data:i,parentID:n.pageId})}"
    "throw new Error(\"当前 Siyuan API 适配器不支持 insertBlock\")}"
    "async resolvePasteAnchor(i){let n=i.targetBlockId;if(!n||n===i.pageId)return{previousID:\"\"};"
    "try{if(typeof this.siyuanApi.siyuanRequest==\"function\"){"
    "const t=await this.siyuanApi.siyuanRequest(\"/api/block/checkBlocksExist\",{ids:[n]});"
    "if(t?.data?.[n]===true)return{previousID:n}}}catch(t){this.logger?.warn?.(\"picgo paste anchor check failed\",t)}"
    "let t=document.querySelector('[data-node-id=\"'+n+'\"]');for(;t;){const a=t.getAttribute(\"data-node-id\");"
    "if(a&&a!==i.pageId)try{if(typeof this.siyuanApi.siyuanRequest==\"function\"){"
    "const u=await this.siyuanApi.siyuanRequest(\"/api/block/checkBlocksExist\",{ids:[a]});"
    "if(u?.data?.[a]===true)return{previousID:a}}}catch(u){this.logger?.warn?.(\"picgo paste anchor walk failed\",u)}"
    "let u=t.previousElementSibling;for(;u&&!u.getAttribute(\"data-node-id\");)u=u.previousElementSibling;"
    "if(u){t=u;continue}const o=t.parentElement?.closest?.(\"[data-node-id]\");t=o&&o!==t?o:null}"
    "return{previousID:\"\"}}"
)


def main() -> int:
    if not PLUGIN_INDEX.exists():
        print("skip: plugin index not found:", PLUGIN_INDEX)
        return 0

    text = PLUGIN_INDEX.read_text(encoding="utf-8")
    had_marker = MARKER in text
    if had_marker:
        text = text.replace(MARKER, "", 1)

    if BROKEN_FIND in text:
        text = text.replace(BROKEN_FIND, NEW_FIND, 1)
    elif OLD_FIND in text:
        text = text.replace(OLD_FIND, NEW_FIND, 1)
    elif NEW_FIND in text:
        print("findCurrentBlockId already correct:", PLUGIN_INDEX)
    else:
        print("error: findCurrentBlockId pattern not found (plugin version changed?)", file=sys.stderr)
        return 1

    if OLD_INSERT not in text:
        if "resolvePasteAnchor" in text:
            print("insertBlock already patched:", PLUGIN_INDEX)
        else:
            print("error: insertBlock pattern not found (plugin version changed?)", file=sys.stderr)
            return 1
    else:
        text = text.replace(OLD_TAKEOVER_FIND, NEW_TAKEOVER_FIND, 1)
        text = text.replace(OLD_DEFER_FIND, NEW_DEFER_FIND, 1)
        text = text.replace(OLD_INSERT, NEW_INSERT, 1)

    if MARKER not in text:
        text = MARKER + text

    PLUGIN_INDEX.write_text(text, encoding="utf-8")
    print("patched:", PLUGIN_INDEX)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
