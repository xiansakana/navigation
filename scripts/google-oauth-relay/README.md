# Google OAuth relay

The mainland Portal host cannot reliably reach Google's OAuth endpoints. Deploy
`worker.js` as a Cloudflare Worker with the custom domain `oauth.saoyu.fun`.
Set `RELAY_SECRET` as a Worker **secret**, using a random 32-byte value. The
Worker supports only the Google token and user-info endpoints, requires this
secret, disables redirects and caching, and never logs credentials or responses.

Configure `oauth.google` in Portal's private `config.json` with the Google web
client ID and secret, `redirectUri` set to
`https://saoyu.fun/api/oauth/google/callback`, `relayUrl` set to
`https://oauth.saoyu.fun`, and `relaySecret` matching `RELAY_SECRET`. Enable the
provider only after checking the relay from the production host.

Google Cloud project: `saoyu-navigation`. Consent screen only requests
`openid email profile`. Publish the OAuth audience for public login. New users
retain the Portal's configured default role; Google login does not grant admin.

Keep all credentials out of Git. Updating Worker code must use this checked-in
source; production Portal code follows the repository's normal Git deployment.
Test: `node --test portal/src/google-oauth-network.test.js`.
