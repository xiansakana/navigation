function json(data, status) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  if (!env.RELAY_SECRET || request.headers.get('X-OAuth-Relay-Secret') !== env.RELAY_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  let upstream;
  const options = { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) };
  if (url.pathname === '/token' && request.method === 'POST') {
    const body = await request.text();
    if (body.length > 8192) return json({ error: 'request_too_large' }, 413);
    const params = new URLSearchParams(body);
    if (params.get('redirect_uri') !== 'https://saoyu.fun/api/oauth/google/callback'
      || params.get('grant_type') !== 'authorization_code') {
      return json({ error: 'invalid_request' }, 400);
    }
    upstream = 'https://oauth2.googleapis.com/token';
    options.method = 'POST';
    options.body = body;
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (url.pathname === '/userinfo' && request.method === 'GET') {
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'invalid_request' }, 400);
    upstream = 'https://openidconnect.googleapis.com/v1/userinfo';
    options.headers.Authorization = authorization;
  } else {
    return json({ error: 'not_found' }, 404);
  }
  try {
    const response = await fetchImpl(upstream, options);
    const data = await response.json();
    return json(data, response.status);
  } catch {
    return json({ error: 'temporarily_unavailable', error_description: 'Google 登录服务暂时不可用，请稍后重试' }, 502);
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
