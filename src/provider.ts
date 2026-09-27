import type { IncomingMessage, ServerResponse } from 'node:http';
import { findClient, redirectUriAllowed, type MockClient, type MockConfig } from './config.js';
import type { SigningKey } from './keys.js';
import { loginPage, messagePage } from './pages.js';
import { sign, verify, verifyAny, withoutReserved, type Grant } from './tokens.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export type ProviderOptions = {
	/** Called on every request, so a watched config applies without a restart. */
	config: () => MockConfig;
	key: SigningKey;
};

export type Provider = {
	/** Handles the request if its path is below `base_path` and returns whether it did. */
	handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
	metadata(): Record<string, unknown>;
};

class OAuthError extends Error {
	constructor(
		readonly error: string,
		description: string,
		readonly status = 400
	) {
		super(description);
	}
}

/** Metadata fields that go into the access token but are no user claims. */
const tokenMeta = new Set(['client_id', 'scope', 'auth_time', 'azp', 'nonce', 'sid']);

const codeTtl = 120;

export function createProvider({ config: getConfig, key }: ProviderOptions): Provider {
	/** Codes are single-use. Stateless JWTs otherwise, so only redeemed ones need remembering. */
	const redeemedCodes = new Map<string, number>();

	function metadata() {
		const config = getConfig();
		const { issuer } = config;
		const claims = new Set(['sub']);
		for (const user of config.users) for (const claim of Object.keys(user.claims)) claims.add(claim);
		return {
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			userinfo_endpoint: `${issuer}/userinfo`,
			jwks_uri: `${issuer}/jwks`,
			end_session_endpoint: `${issuer}/end_session`,
			introspection_endpoint: `${issuer}/introspect`,
			revocation_endpoint: `${issuer}/revoke`,
			response_types_supported: ['code'],
			response_modes_supported: ['query'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['RS256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
			code_challenge_methods_supported: ['S256', 'plain'],
			scopes_supported: ['openid', 'profile', 'email', 'phone', 'address', 'offline_access'],
			claims_supported: [...claims],
			authorization_response_iss_parameter_supported: true
		};
	}

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const config = getConfig();
		const url = new URL(req.url ?? '/', 'http://oidc-mock');
		const base = config.base_path;
		if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
		const path = url.pathname.slice(base.length) || '/';

		try {
			if (req.method === 'OPTIONS') {
				cors(res);
				res.writeHead(204).end();
				return true;
			}
			const route = `${req.method} ${path}`;
			switch (route) {
				case 'GET /.well-known/openid-configuration':
				case 'GET /.well-known/oauth-authorization-server':
					return json(res, 200, metadata());
				case 'GET /jwks':
					return json(res, 200, { keys: [key.publicJwk] });
				case 'GET /authorize':
					return authorizeGet(config, url.searchParams, res);
				case 'POST /authorize':
					return await authorizePost(config, await readForm(req), res);
				case 'POST /token':
					return await token(config, req, await readForm(req), res);
				case 'GET /userinfo':
				case 'POST /userinfo':
					return await userinfo(config, req, res);
				case 'POST /introspect':
					return await introspect(config, await readForm(req), res);
				case 'POST /revoke':
					cors(res);
					res.writeHead(200).end();
					return true;
				case 'GET /end_session':
				case 'POST /end_session': {
					const params =
						req.method === 'GET' ? url.searchParams : new URLSearchParams(await readBody(req));
					return endSession(params, res);
				}
				default:
					return json(res, 404, { error: 'not_found', error_description: `${route} is no endpoint` });
			}
		} catch (error) {
			if (error instanceof OAuthError) {
				if (error.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oidc-mock"');
				return json(res, error.status, { error: error.error, error_description: error.message });
			}
			console.error('[oidc-mock]', error);
			return json(res, 500, { error: 'server_error', error_description: String(error) });
		}
	}

	/** Checks client and redirect URI. Without both there is nowhere safe to send an error. */
	function validateAuthorizeRequest(config: MockConfig, params: Record<string, string>) {
		if (!params.client_id) return 'The request has no client_id.';
		const client = findClient(config, params.client_id);
		if (!client) return `Unknown client_id "${params.client_id}". Add it under "clients" in the config.`;
		if (!params.redirect_uri) return 'The request has no redirect_uri.';
		try {
			new URL(params.redirect_uri);
		} catch {
			return `redirect_uri "${params.redirect_uri}" is no absolute URL.`;
		}
		if (!redirectUriAllowed(client, params.redirect_uri)) {
			return `redirect_uri "${params.redirect_uri}" is not allowed for client "${client.client_id}".`;
		}
		return undefined;
	}

	function authorizeGet(config: MockConfig, search: URLSearchParams, res: ServerResponse) {
		const params = Object.fromEntries(search);
		const invalid = validateAuthorizeRequest(config, params);
		if (invalid) return html(res, 400, messagePage('Invalid request', invalid));

		if (params.response_type !== 'code') {
			return redirectWithError(res, config, params, 'unsupported_response_type', 'Only "code" is supported.');
		}
		if (params.prompt?.split(' ').includes('none')) {
			return redirectWithError(res, config, params, 'login_required', 'oidc-mock keeps no sessions.');
		}
		return html(res, 200, loginPage({ config, params }));
	}

	async function authorizePost(config: MockConfig, form: URLSearchParams, res: ServerResponse) {
		let params: Record<string, string>;
		try {
			params = JSON.parse(form.get('params') ?? '');
		} catch {
			return html(res, 400, messagePage('Invalid request', 'The login form lost its parameters.'));
		}
		const invalid = validateAuthorizeRequest(config, params);
		if (invalid) return html(res, 400, messagePage('Invalid request', invalid));

		let sub: string;
		let claims: Record<string, unknown>;
		let preset: boolean;
		if (form.has('custom')) {
			const customSub = form.get('custom_sub')?.trim() ?? '';
			const customClaims = form.get('custom_claims') ?? '';
			const retry = (error: string) =>
				html(res, 400, loginPage({ config, params, error, customSub, customClaims }));
			if (!config.custom_login) return retry('Custom claims are disabled in the config.');
			let parsed: unknown = {};
			if (customClaims.trim()) {
				try {
					parsed = JSON.parse(customClaims);
				} catch (error) {
					return retry(`The claims are no valid JSON: ${(error as Error).message}`);
				}
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return retry('The claims must be a JSON object.');
			}
			claims = parsed as Record<string, unknown>;
			sub = customSub || (typeof claims.sub === 'string' ? claims.sub : '');
			if (!sub) return retry('Enter a sub.');
			preset = false;
		} else {
			const user = config.users.find((candidate) => candidate.sub === form.get('sub'));
			if (!user) {
				return html(res, 400, loginPage({ config, params, error: `Unknown user "${form.get('sub')}".` }));
			}
			({ sub, claims } = user);
			preset = true;
		}

		const grant: Grant = {
			sub,
			claims: withoutReserved(claims),
			preset,
			client_id: params.client_id!,
			scope: params.scope ?? '',
			auth_time: Math.floor(Date.now() / 1000),
			nonce: params.nonce,
			redirect_uri: params.redirect_uri,
			code_challenge: params.code_challenge,
			code_challenge_method: params.code_challenge
				? (params.code_challenge_method ?? 'plain')
				: undefined
		};
		const code = await sign(key, 'code', { grant }, {
			issuer: config.issuer,
			audience: grant.client_id,
			subject: sub,
			ttl: codeTtl
		});

		const target = new URL(params.redirect_uri!);
		target.searchParams.set('code', code);
		if (params.state !== undefined) target.searchParams.set('state', params.state);
		target.searchParams.set('iss', config.issuer);
		return redirect(res, target.toString());
	}

	function redirectWithError(
		res: ServerResponse,
		config: MockConfig,
		params: Record<string, string>,
		error: string,
		description: string
	) {
		const target = new URL(params.redirect_uri!);
		target.searchParams.set('error', error);
		target.searchParams.set('error_description', description);
		if (params.state !== undefined) target.searchParams.set('state', params.state);
		target.searchParams.set('iss', config.issuer);
		return redirect(res, target.toString());
	}

	function authenticateClient(config: MockConfig, req: IncomingMessage, form: URLSearchParams): MockClient {
		let clientId = form.get('client_id') ?? undefined;
		let secret = form.get('client_secret') ?? undefined;
		const header = req.headers.authorization;
		if (header?.startsWith('Basic ')) {
			const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
			const colon = decoded.indexOf(':');
			clientId = decodeURIComponent(decoded.slice(0, colon));
			secret = decodeURIComponent(decoded.slice(colon + 1));
		}
		if (!clientId) throw new OAuthError('invalid_client', 'No client_id given.', 401);
		const client = findClient(config, clientId);
		if (!client) throw new OAuthError('invalid_client', `Unknown client_id "${clientId}".`, 401);
		if (client.client_secret !== undefined && !safeEqual(client.client_secret, secret ?? '')) {
			throw new OAuthError('invalid_client', 'Wrong client_secret.', 401);
		}
		return client;
	}

	async function token(config: MockConfig, req: IncomingMessage, form: URLSearchParams, res: ServerResponse) {
		cors(res);
		const client = authenticateClient(config, req, form);
		const grantType = form.get('grant_type');
		let grant: Grant;

		if (grantType === 'authorization_code') {
			const code = form.get('code') ?? '';
			let payload;
			try {
				payload = await verify(key, 'code', code, config.issuer);
			} catch {
				throw new OAuthError('invalid_grant', 'The code is invalid or expired.');
			}
			grant = payload.grant as Grant;
			if (grant.client_id !== client.client_id) {
				throw new OAuthError('invalid_grant', 'The code was issued to another client.');
			}
			pruneRedeemed();
			if (redeemedCodes.has(payload.jti!)) throw new OAuthError('invalid_grant', 'The code was already used.');
			redeemedCodes.set(payload.jti!, payload.exp!);
			if (grant.redirect_uri !== form.get('redirect_uri')) {
				throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
			}
			if (grant.code_challenge) {
				const verifier = form.get('code_verifier');
				if (!verifier) throw new OAuthError('invalid_grant', 'code_verifier is missing.');
				const expected =
					grant.code_challenge_method === 'S256'
						? createHash('sha256').update(verifier).digest('base64url')
						: verifier;
				if (expected !== grant.code_challenge) {
					throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge.');
				}
			}
		} else if (grantType === 'refresh_token') {
			let payload;
			try {
				payload = await verify(key, 'refresh', form.get('refresh_token') ?? '', config.issuer);
			} catch {
				throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
			}
			grant = payload.grant as Grant;
			if (grant.client_id !== client.client_id) {
				throw new OAuthError('invalid_grant', 'The refresh token was issued to another client.');
			}
			// Edits in the YAML apply on the next refresh, not only on the next login.
			if (grant.preset) {
				const user = config.users.find((candidate) => candidate.sub === grant.sub);
				if (!user) throw new OAuthError('invalid_grant', `User "${grant.sub}" was removed from the config.`);
				grant = { ...grant, claims: withoutReserved(user.claims) };
			}
			grant = { ...grant, nonce: undefined };
		} else {
			throw new OAuthError('unsupported_grant_type', `grant_type "${grantType}" is not supported.`);
		}

		const scopes = grant.scope.split(' ').filter(Boolean);
		const common = { issuer: config.issuer, audience: client.client_id, subject: grant.sub };
		const response: Record<string, unknown> = {
			token_type: 'Bearer',
			expires_in: config.tokens.access_token_ttl,
			scope: grant.scope,
			access_token: await sign(
				key,
				'access',
				{ ...grant.claims, client_id: client.client_id, scope: grant.scope, auth_time: grant.auth_time },
				{ ...common, ttl: config.tokens.access_token_ttl }
			)
		};
		if (scopes.includes('openid')) {
			response.id_token = await sign(
				key,
				'id',
				{ ...grant.claims, azp: client.client_id, auth_time: grant.auth_time, nonce: grant.nonce },
				{ ...common, ttl: config.tokens.id_token_ttl }
			);
		}
		if (scopes.includes('offline_access')) {
			const { redirect_uri, code_challenge, code_challenge_method, ...kept } = grant;
			response.refresh_token = await sign(key, 'refresh', { grant: kept }, {
				...common,
				ttl: config.tokens.refresh_token_ttl
			});
		}
		res.setHeader('Cache-Control', 'no-store');
		return json(res, 200, response);
	}

	async function userinfo(config: MockConfig, req: IncomingMessage, res: ServerResponse) {
		cors(res);
		const header = req.headers.authorization;
		let accessToken = header?.match(/^Bearer\s+(.+)$/i)?.[1];
		if (!accessToken && req.method === 'POST') accessToken = (await readForm(req)).get('access_token') ?? undefined;
		try {
			const payload = await verify(key, 'access', accessToken ?? '', config.issuer);
			const claims = Object.fromEntries(
				Object.entries(withoutReserved(payload)).filter(([claim]) => !tokenMeta.has(claim))
			);
			return json(res, 200, { ...claims, sub: payload.sub });
		} catch {
			res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
			return json(res, 401, { error: 'invalid_token', error_description: 'Missing or invalid access token.' });
		}
	}

	async function introspect(config: MockConfig, form: URLSearchParams, res: ServerResponse) {
		cors(res);
		const result = await verifyAny(key, form.get('token') ?? '', config.issuer);
		if (!result) return json(res, 200, { active: false });
		const { grant, ...payload } = result.payload;
		const refresh = result.kind === 'refresh' ? (grant as Grant) : undefined;
		return json(res, 200, {
			...payload,
			...(refresh ? { client_id: refresh.client_id, scope: refresh.scope } : {}),
			active: true,
			token_type: result.kind === 'refresh' ? 'refresh_token' : 'Bearer'
		});
	}

	function endSession(params: URLSearchParams, res: ServerResponse) {
		const target = params.get('post_logout_redirect_uri');
		if (target) {
			try {
				const url = new URL(target);
				const state = params.get('state');
				if (state !== null) url.searchParams.set('state', state);
				return redirect(res, url.toString());
			} catch {
				return html(res, 400, messagePage('Invalid request', 'post_logout_redirect_uri is no absolute URL.'));
			}
		}
		return html(res, 200, messagePage('Signed out', 'You can close this page.'));
	}

	function pruneRedeemed() {
		const now = Date.now() / 1000;
		for (const [jti, exp] of redeemedCodes) if (exp < now) redeemedCodes.delete(jti);
	}

	return { handle, metadata };
}

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function cors(res: ServerResponse) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res: ServerResponse, status: number, body: unknown) {
	cors(res);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
	return true;
}

function html(res: ServerResponse, status: number, body: string) {
	res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(body);
	return true;
}

function redirect(res: ServerResponse, location: string) {
	res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
	res.end();
	return true;
}

async function readBody(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: IncomingMessage) {
	const body = await readBody(req);
	if (req.headers['content-type']?.includes('application/json')) {
		const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
		return new URLSearchParams(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
	}
	return new URLSearchParams(body);
}
