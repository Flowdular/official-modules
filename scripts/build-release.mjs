import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashBytes, packModule } from 'flowdular/distribution';
const root = fileURLToPath(new URL('..', import.meta.url));
const local = process.argv.includes('--local');
const indexOnly = process.argv.includes('--index-only');
const records = [];
let commit;
if (indexOnly) {
	commit = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	}).trim();
	if (
		execFileSync(
			'git',
			[
				'status',
				'--porcelain',
				'--',
				'modules',
				'reviews',
				'registry/releases',
			],
			{ cwd: root, encoding: 'utf8' },
		).trim()
	)
		throw new Error(
			'Commit reviewed sources and immutable artifacts before generating the official index.',
		);
}
for (const entry of await readdir(join(root, 'modules'), {
	withFileTypes: true,
})) {
	if (!entry.isDirectory()) continue;
	const directory = join(root, 'modules', entry.name);
	const manifest = JSON.parse(
		await readFile(join(directory, 'module.json'), 'utf8'),
	);
	const review = JSON.parse(
		await readFile(join(root, 'reviews', manifest.id + '.json'), 'utf8'),
	);
	const artifact = await packModule(directory, review);
	const bytes = JSON.stringify(artifact) + '\n';
	const relative = `releases/${manifest.id}/${manifest.version}.json`;
	const output = join(root, 'registry', relative);
	let existing;
	try {
		existing = await readFile(output, 'utf8');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	if (existing !== undefined && existing !== bytes)
		throw new Error(
			`Published version is immutable: ${manifest.id}@${manifest.version}`,
		);
	if (indexOnly && existing === undefined)
		throw new Error(`Missing committed artifact: ${relative}`);
	if (!indexOnly && existing === undefined) {
		await mkdir(resolve(output, '..'), { recursive: true });
		await writeFile(output, bytes, { flag: 'wx' });
	}
	records.push({
		manifest,
		artifact: indexOnly
			? `https://raw.githubusercontent.com/Flowdular/official-modules/${commit}/registry/${relative}`
			: relative,
		sha256: hashBytes(bytes),
		sourceCommit:
			commit ??
			execFileSync('git', ['rev-parse', 'HEAD'], {
				cwd: root,
				encoding: 'utf8',
			}).trim(),
		license: 'MIT',
	});
}
if (!local && !indexOnly)
	throw new Error(
		'Use --local to prepare artifacts, commit them, then --index-only to pin the official index to that commit.',
	);
// Keep historical releases for reproducible installs and explicit version selection.
const destination = join(
	root,
	'registry',
	local ? 'local-index.json' : 'index.json',
);
let previous = [];
try {
	previous = JSON.parse(await readFile(destination, 'utf8')).releases;
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}
const incoming = new Set(
	records.map((record) => record.manifest.id + '@' + record.manifest.version),
);
const releases = [
	...previous.filter(
		(record) =>
			!incoming.has(record.manifest.id + '@' + record.manifest.version),
	),
	...records,
].sort(
	(a, b) =>
		a.manifest.id.localeCompare(b.manifest.id) ||
		a.manifest.version.localeCompare(b.manifest.version),
);
await writeFile(
	destination,
	JSON.stringify({ schemaVersion: 1, releases }, null, '\t') + '\n',
);
console.log(`${records.length} reviewed releases: ${destination}`);
