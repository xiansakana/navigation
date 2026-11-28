#!/usr/bin/env python3
"""Keep SiYuan Share initialization and data refresh within the plugin lifecycle."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_INDEX = ROOT / "siyuan/data/siyuan/data/plugins/siyuan-plugin-share/index.js"
MARKER = "/* navigation: share plugin lifecycle */"

START = '''  onload() {
    this.isUnloading = false;
    setGlobalI18nProvider(this.t.bind(this));
    const bootstrap = async () => {
      await this.clearExportRetryCacheOnStartup();
      await this.loadState();
    };
    bootstrap().catch((err) => {
      console.error(err);
      this.notify(this.t("siyuanShare.message.pluginInitFailed", {error: err.message || err}));
    });
'''

END = '''    this.bindDocTreeLater();
    void this.refreshCurrentDocContext();
  }

  onunload() {'''

REPLACEMENT = '''    this.bindDocTreeLater();
    try {
      await this.clearExportRetryCacheOnStartup();
      if (!this.isUnloading) await this.loadState();
    } catch (err) {
      if (err?.code === 410 && this.isUnloading) return;
      console.error(err);
      this.notify(this.t("siyuanShare.message.pluginInitFailed", {
        error: err?.msg || err?.message || String(err),
      }));
    }
  }

  async onDataChanged() {
    if (!this.isUnloading) await this.loadState();
  }

  onunload() {'''


def patch(text):
    if MARKER in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("unexpected SiYuan Share lifecycle code (plugin version changed?)")
    start = f'''  {MARKER}
  async onload() {{
    this.isUnloading = false;
    setGlobalI18nProvider(this.t.bind(this));
'''
    return text.replace(START, start, 1).replace(END, REPLACEMENT, 1)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else PLUGIN_INDEX
    if not path.exists():
        print("skip: plugin index not found:", path)
        return
    text = path.read_text(encoding="utf-8")
    result = patch(text)
    if result != text:
        path.write_text(result, encoding="utf-8")
    print("SiYuan Share lifecycle patch ready:", path)


if __name__ == "__main__":
    main()
