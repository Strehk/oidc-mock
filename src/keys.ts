import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	importJWK,
	type CryptoKey,
	type JWK
} from 'jose';

export type SigningKey = {
	kid: string;
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	publicJwk: JWK;
};

const alg = 'RS256';

/**
 * Loads the signing key from `file`, or creates and stores one. Keeping it across restarts means
 * the sessions of the app survive a restart of the mock – a fresh key would invalidate every
 * token the app still holds.
 */
export async function loadOrCreateKey(file: string): Promise<SigningKey> {
	let privateJwk: JWK | undefined;
	try {
		privateJwk = JSON.parse(readFileSync(file, 'utf8')) as JWK;
	} catch {
		const { privateKey } = await generateKeyPair(alg, { extractable: true });
		privateJwk = await exportJWK(privateKey);
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(privateJwk), { mode: 0o600 });
		} catch (error) {
			console.warn(
				`[oidc-mock] Could not store the signing key in ${file} (${(error as Error).message}). ` +
					'Tokens will not survive a restart.'
			);
		}
	}

	const { d, p, q, dp, dq, qi, ...publicPart } = privateJwk;
	const kid = await calculateJwkThumbprint(publicPart);
	const publicJwk: JWK = { ...publicPart, kid, alg, use: 'sig' };
	return {
		kid,
		privateKey: (await importJWK({ ...privateJwk, alg }, alg)) as CryptoKey,
		publicKey: (await importJWK(publicJwk, alg)) as CryptoKey,
		publicJwk
	};
}
