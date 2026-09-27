#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError } from './config.js';
import { startServer } from './server.js';

const usage = `Usage:
  oidc-mock [--config oidc-mock.yaml] [--port 8090] [--host 127.0.0.1]
  oidc-mock init [file]      write an example config

Options:
  -c, --config   YAML file (default: oidc-mock.yaml)
  -p, --port     overrides "port" from the config
  -H, --host     overrides "host" from the config
  -h, --help     show this help`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: 'string', short: 'c', default: 'oidc-mock.yaml' },
		port: { type: 'string', short: 'p' },
		host: { type: 'string', short: 'H' },
		help: { type: 'boolean', short: 'h' }
	}
});

if (values.help) {
	console.log(usage);
	process.exit(0);
}

if (positionals[0] === 'init') {
	const target = resolve(positionals[1] ?? values.config!);
	if (existsSync(target)) {
		console.error(`${target} already exists.`);
		process.exit(1);
	}
	const example = resolve(dirname(fileURLToPath(import.meta.url)), '../examples/oidc-mock.yaml');
	copyFileSync(example, target);
	console.log(`Wrote ${target}`);
	process.exit(0);
}

if (positionals.length) {
	console.error(`Unknown command "${positionals[0]}".\n\n${usage}`);
	process.exit(1);
}

if (!existsSync(values.config!)) {
	console.error(`${resolve(values.config!)} not found. Create one with: oidc-mock init`);
	process.exit(1);
}

try {
	const mock = await startServer({
		config: values.config,
		port: values.port === undefined ? undefined : Number(values.port),
		host: values.host
	});
	const users = mock.config().users.length;
	console.log(`oidc-mock listening – ${users} user${users === 1 ? '' : 's'} from ${resolve(values.config!)}`);
	console.log(`  issuer:    ${mock.issuer}`);
	console.log(`  discovery: ${mock.discoveryUrl}`);
	const stop = () => mock.close().then(() => process.exit(0));
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
} catch (error) {
	const code = (error as NodeJS.ErrnoException).code;
	if (error instanceof ConfigError) console.error(error.message);
	else if (code === 'EADDRINUSE' || code === 'EACCES') {
		const { address, port } = error as NodeJS.ErrnoException & { address: string; port: number };
		console.error(`Cannot listen on ${address}:${port} (${code}). Pick another port with --port or in the config.`);
	} else console.error(error);
	process.exit(1);
}
