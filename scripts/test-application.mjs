import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (Number(process.versions.node.split('.')[0]) < 24)
	throw new Error('Application integration requires Node.js 24 or newer');

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const databasePort = process.env.FD_APPLICATION_TEST_DATABASE_PORT;
const databaseCa = process.env.FD_APPLICATION_TEST_DATABASE_CA;
if (!/^\d+$/.test(databasePort ?? '') || !databaseCa)
	throw new Error(
		'Run through pnpm test:application to create an isolated TLS PostgreSQL cluster',
	);

const temporary = await mkdtemp(join(tmpdir(), 'official-application-'));
const app = join(temporary, 'app');
// No deployment settings or GitHub/npm credentials enter module execution.
const environment = Object.fromEntries(
	['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'PNPM_HOME']
		.filter((k) => process.env[k])
		.map((k) => [k, process.env[k]]),
);
Object.assign(environment, {
	CI: 'true',
	// This disposable workspace gains packages during installation/composition.
	// The registry repository itself is installed with --frozen-lockfile in CI.
	PNPM_CONFIG_FROZEN_LOCKFILE: 'false',
	FD_DATABASE_ADAPTER: 'pglite',
	FD_DATABASE_PGLITE_DIRECTORY: join(temporary, 'database'),
});
for (const key of [
	'FD_AGENT_CREDENTIAL_KEY',
	'FD_AGENT_RUN_GRANT_KEY',
	'FD_AUTH_MFA_KEY',
	'FD_AUTOMATIONS_CREDENTIAL_KEY',
	'FD_WORKFLOWS_PAYLOAD_KEY',
	'FD_WORKFLOWS_CURSOR_KEY',
]) {
	environment[key] = randomBytes(32).toString(
		key === 'FD_AUTH_MFA_KEY' ? 'hex' : 'base64',
	);
}
const productionEnvironment = {
	...environment,
	NODE_ENV: 'production',
	FD_DATABASE_ADAPTER: 'postgresql',
	FD_DATABASE_URL: `postgres://coreloom_runtime@127.0.0.1:${databasePort}/registry_application`,
	FD_DATABASE_MIGRATOR_URL: `postgres://coreloom_migrator@127.0.0.1:${databasePort}/registry_application`,
	FD_DATABASE_BACKGROUND_URL: `postgres://coreloom_background@127.0.0.1:${databasePort}/registry_application`,
	FD_DATABASE_TLS: 'verify-full',
	FD_DATABASE_TLS_CA_FILE: databaseCa,
};
function run(command, args, cwd = app, env = environment) {
	console.log(`> ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, {
		cwd,
		env,
		stdio: 'inherit',
		timeout: 600_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`Command failed (${result.status}): ${command} ${args.join(' ')}`,
		);
}
let server;
let serverClosed;
try {
	run('pnpm', ['release:pack', '--local'], root);
	const generator = join(
		dirname(require.resolve('create-flowdular/package.json')),
		'dist/bin.js',
	);
	run(process.execPath, [generator, app, '--no-install', '--no-git'], root);
	run('pnpm', ['install', '--ignore-scripts']);
	const registry = join(root, 'registry/local-index.json');
	const modules = [];
	for (const dir of await readdir(join(root, 'modules'), {
		withFileTypes: true,
	})) {
		if (!dir.isDirectory()) continue;
		const manifest = JSON.parse(
			await readFile(join(root, 'modules', dir.name, 'module.json'), 'utf8'),
		);
		const metadata = JSON.parse(
			await readFile(join(root, 'modules', dir.name, 'package.json'), 'utf8'),
		);
		if (!metadata.scripts?.typecheck || !metadata.scripts?.test)
			throw new Error(
				`Module must declare typecheck and test scripts: ${manifest.id}`,
			);
		modules.push(manifest);
	}
	if (!modules.length) throw new Error('No modules to integrate');
	modules.sort((a, b) => a.id.localeCompare(b.id));
	for (const module of modules) {
		const spec = `${module.id}@${module.version}`;
		run('pnpm', [
			'flowdular',
			'module',
			'install',
			spec,
			'--registry',
			registry,
		]);
		run('pnpm', [
			'flowdular',
			'module',
			'install',
			spec,
			'--registry',
			registry,
			'--apply',
		]);
	}
	// Use the CLI's public composition API. Scope grants are runtime operations;
	// this anonymous HTTP smoke does not create users or bypass authentication.
	const compose = `import {enableModule} from 'flowdular/distribution';
 import {readFile} from 'node:fs/promises';
 const root=process.cwd(), configPath=root+'/flowdular.json';
 for(const id of ${JSON.stringify(modules.map((m) => m.id))}) {
 const config=JSON.parse(await readFile(configPath,'utf8'));
 await enableModule({root,configPath,config},id,true);
 }`;
	run(process.execPath, ['--input-type=module', '-e', compose]);
	run('pnpm', ['flowdular', 'module', 'sync', '--apply']);
	const config = JSON.parse(
		await readFile(join(app, 'flowdular.json'), 'utf8'),
	);
	for (const module of modules) {
		if (!config.modules.enabled.includes(module.id))
			throw new Error(`Module not enabled: ${module.id}`);
	}
	run('pnpm', ['flowdular', 'module', 'validate', '--locked']);
	run('pnpm', ['typecheck']);
	run('pnpm', ['test']);
	run(
		'pnpm',
		['exec', 'vite', 'build'],
		join(app, 'platform'),
		productionEnvironment,
	);
	const entry = await realpath(join(app, 'platform/dist/server/entry.js'));
	await stat(entry);
	const client = join(app, 'platform/dist/client');
	if (!(await readdir(client)).length) throw new Error('Client build is empty');
	// Select an unused port instead of sharing one with another local preview.
	const port = await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const selected = probe.address().port;
			probe.close((error) =>
				error ? reject(error) : resolve(String(selected)),
			);
		});
	});
	server = spawn(process.execPath, [entry], {
		cwd: join(app, 'platform'),
		env: { ...productionEnvironment, PORT: port },
		stdio: 'inherit',
	});
	let failure;
	server.on('error', (error) => {
		failure = error;
	});
	serverClosed = new Promise((resolve) => server.once('close', resolve));
	const deadline = Date.now() + 60_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (failure) throw failure;
		if (server.exitCode !== null || server.signalCode !== null)
			throw new Error('Built server exited before readiness');
		try {
			const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
				redirect: 'manual',
				signal: AbortSignal.timeout(2500),
			});
			if (response.status >= 500)
				throw new Error(
					`Built application returned HTTP ${response.status} for /auth/login`,
				);
			const html = await response.text();
			if (
				response.status === 200 &&
				/text\/html/.test(response.headers.get('content-type') ?? '') &&
				/<html[\s>]/i.test(html) &&
				/<script[\s>]/i.test(html)
			) {
				const asset = [
					...html.matchAll(/(?:src|href)="([^"\s]+\.js(?:\?[^"\s]*)?)"/g),
				]
					.map((m) => m[1])
					.find((p) => p.startsWith('/') && !p.startsWith('//'));
				if (!asset) throw new Error('Rendered page has no JavaScript asset');
				const js = await fetch(new URL(asset, `http://127.0.0.1:${port}`), {
					signal: AbortSignal.timeout(2500),
				});
				if (
					!js.ok ||
					!/javascript/.test(js.headers.get('content-type') ?? '') ||
					!(await js.text()).length
				)
					throw new Error('Client asset not served');
				await delay(500);
				if (server.exitCode !== null || server.signalCode !== null)
					throw new Error('Server exited during smoke');
				ready = true;
				break;
			}
		} catch (error) {
			if (
				!['TypeError', 'TimeoutError', 'AbortError'].includes(error.name) ||
				Date.now() >= deadline
			)
				throw error;
		}
		await delay(500);
	}
	if (!ready)
		throw new Error(
			'Built application did not serve login HTML and JavaScript within 60 seconds',
		);
	console.log(
		`Application integration passed: ${modules.map((m) => m.id).join(', ')}; typecheck, tests, client/SSR build and HTTP smoke.`,
	);
} finally {
	if (server && server.exitCode === null && server.signalCode === null) {
		server.kill('SIGTERM');
		await Promise.race([serverClosed, delay(5000)]);
		if (server.exitCode === null && server.signalCode === null) {
			server.kill('SIGKILL');
			await serverClosed;
		}
	}
	await rm(temporary, { recursive: true, force: true });
}
