import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';
import { attachToRunning, startServer, type MockServer } from './server.js';

export type OidcMockPluginOptions = {
	/** YAML file, relative to the Vite root. Default: `oidc-mock.yaml`. */
	config?: string;
	/** Overrides `port` from the YAML. */
	port?: number;
	/**
	 * Rewrite redirects to the mock into relative ones (default: `true`). This is what makes
	 * `vite --host` work, see the README.
	 */
	rewriteRedirects?: boolean;
	/** Also run in `vite preview` (default: `true`). */
	preview?: boolean;
};

/**
 * One mock per config and port for the whole process. Vite re-creates plugins on every restart
 * (config change, `server.restart()`), but the port stays taken until the old server is closed –
 * reusing it is simpler and keeps the app's session valid across restarts.
 */
const running: Map<string, Promise<MockServer>> = ((globalThis as { __oidcMock?: Map<string, Promise<MockServer>> }).__oidcMock ??=
	new Map());

function acquire(configFile: string, port: number | undefined) {
	const id = `${configFile}#${port ?? ''}`;
	let server = running.get(id);
	if (!server) {
		server = startServer({ config: configFile, port }).catch(async (error: NodeJS.ErrnoException & { port?: number }) => {
			if (error.code !== 'EADDRINUSE') throw error;
			const attached = await attachToRunning({ config: configFile, port });
			if (!attached) {
				throw new Error(
					`Port ${error.port} is taken by something that is not this oidc-mock. ` +
						'Pick another port in the config or with oidcMock({ port }).'
				);
			}
			return attached;
		});
		server.catch(() => running.delete(id));
		running.set(id, server);
	}
	return server;
}

/**
 * Runs the mock provider next to the Vite dev server.
 *
 * The provider listens on its own loopback port (the back channel: discovery, token, JWKS –
 * called by the app's server), and the Vite server serves the same endpoints under `base_path`
 * (the front channel: the login page, called by the browser). Redirects the app sends to the
 * back channel are rewritten to relative URLs, so the browser stays on whatever host it used to
 * reach Vite – `localhost`, a LAN address with `--host`, or a forwarded port.
 */
export function oidcMock(options: OidcMockPluginOptions = {}): Plugin {
	let root = process.cwd();
	let mock: Promise<MockServer> | undefined;

	function install(server: ViteDevServer | PreviewServer) {
		const configFile = resolve(root, options.config ?? 'oidc-mock.yaml');
		const pending = acquire(configFile, options.port);
		mock = pending;
		pending.then(
			(started) => {
				const log = server.config.logger;
				log.info(
					`  ➜  oidc-mock: ${started.discoveryUrl}\n` +
						`               ${started.config().users.length} users from ${configFile}` +
						(started.server
							? ''
							: '\n               port taken by another oidc-mock with this issuer – sharing its back channel')
				);
			},
			(error: Error) => server.config.logger.error(`[oidc-mock] ${error.message}`)
		);
		server.middlewares.use(middleware);
	}

	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		if (!mock) return next();
		mock.then(
			async (started) => {
				if (options.rewriteRedirects !== false) rewriteLocation(res, started);
				if (await started.provider.handle(req as IncomingMessage, res)) return;
				next();
			},
			() => next()
		);
	};

	return {
		name: 'oidc-mock',
		configResolved(config) {
			root = config.root;
		},
		configureServer(server) {
			install(server);
		},
		configurePreviewServer(server) {
			if (options.preview !== false) install(server);
		}
	};
}

/**
 * Turns `Location: <issuer origin>/<base_path>/…` into `/<base_path>/…`, both for
 * `setHeader` and for `writeHead`, which is what SvelteKit, Express and friends use.
 */
function rewriteLocation(res: ServerResponse, mock: MockServer) {
	const issuer = new URL(mock.issuer);
	const prefix = issuer.origin + mock.config().base_path;
	const rewrite = (value: unknown) =>
		typeof value === 'string' && (value === prefix || value.startsWith(prefix + '/') || value.startsWith(prefix + '?'))
			? value.slice(issuer.origin.length)
			: value;

	const setHeader = res.setHeader.bind(res);
	res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'location' ? (rewrite(value) as typeof value) : value);

	const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
	res.writeHead = ((...args: unknown[]) => {
		const headersIndex = typeof args[1] === 'string' ? 2 : 1;
		const headers = args[headersIndex];
		if (Array.isArray(headers)) {
			// Either [[name, value], …] or a flat [name, value, name, value, …].
			if (Array.isArray(headers[0])) {
				args[headersIndex] = headers.map(([name, value]: [string, unknown]) =>
					[name, name.toLowerCase() === 'location' ? rewrite(value) : value]
				);
			} else {
				args[headersIndex] = headers.map((value: unknown, i: number) =>
					i % 2 === 1 && String(headers[i - 1]).toLowerCase() === 'location' ? rewrite(value) : value
				);
			}
		} else if (headers && typeof headers === 'object') {
			args[headersIndex] = Object.fromEntries(
				Object.entries(headers as OutgoingHttpHeaders).map(([name, value]) => [
					name,
					name.toLowerCase() === 'location' ? rewrite(value) : value
				])
			);
		}
		return writeHead(...args);
	}) as typeof res.writeHead;
}

export default oidcMock;
