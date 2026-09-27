import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	loadConfigFile,
	resolveConfig,
	watchConfig,
	type MockConfig,
	type MockConfigInput
} from './config.js';
import { loadOrCreateKey } from './keys.js';
import { createProvider, type Provider } from './provider.js';

export type StartOptions = {
	/** Path to the YAML file. Watched: edits to users and claims apply without a restart. */
	config?: string;
	/** Inline config instead of a file, e.g. for tests. Ignored when `config` is set. */
	inline?: MockConfigInput;
	/** Overrides for the values from the file. */
	host?: string;
	port?: number;
};

export type MockServer = {
	/** Issuer URL – the part before `/.well-known/openid-configuration`. */
	issuer: string;
	/** The discovery URL, what an OIDC client wants as “authority”. */
	discoveryUrl: string;
	config: () => MockConfig;
	provider: Provider;
	server: Server;
	close(): Promise<void>;
};

export function loadInitialConfig(options: StartOptions): MockConfig {
	const config = options.config ? loadConfigFile(options.config) : resolveConfig(options.inline ?? {});
	if (options.host === undefined && options.port === undefined) return config;
	return withAddress(config, options.host ?? config.host, options.port ?? config.port);
}

/** Re-resolves the config for another address, so the default issuer follows it. */
function withAddress(config: MockConfig, host: string, port: number): MockConfig {
	const { file, key_file, issuer, ...rest } = config;
	const explicitIssuer = issuer !== resolveConfig({ ...rest, issuer: undefined }).issuer;
	return {
		...resolveConfig({ ...rest, host, port, issuer: explicitIssuer ? issuer : undefined }, file),
		key_file
	};
}

export async function startServer(options: StartOptions = {}): Promise<MockServer> {
	let initial = loadInitialConfig(options);
	let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) =>
		res.writeHead(503).end();

	const server = createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(initial.port, initial.host, () => resolve());
	});

	// Port 0 picks a free port; the issuer has to name the one we actually got.
	if (initial.port === 0) {
		initial = withAddress(initial, initial.host, (server.address() as AddressInfo).port);
	}

	const config = watchConfig(initial);
	const provider = createProvider({ config, key: await loadOrCreateKey(initial.key_file) });
	handler = (req, res) => {
		provider.handle(req, res).then((handled) => {
			if (handled) return;
			res.writeHead(302, { Location: `${config().base_path}/.well-known/openid-configuration` });
			res.end();
		});
	};

	return {
		issuer: initial.issuer,
		discoveryUrl: `${initial.issuer}/.well-known/openid-configuration`,
		config,
		provider,
		server,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	};
}
