import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { createServer, type ViteDevServer } from 'vite';
import { startServer, type MockServer } from '../src/index.js';
import { oidcMock } from '../src/vite.js';

/**
 * Two dev servers in one checkout: the first owns the back channel port, the second finds it
 * taken and serves only the login page. A code issued by the second must be redeemable at the
 * first – which works because both sign with the same key file.
 */
const dir = mkdtempSync(join(tmpdir(), 'oidc-mock-shared-'));
let first: MockServer;
let second: ViteDevServer;
let secondOrigin: string;

function freePort() {
	return new Promise<number>((resolve) => {
		const server = createNetServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

beforeAll(async () => {
	const port = await freePort();
	const yaml = (label: string) =>
		`port: ${port}\nkey_file: ${join(dir, 'key.json')}\nusers:\n  - sub: admin\n    label: ${label}\n    claims: { email: a@b.c }\n`;
	writeFileSync(join(dir, 'first.yaml'), yaml('First'));
	writeFileSync(join(dir, 'second.yaml'), yaml('Second'));

	first = await startServer({ config: join(dir, 'first.yaml') });
	second = await createServer({
		root: dir,
		logLevel: 'silent',
		appType: 'custom',
		server: { port: 0, host: '127.0.0.1' },
		plugins: [oidcMock({ config: 'second.yaml' })]
	});
	await second.listen();
	secondOrigin = second.resolvedUrls!.local[0]!.replace(/\/$/, '');
});

afterAll(async () => {
	await second.close();
	await first.close();
	rmSync(dir, { recursive: true, force: true });
});

test('a second dev server shares the back channel of the first', async () => {
	const oidc = await client.discovery(new URL(first.discoveryUrl), 'app', undefined, client.None(), {
		execute: [client.allowInsecureRequests]
	});
	const verifier = client.randomPKCECodeVerifier();
	const authorize = client.buildAuthorizationUrl(oidc, {
		redirect_uri: 'http://app.test/cb',
		scope: 'openid',
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		state: 's'
	});

	// The browser gets the login page from the second server …
	const pageUrl = `${secondOrigin}${authorize.pathname}${authorize.search}`;
	const html = await (await fetch(pageUrl)).text();
	expect(html).toContain('Second');
	const params = html
		.match(/name="params" value="([^"]+)"/)![1]!
		.replaceAll('&quot;', '"')
		.replaceAll('&amp;', '&');
	const submit = await fetch(`${secondOrigin}${authorize.pathname}`, {
		method: 'POST',
		body: new URLSearchParams({ params, sub: 'admin' }),
		redirect: 'manual'
	});

	// … and the app redeems the code at the first.
	const tokens = await client.authorizationCodeGrant(oidc, new URL(submit.headers.get('location')!), {
		pkceCodeVerifier: verifier,
		expectedState: 's'
	});
	expect(tokens.claims()!.email).toBe('a@b.c');
});
