import crypto from 'node:crypto';

// Call only after checking the current session and parent post visibility.
export function imageCacheHeaders(identity) {
  return {
    'Cache-Control': 'private, no-cache, must-revalidate',
    ETag: '"' + crypto.createHash('sha256').update(identity).digest('hex') + '"',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff'
  };
}

export function respondImageNotModified(req, res, headers) {
  if (req.headers.range) return false;
  const match = req.headers['if-none-match'];
  if (typeof match !== 'string' || !match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === headers.ETag)) return false;
  res.writeHead(304, headers); res.end(); return true;
}
