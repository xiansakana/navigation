export function progressResponse(req, res, preview = false) {
  const stream = req.query.progress === '1';
  const packet = value => `data: ${JSON.stringify(value)}\n\n`;
  return {
    progress(phase, details) {
      if (!stream) return;
      if (res.destroyed) {
        if (preview) throw new Error('预览已取消');
        return;
      }
      if (!res.headersSent) {
        res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
      }
      res.write(packet({ phase, ...details }));
    },
    finish(data, status = 200) {
      if (res.destroyed) return;
      if (res.headersSent) res.end(packet(status < 400 ? { result: data } : { error: data.error }));
      else res.status(status).json(data);
    }
  };
}
