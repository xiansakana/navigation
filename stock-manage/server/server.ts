// ABOUTME: Express server with Vite integration
// ABOUTME: Handles API routes and serves frontend in dev/prod modes

import 'dotenv/config';
import { createServer, type Server } from 'http';
import express from 'express';
import { setupVite } from './vite';
import stocksRouter from './routes/stocks';
import { createPortfolioRouter } from './routes/portfolio';
import { loadConfig, resolveDataFile } from './config';
import { DataStore } from './storage';

const isDev = process.env.COZE_PROJECT_ENV !== 'PROD' && process.env.NODE_ENV !== 'production';
const config = loadConfig();
const port = parseInt(process.env.PORT || String(config.server.port), 10);
const hostname = process.env.HOSTNAME || config.server.host;
const app = express();
const dataStore = new DataStore(resolveDataFile(config));

if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

const server = createServer(app);

async function startServer(): Promise<Server> {
  if (isDev) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(`${req.method} ${req.url} - ${ms}ms`);
      });
      next();
    });
  }

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      env: isDev ? 'DEV' : 'PROD',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', stocksRouter);
  app.use('/api', createPortfolioRouter(dataStore));

  await setupVite(app);

  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    console.error('Server error:', err);
    const status = 'status' in err ? (err as { status?: number }).status || 500 : 500;
    if (res && typeof res.status === 'function') {
      res.status(status).json({
        error: err.message || 'Internal server error',
      });
    }
  });

  server.once('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  server.listen(port, hostname, () => {
    console.log(`\n✨ Stock manage at http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`);
    console.log(`💾 Data file: ${resolveDataFile(config)}`);
    console.log(`📝 Environment: ${isDev ? 'development' : 'production'}\n`);
  });

  return server;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
