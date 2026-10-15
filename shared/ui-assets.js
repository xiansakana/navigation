import { readFileSync } from 'node:fs';

const assets = new Map(['skeleton.css', 'skeleton.js', 'input-guard.js', 'back-to-top.js'].map((name) => [
  name.startsWith('skeleton.') ? `/skeleton/${name}` : `/ui/${name}`,
  { body: readFileSync(new URL(`./ui/${name}`, import.meta.url)), type: name.endsWith('.css') ? 'text/css' : 'text/javascript' }
]));

export function serveUiAsset(req, res) {
  const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
  if (!asset || !['GET', 'HEAD'].includes(req.method)) return false;
  res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : asset.body);
  return true;
}
