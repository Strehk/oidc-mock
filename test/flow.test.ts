import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { startServer, type MockServer } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'oidc-mock-test-'));
const configFile = join(dir, 'oidc-mock.yaml');
const redirectUri = 'http://app.test/callback';

writeFileSync(
	configFile,
	`
port: 0
tokens:
  access_token_ttl: 5m
clients:
  - client_id: app
    redirect_uris: ['http://app.test/*']
  - client_id: confidential
    client_secret: s3cret
users:
  - sub: admin
    label: Admin
    claims:
      email: admin@example.org
      roles: [{ name: admin }]
  - sub: member
    claims: { email: member@example.org }
`
);

let mock: MockServer;
let config: client.Configuration;

beforeAll(async () => {
	mock = await startServer({ config: configFile });
	config = await client.discovery(new URL(mock.discoveryUrl), 'app', undefined, client.None(), {
		execute: [client.allowInsecureRequests]
	});
});

afterAll(async () => {
	await mock.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Walks through the login page like a browser that clicks `form`. */
async function login(form: Record<string, string>, params: Record<string, string> = {}) {
	const verifier = client.randomPKCECodeVerifier();
	const state = client.randomState();
	const nonce = client.randomNonce();
	const authorizeUrl = client.buildAuthorizationUrl(config, {
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		state,
		nonce,
		...params
	});

	const page = await fetch(authorizeUrl);
	expect(page.status).toBe(200);
	const html = await page.text();
	const hidden = html.match(/name="params" value="([^"]+)"/)![1]!;
	const paramsJson = hidden.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#39;', "'");

	const submit = await fetch(authorizeUrl.origin + authorizeUrl.pathname, {
		method: 'POST',
		body: new URLSearchParams({ params: paramsJson, ...form }),
		redirect: 'manual'
	});
	return { submit, verifier, state, nonce };
}

describe('authorization code flow', () => {
	test('discovery points everything at the issuer', () => {
		const metadata = config.serverMetadata();
		expect(metadata.issuer).toBe(mock.issuer);
		expect(metadata.authorization_endpoint).toBe(`${mock.issuer}/authorize`);
		expect(mock.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oidc$/);
		expect(mock.issuer).not.toContain(':0/');
	});

	test('login page lists the users', async () => {
		const url = client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: 'openid' });
		const html = await (await fetch(url)).text();
		expect(html).toContain('Admin');
		expect(html).toContain('member@example.org');
	});

	test('preset user: tokens, claims, userinfo, refresh, introspection', async () => {
		const { submit, verifier, state, nonce } = await login({ sub: 'admin' });
		expect(submit.status).toBe(302);
		const callback = new URL(submit.headers.get('location')!);
		expect(callback.origin + callback.pathname).toBe(redirectUri);

		const tokens = await client.authorizationCodeGrant(config, callback, {
			pkceCodeVerifier: verifier,
			expectedState: state,
			expectedNonce: nonce
		});
		const idClaims = tokens.claims()!;
		expect(idClaims.sub).toBe('admin');
		expect(idClaims.email).toBe('admin@example.org');
		expect(idClaims.roles).toEqual([{ name: 'admin' }]);
		expect(tokens.expires_in).toBe(300);
		expect(tokens.refresh_token).toBeDefined();

		const userinfo = await client.fetchUserInfo(config, tokens.access_token, 'admin');
		expect(userinfo).toEqual({ sub: 'admin', email: 'admin@example.org', roles: [{ name: 'admin' }] });

		const introspection = await client.tokenIntrospection(config, tokens.access_token);
		expect(introspection.active).toBe(true);
		expect(introspection.roles).toEqual([{ name: 'admin' }]);

		const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
		expect(refreshed.claims()!.sub).toBe('admin');

		// The code is single-use.
		await expect(
			client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state })
		).rejects.toThrow();
	});

	test('custom claims', async () => {
		const { submit, verifier, state, nonce } = await login({
			custom: '1',
			custom_sub: 'someone',
			custom_claims: JSON.stringify({ email: 'x@example.org', iss: 'ignored', roles: { owner: {} } })
		});
		const tokens = await client.authorizationCodeGrant(config, new URL(submit.headers.get('location')!), {
			pkceCodeVerifier: verifier,
			expectedState: state,
			expectedNonce: nonce
		});
		expect(tokens.claims()).toMatchObject({ sub: 'someone', iss: mock.issuer, roles: { owner: {} } });
	});

	test('invalid custom claims show the page again with an error', async () => {
		const { submit } = await login({ custom: '1', custom_sub: 'x', custom_claims: '{nope' });
		expect(submit.status).toBe(400);
		expect(await submit.text()).toContain('no valid JSON');
	});

	test('wrong PKCE verifier is rejected', async () => {
		const { submit, state, nonce } = await login({ sub: 'member' });
		await expect(
			client.authorizationCodeGrant(config, new URL(submit.headers.get('location')!), {
				pkceCodeVerifier: client.randomPKCECodeVerifier(),
				expectedState: state,
				expectedNonce: nonce
			})
		).rejects.toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('code_verifier') });
	});

	test('redirect_uri outside the allowed list gets an error page, not a redirect', async () => {
		const url = client.buildAuthorizationUrl(config, { redirect_uri: 'http://evil.test/cb', scope: 'openid' });
		const res = await fetch(url, { redirect: 'manual' });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('not allowed');
	});

	test('prompt=none redirects with login_required', async () => {
		const url = client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: 'openid', prompt: 'none' });
		const res = await fetch(url, { redirect: 'manual' });
		expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('login_required');
	});

	test('confidential client needs its secret', async () => {
		const attempt = (secret: string) =>
			fetch(`${mock.issuer}/token`, {
				method: 'POST',
				headers: { Authorization: `Basic ${btoa(`confidential:${secret}`)}` },
				body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' })
			});
		const wrong = await attempt('wrong');
		expect(wrong.status).toBe(401);
		expect((await wrong.json()).error).toBe('invalid_client');
		// Right secret gets past client authentication and fails on the bogus token instead.
		expect((await (await attempt('s3cret')).json()).error).toBe('invalid_grant');
	});

	test('end session redirects back with state', async () => {
		const url = client.buildEndSessionUrl(config, {
			post_logout_redirect_uri: 'http://app.test/bye',
			state: 'xyz'
		});
		const res = await fetch(url, { redirect: 'manual' });
		expect(res.headers.get('location')).toBe('http://app.test/bye?state=xyz');
	});
});

