import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export function requirePortfolioUserId(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('股票数据需要明确的用户身份');
  return userId;
}
export const currentPortfolioUserId = () => context.getStore();
export const runWithPortfolioUser = (userId, operation) => context.run(requirePortfolioUserId(userId), operation);
export function portfolioCliUserId(argv = process.argv) {
  const index = argv.indexOf('--user-id');
  if (index < 0) throw new Error('必须显式指定 --user-id');
  return requirePortfolioUserId(argv[index + 1]);
}

// Portal strips client-supplied identity headers and injects the authenticated ID.
// Services must remain loopback-only; never accept a body/query userId as identity.
export function portfolioIdentityMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
  const userId = req.headers['x-portal-user-id'];
  try { requirePortfolioUserId(userId); } catch {
    return res.status(401).json({ error: '请通过导航门户登录后访问股票数据' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return runWithPortfolioUser(userId, next);
}
