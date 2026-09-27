import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as client from 'openid-client';
import { createServer, type ViteDevServer } from 'vite';
import { oidcMock } from '../src/vite.js';

/**
 * Simulates an app behind `vite --host`: its server discovers the mock over loopback, but the
 * browser comes in through another host name. The redirect to the login page must stay on that
 * host, and the page must be served there.
 */
const dir = mkdtempSync(join(tmpdir(), 'oidc-mock-vite-'));
let vite: ViteDevServer;
let appOrigin: string;
let oidc: client.Configuration;

beforeAll(async () => {
	writeFileSync(join(dir, 'oidc-mock.yaml'), 'port: 0\nusers:\n  - sub: admin\n    claims: { email: a@b.c }\n');
	vite = await createServer({
		root: dir,
		logLevel: 'silent',
		appType: 'custom', // like SvelteKit: no SPA fallback in front of the app
		server: { port: 0, host: '127.0.0.1' },
		plugins: [
			oidcMock(),
			{
				// Stands in for the app: sends the browser to the authorization endpoint.
				name: 'fake-app',
				configureServer(server) {
					return () =>
						server.middlewares.use(async (req, res, next) => {
							if (req.url !== '/login') return next();
							oidc ??= await client.discovery(
								new URL(await discoveryUrl()),
								'app',
								undefined,
								client.None(),
								{ execute: [client.allowInsecureRequests] }
							);
							const url = client.buildAuthorizationUrl(oidc, {
								redirect_uri: `http://${req.headers.host}/callback`,
								scope: 'openid'
							});
							res.writeHead(302, { Location: url.toString() }).end();
						});
				}
			}
		]
	});
	await vite.listen();
	appOrigin = vite.resolvedUrls!.local[0]!.replace(/\/$/, '');
});

afterAll(async () => {
	await vite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function discoveryUrl() {
	const running = (globalThis as { __oidcMock?: Map<string, Promise<{ discoveryUrl: string }>> }).__oidcMock!;
	const [, mock] = [...running].find(([id]) => id.includes(basename(dir)))!;
	return (await mock).discoveryUrl;
}

test('the redirect to the login page becomes relative', async () => {
	const res = await fetch(`${appOrigin}/login`, { redirect: 'manual', headers: { Host: '192.168.1.23:5174' } });
	expect(res.status).toBe(302);
	const location = res.headers.get('location')!;
	expect(location).toStartWith('/oidc/authorize?');
	expect(location).toContain(encodeURIComponent('http://192.168.1.23:5174/callback'));

	const page = await fetch(appOrigin + location);
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('a@b.c');
});

test('discovery is also served through vite', async () => {
	const res = await fetch(`${appOrigin}/oidc/.well-known/openid-configuration`);
	expect((await res.json()).issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oidc$/);
});
