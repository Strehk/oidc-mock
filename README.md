# oidc-mock

An OpenID Connect provider for local development. Users and their claims live in one YAML file,
a login page lets you pick one with a click, and a Vite plugin runs it inside your dev server – so
logging in keeps working with `vite --host`, on your phone, or through a forwarded port.

**Not for production.** Anyone who can reach it can sign in as anyone.

## Quick start

```sh
npm i -D oidc-mock
npx oidc-mock init          # writes oidc-mock.yaml
```

### As a Vite plugin

```ts
// vite.config.ts
import { oidcMock } from 'oidc-mock/vite';

export default defineConfig({
	plugins: [oidcMock(), sveltekit()]
});
```

Point your app at the back channel printed on start:

```sh
OIDC_AUTHORITY="http://127.0.0.1:8090/oidc/.well-known/openid-configuration"
```

### Standalone

```sh
npx oidc-mock --config oidc-mock.yaml
```

Same endpoints, no rewriting (see below) – the browser has to reach `host:port` directly.

## Configuration

```yaml
host: 127.0.0.1      # back channel address; the issuer is http://<host>:<port><base_path>
port: 8090
base_path: /oidc

# clients:           # leave out to accept any client_id without a secret
#   - client_id: my-app
#     client_secret: dev-secret
#     redirect_uris: ['https://*:5173/*']

tokens:
  access_token_ttl: 1h
  id_token_ttl: 1h
  refresh_token_ttl: 30d

custom_login: true   # free-form JSON claims box on the login page

users:
  - sub: admin
    label: Admin
    description: Every permission
    claims:
      email: admin@example.org
      given_name: Ada
      family_name: Admin
      roles: [admin]
```

- **Claims** go unchanged into the id token, the access token and userinfo – any JSON shape, so
  `roles: [{ name: admin }]` (Logto) or `urn:zitadel:iam:org:project:roles: {…}` work alike.
- **Edits apply live.** Users, clients and token lifetimes are re-read on change: a new login – and
  even a token refresh – picks up the new claims. `host`, `port`, `base_path`, `issuer` and
  `key_file` need a restart.
- **Custom login.** The ✎ next to a user copies their claims into the free-form box, so you can
  sign in with a variation without touching the file.
- The signing key is stored in `node_modules/.cache/oidc-mock/` (`key_file`), so sessions in your
  app survive restarts of the mock.

## How `vite --host` works

An OIDC client discovers the provider once, server-side, and from then on sends the browser to
the `authorization_endpoint` from that discovery – `http://127.0.0.1:8090/oidc/authorize`. A phone
on the LAN cannot reach `127.0.0.1` of your laptop, and a mock in Docker is often not reachable at
all.

The plugin therefore splits the provider in two:

- **Back channel** – its own loopback port. Discovery, token, JWKS, userinfo: everything the app's
  *server* calls. Plain HTTP, so it also works when Vite serves HTTPS with a self-signed
  certificate.
- **Front channel** – the same endpoints under `base_path` on the Vite server itself. The login
  page and end-session: everything the *browser* calls.

Any redirect the app sends to `http://127.0.0.1:8090/oidc/…` is rewritten to the relative
`/oidc/…`, so the browser stays on whatever host it used to reach Vite. Your app code stays
unchanged; its `redirect_uri` is built from the request host anyway.

## Endpoints

All below `<issuer>`:

| Path | |
| --- | --- |
| `/.well-known/openid-configuration` | discovery |
| `/jwks` | public key (RS256) |
| `/authorize` | login page; `response_type=code`, PKCE (`S256`, `plain`), `state`, `nonce`; `prompt=none` answers `login_required` |
| `/token` | `authorization_code`, `refresh_token` (issued with scope `offline_access`); `client_secret_basic`, `client_secret_post`, `none` |
| `/userinfo` | claims of the access token's user |
| `/introspect` | access, refresh and id tokens |
| `/revoke` | accepts and ignores |
| `/end_session` | redirects to `post_logout_redirect_uri` with `state` |

## Programmatic use

```ts
import { startServer } from 'oidc-mock';

const mock = await startServer({ inline: { port: 0, users: [{ sub: 'a', claims: { email: 'a@b.c' } }] } });
mock.discoveryUrl; // http://127.0.0.1:54321/oidc/.well-known/openid-configuration
await mock.close();
```

## Development

```sh
bun install
bun test        # end-to-end with openid-client, plus the Vite plugin behind a foreign Host
bun run dev     # CLI with examples/oidc-mock.yaml
bun run build
```
