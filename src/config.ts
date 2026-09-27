import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** `3600`, `"90s"`, `"15m"`, `"1h"`, `"30d"` – always resolved to seconds. */
const duration = z.union([
	z.number().int().positive(),
	z
		.string()
		.regex(/^\d+\s*[smhd]$/, 'expected a number of seconds or a string like "15m", "1h", "30d"')
		.transform((value) => {
			const amount = Number.parseInt(value, 10);
			const unit = value.trim().at(-1) as 's' | 'm' | 'h' | 'd';
			return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
		})
]);

const userSchema = z.object({
	/** The `sub` claim. Stable, so the app sees the same account on every login. */
	sub: z.string().min(1),
	/** Button text on the login page. Defaults to `name`, then the email, then `sub`. */
	label: z.string().optional(),
	/** Second line on the button, e.g. what this user is meant to test. */
	description: z.string().optional(),
	/** Everything that ends up in the id token, the access token and userinfo. */
	claims: z.record(z.string(), z.unknown()).default({})
});

const clientSchema = z.object({
	client_id: z.string().min(1),
	/** When set, the token endpoint requires it. Leave it out for public clients. */
	client_secret: z.string().optional(),
	/** Allowed redirect URIs. `*` matches anything, e.g. `https://*:5174/*`. Empty allows all. */
	redirect_uris: z.array(z.string()).default([])
});

const configSchema = z.object({
	/** Where the provider listens. The issuer is built from these unless `issuer` is set. */
	host: z.string().default('127.0.0.1'),
	port: z.number().int().min(0).max(65535).default(8090),
	/** Path prefix of every endpoint. The Vite plugin mounts the login page under the same path. */
	base_path: z
		.string()
		.default('/oidc')
		.transform((path) => '/' + path.replace(/^\/+|\/+$/g, ''))
		.transform((path) => (path === '/' ? '' : path)),
	/** Overrides the issuer, e.g. when the provider sits behind a reverse proxy. */
	issuer: z.url().optional(),
	/** Signing key, created on first start. Relative to this file. */
	key_file: z.string().default('node_modules/.cache/oidc-mock/signing-key.json'),
	/** No `clients` means every `client_id` is accepted without a secret. */
	clients: z.array(clientSchema).default([]),
	tokens: z
		.object({
			access_token_ttl: duration.default(3600),
			id_token_ttl: duration.default(3600),
			refresh_token_ttl: duration.default(30 * 86400)
		})
		.prefault({}),
	/** Show the free-form “custom claims” box on the login page. */
	custom_login: z.boolean().default(true),
	users: z.array(userSchema).default([])
});

export type MockUser = z.infer<typeof userSchema>;
export type MockClient = z.infer<typeof clientSchema>;
export type MockConfig = z.infer<typeof configSchema> & {
	/** Absolute path of the YAML file, if the config came from one. */
	file?: string;
	/** `issuer` with the default filled in. */
	issuer: string;
};

export type MockConfigInput = z.input<typeof configSchema>;

export class ConfigError extends Error {}

export function resolveConfig(input: unknown, file?: string): MockConfig {
	const result = configSchema.safeParse(input ?? {});
	if (!result.success) {
		const where = file ? ` in ${file}` : '';
		throw new ConfigError(`Invalid oidc-mock config${where}:\n${z.prettifyError(result.error)}`);
	}
	const config = result.data;

	const subs = new Set<string>();
	for (const user of config.users) {
		if (subs.has(user.sub)) throw new ConfigError(`Duplicate user sub "${user.sub}"`);
		subs.add(user.sub);
	}

	const issuer = (
		config.issuer ?? `http://${formatHost(config.host)}:${config.port}${config.base_path}`
	).replace(/\/+$/, '');
	const keyFile = resolve(file ? dirname(file) : process.cwd(), config.key_file);
	return { ...config, issuer, key_file: keyFile, file };
}

function formatHost(host: string) {
	if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
	return host.includes(':') ? `[${host}]` : host;
}

export function loadConfigFile(path: string): MockConfig {
	const file = resolve(path);
	const text = readFileSync(file, 'utf8');
	let parsed: unknown;
	try {
		parsed = parse(text);
	} catch (error) {
		throw new ConfigError(`Could not parse ${file}: ${(error as Error).message}`);
	}
	return resolveConfig(parsed, file);
}

/**
 * Returns the current config and re-reads the file whenever it changed, so edits to users and
 * claims apply to the next login without a restart. `host`, `port`, `base_path`, `issuer` and
 * `key_file` stay as they were at start – changing them needs a restart, and a warning says so.
 */
export function watchConfig(initial: MockConfig): () => MockConfig {
	if (!initial.file) return () => initial;
	const file = initial.file;
	let current = initial;
	let lastMtime = statSync(file).mtimeMs;

	return () => {
		let mtime: number;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			return current;
		}
		if (mtime === lastMtime) return current;
		lastMtime = mtime;
		try {
			const next = loadConfigFile(file);
			const fixed = ['host', 'port', 'base_path', 'issuer', 'key_file'] as const;
			const changed = fixed.filter((key) => next[key] !== initial[key]);
			if (changed.length) {
				console.warn(`[oidc-mock] ${changed.join(', ')} changed – restart to apply.`);
			}
			current = { ...next, ...Object.fromEntries(fixed.map((key) => [key, initial[key]])) };
			console.info(`[oidc-mock] Reloaded ${file}`);
		} catch (error) {
			console.error(`[oidc-mock] ${(error as Error).message}\nKeeping the previous config.`);
		}
		return current;
	};
}

export function findClient(config: MockConfig, clientId: string): MockClient | undefined {
	if (!config.clients.length) return { client_id: clientId, redirect_uris: [] };
	return config.clients.find((client) => client.client_id === clientId);
}

export function redirectUriAllowed(client: MockClient, redirectUri: string) {
	if (!client.redirect_uris.length) return true;
	return client.redirect_uris.some((pattern) => {
		const regex = new RegExp(
			'^' + pattern.split('*').map(escapeRegex).join('.*') + '$'
		);
		return regex.test(redirectUri);
	});
}

function escapeRegex(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function userLabel(user: MockUser) {
	const name = user.claims.name ?? [user.claims.given_name, user.claims.family_name].join(' ');
	return (
		user.label ??
		(typeof name === 'string' && name.trim() ? name.trim() : undefined) ??
		(typeof user.claims.email === 'string' ? user.claims.email : undefined) ??
		user.sub
	);
}