describe('config reload', () => {
	test('edited users apply on the next login and refresh', async () => {
		const { submit, verifier, state, nonce } = await login({ sub: 'member' });
		const tokens = await client.authorizationCodeGrant(config, new URL(submit.headers.get('location')!), {
			pkceCodeVerifier: verifier,
			expectedState: state,
			expectedNonce: nonce
		});

		const original = await Bun.file(configFile).text();
		// mtime resolution: make sure the change is seen
		await Bun.sleep(20);
		writeFileSync(configFile, original.replace('member@example.org', 'renamed@example.org'));
		try {
			const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
			expect(refreshed.claims()!.email).toBe('renamed@example.org');
		} finally {
			writeFileSync(configFile, original);
		}
	});
});

describe('impersonation (Logto-style token exchange)', () => {
	const post = (path: string, body: Record<string, string>, auth?: string) =>
		fetch(new URL(path, mock.issuer), {
			method: 'POST',
			headers: auth ? { Authorization: auth } : {},
			body: new URLSearchParams(body)
		});

	async function subjectToken(userId: string) {
		const m2m = await post('/oidc/token', {
			grant_type: 'client_credentials',
			resource: 'https://default.logto.app/api',
			scope: 'all'
		}, `Basic ${btoa('confidential:s3cret')}`);
		expect(m2m.status).toBe(200);
		const { access_token } = await m2m.json();

		const created = await fetch(new URL('/api/subject-tokens', mock.issuer), {
			method: 'POST',
			headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId })
		});
		expect(created.status).toBe(201);
		return ((await created.json()) as { subjectToken: string }).subjectToken;
	}

	const exchange = (subject_token: string, extra: Record<string, string> = {}) =>
		post('/oidc/token', {
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			client_id: 'app',
			subject_token,
			subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			...extra
		});

	test('discovery advertises the grants', () => {
		expect(config.serverMetadata().grant_types_supported).toContain(
			'urn:ietf:params:oauth:grant-type:token-exchange'
		);
	});

	test('subject token for a preset user becomes an access token with its claims', async () => {
		const res = await exchange(await subjectToken('admin'), { resource: 'https://api.app.test' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:access_token');
		const introspection = await client.tokenIntrospection(config, body.access_token);
		expect(introspection).toMatchObject({
			active: true,
			sub: 'admin',
			aud: 'https://api.app.test',
			email: 'admin@example.org',
			roles: [{ name: 'admin' }]
		});
		expect(introspection.act).toBeUndefined();
	});

	test('actor token adds act, subject tokens are single-use', async () => {
		const token = await subjectToken('member');
		const actor = await exchange(await subjectToken('admin'));
		const res = await exchange(token, {
			actor_token: (await actor.json()).access_token,
			actor_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		});
		const introspection = await client.tokenIntrospection(config, (await res.json()).access_token);
		expect(introspection).toMatchObject({ sub: 'member', act: { sub: 'admin' } });

		const again = await exchange(token);
		expect(again.status).toBe(400);
		expect((await again.json()).error_description).toContain('already used');
	});

	test('users outside the YAML get a token with only the sub', async () => {
		const res = await exchange(await subjectToken('from-the-database'));
		const introspection = await client.tokenIntrospection(config, (await res.json()).access_token);
		expect(introspection.sub).toBe('from-the-database');
		expect(introspection.email).toBeUndefined();
	});

	test('subject-tokens needs a bearer token', async () => {
		const res = await fetch(new URL('/api/subject-tokens', mock.issuer), {
			method: 'POST',
			body: JSON.stringify({ userId: 'admin' })
		});
		expect(res.status).toBe(401);
	});

	test('a bogus subject token is rejected', async () => {
		const res = await exchange('nope');
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid_grant');
	});
});
