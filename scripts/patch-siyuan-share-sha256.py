#!/usr/bin/env python3
"""Patch siyuan-plugin-share to use real SHA-256 on HTTP (non-secure context).

Without crypto.subtle the plugin falls back to fallbackHashBytes(), which is NOT
SHA-256. Share server validates uploads with hash_file('sha256', ...), causing
「Document hash mismatch」on /api/v1/shares/upload/complete.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_INDEX = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else ROOT / "siyuan" / "data" / "siyuan" / "data" / "plugins" / "siyuan-plugin-share" / "index.js"
)
MARKER = "/* share-sha256-http-patch */"

SHA256_FN = r"""
function sha256HexBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = data.length * 8;
  const padLen = ((data.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  padded[padLen - 4] = (bitLen >>> 24) & 0xff;
  padded[padLen - 3] = (bitLen >>> 16) & 0xff;
  padded[padLen - 2] = (bitLen >>> 8) & 0xff;
  padded[padLen - 1] = bitLen & 0xff;
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4;
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}
""".strip()

OLD_TEXT_FALLBACK = "  return fallbackHashBytes(encodeUtf8Bytes(source));"
NEW_TEXT_FALLBACK = "  return sha256HexBytes(encodeUtf8Bytes(source));"

OLD_BLOB_FALLBACK = "    return fallbackHashBytes(new Uint8Array(buf));"
NEW_BLOB_FALLBACK = "    return sha256HexBytes(new Uint8Array(buf));"


def main() -> int:
    if not PLUGIN_INDEX.exists():
        print("skip: plugin index not found:", PLUGIN_INDEX)
        return 0

    text = PLUGIN_INDEX.read_text(encoding="utf-8")
    if MARKER in text:
        text = text.replace(MARKER, "", 1)

    if "function sha256HexBytes(bytes)" in text:
        print("sha256HexBytes already present:", PLUGIN_INDEX)
        return 0

    anchor = "function fallbackHashBytes(bytes) {"
    if anchor not in text:
        print("error: fallbackHashBytes anchor not found", file=sys.stderr)
        return 1

    if OLD_TEXT_FALLBACK not in text or OLD_BLOB_FALLBACK not in text:
        print("error: hash fallback call sites not found (plugin version changed?)", file=sys.stderr)
        return 1

    text = text.replace(anchor, SHA256_FN + "\n\n" + anchor, 1)
    text = text.replace(OLD_TEXT_FALLBACK, NEW_TEXT_FALLBACK, 1)
    text = text.replace(OLD_BLOB_FALLBACK, NEW_BLOB_FALLBACK, 1)

    if MARKER not in text:
        text = MARKER + text

    PLUGIN_INDEX.write_text(text, encoding="utf-8")
    print("patched:", PLUGIN_INDEX)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
