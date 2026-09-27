import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { SigningKey } from './keys.js';

/**
 * Authorization codes and refresh tokens are signed JWTs as well. The mock keeps no session state
 * besides a set of redeemed codes, so a restart loses nothing – the key is on disk.
 */
export type TokenKind = 'code' | 'access' | 'id' | 'refresh';

const typ: Record<TokenKind, string> = {
	code: 'oidc-mock-code+jwt',
	access: 'at+jwt',
	id: 'JWT',
	refresh: 'oidc-mock-refresh+jwt'
};

/** What an authorization code and a refresh token carry, so both can be turned into tokens. */
export type Grant = {
	sub: string;
	claims: Record<string, unknown>;
	/** Came from a user in the YAML: re-read the claims from there on refresh. */
	preset: boolean;
	client_id: string;
	scope: string;
	auth_time: number;
	nonce?: string;
	redirect_uri?: string;
	code_challenge?: string;
	code_challenge_method?: string;
};

/** Registered claims of a JWT, which a user's claims must not override. */
const reserved = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti']);

export function withoutReserved(claims: Record<string, unknown>) {
	return Object.fromEntries(Object.entries(claims).filter(([key]) => !reserved.has(key)));
}

export async function sign(
	key: SigningKey,
	kind: TokenKind,
	payload: Record<string, unknown>,
	{ issuer, audience, subject, ttl }: { issuer: string; audience: string; subject: string; ttl: number }
) {
	return new SignJWT(payload as JWTPayload)
		.setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: typ[kind] })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject(subject)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
		.setJti(randomUUID())
		.sign(key.privateKey);
}

export async function verify(key: SigningKey, kind: TokenKind, token: string, issuer: string) {
	const { payload } = await jwtVerify(token, key.publicKey, {
		issuer,
		typ: typ[kind],
		algorithms: ['RS256']
	});
	return payload;
}

/** Tries each kind in turn – for introspection, which does not know what it was handed. */
export async function verifyAny(key: SigningKey, token: string, issuer: string) {
	for (const kind of ['access', 'refresh', 'id'] as const) {
		try {
			return { kind, payload: await verify(key, kind, token, issuer) };
		} catch {
			// next
		}
	}
	return undefined;
}
