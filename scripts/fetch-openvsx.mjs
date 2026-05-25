import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import semver from 'semver';
import { unpackVsix } from './lib/vsix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'extensions.config.json');
const cacheDir = path.join(root, '.cache', 'vsix');
const distExtensions = path.join(root, 'dist', 'extensions');

async function exists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveVersion(publisher, name) {
	const url = `https://open-vsx.org/api/${publisher}/${name}`;
	const delays = [0, 1000, 3000, 7000];
	let lastStatus;
	for (const delay of delays) {
		if (delay) await new Promise((r) => setTimeout(r, delay));
		const res = await fetch(url);
		if (res.ok) {
			const data = await res.json();
			return data.version;
		}
		lastStatus = res.status;
		if (res.status !== 429 && res.status < 500) break;
	}
	throw new Error(`Failed to fetch metadata for ${publisher}.${name}: ${lastStatus}`);
}

/**
 * For each extension in the config, find out the latest version from Open VSX
 * and compare it to the pinned `version`. No downloads, no disk writes.
 * One metadata request per extension (so it counts against the same rate limit
 * as a build that resolves versions).
 *
 * Returns one result row per extension:
 *   { id, pinned, latest, status, error? }
 *   status = 'outdated' | 'current' | 'ahead' | 'unpinned' | 'error'
 */
export async function checkExtensionUpdates() {
	const config = JSON.parse(await readFile(configPath, 'utf8'));
	const results = [];
	for (const { publisher, name, version: pinned } of config) {
		const id = `${publisher}.${name}`;
		let latest;
		try {
			latest = await resolveVersion(publisher, name);
		} catch (e) {
			results.push({ id, pinned: pinned ?? null, latest: null, status: 'error', error: e.message });
			continue;
		}
		let status;
		if (!pinned) {
			status = 'unpinned';
		} else {
			// Coerce so non-strict Open VSX version strings still parse; fall back
			// to plain string (in)equality if either can't be coerced.
			const a = semver.coerce(pinned);
			const b = semver.coerce(latest);
			const cmp = a && b ? semver.compare(a, b) : pinned === latest ? 0 : -1;
			status = cmp < 0 ? 'outdated' : cmp > 0 ? 'ahead' : 'current';
		}
		results.push({ id, pinned: pinned ?? null, latest, status });
	}
	return results;
}

/**
 * Print the result of `checkExtensionUpdates()` to stdout.
 */
function printUpdateCheck(results) {
	const idWidth = Math.max(...results.map((r) => r.id.length));
	const labels = {
		outdated: 'UPDATE AVAILABLE',
		current: 'up to date',
		ahead: 'pinned ahead of registry',
		unpinned: 'unpinned (no version in config)',
		error: 'lookup failed',
	};
	console.log('Checking Open VSX for newer extension versions...\n');
	for (const r of results) {
		const id = r.id.padEnd(idWidth);
		if (r.status === 'outdated') {
			console.log(`  ${id}  ${r.pinned} → ${r.latest}   ${labels.outdated}`);
		} else if (r.status === 'error') {
			console.log(`  ${id}  ${labels.error}: ${r.error}`);
		} else {
			const latest = r.latest ? ` (latest ${r.latest})` : '';
			console.log(`  ${id}  ${r.pinned ?? '—'}${latest}   ${labels[r.status]}`);
		}
	}
	const outdated = results.filter((r) => r.status === 'outdated');
	const errors = results.filter((r) => r.status === 'error');
	console.log('');
	if (outdated.length) {
		console.log(
			`${outdated.length} update(s) available. Bump "version" in config/extensions.config.json, then run npm run build.`
		);
	} else if (!errors.length) {
		console.log('All pinned extensions are up to date.');
	}
	if (errors.length) {
		console.log(`${errors.length} lookup(s) failed (e.g. rate-limited or not found).`);
	}
}

async function downloadVsix(publisher, name, version, destPath) {
	const url = `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${publisher}.${name}-${version}.vsix`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to download VSIX for ${publisher}.${name}@${version}: ${res.status}`);
	}
	await mkdir(path.dirname(destPath), { recursive: true });
	await finished(Readable.fromWeb(res.body).pipe(createWriteStream(destPath)));
}

export async function fetchAndUnpackExtensions() {
	const config = JSON.parse(await readFile(configPath, 'utf8'));
	await mkdir(cacheDir, { recursive: true });
	await mkdir(distExtensions, { recursive: true });

	const refs = [];
	for (const { publisher, name, version: pinned } of config) {
		const version = pinned ?? (await resolveVersion(publisher, name));
		const id = `${publisher}.${name}`;
		const vsixPath = path.join(cacheDir, `${id}-${version}.vsix`);

		if (await exists(vsixPath)) {
			console.log(`Cached    ${id}@${version}`);
		} else {
			console.log(`Downloading ${id}@${version}`);
			await downloadVsix(publisher, name, version, vsixPath);
		}

		const outDir = path.join(distExtensions, id);
		await unpackVsix(vsixPath, outDir);

		const pkg = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
		if (pkg.main && !pkg.browser) {
			console.warn(
				`⚠️  ${id} has a "main" entry with no "browser" one, likely won't run in vscode-web`
			);
		}

		// VS Code probes every extension for package.nls.json (localized strings).
		// Most extensions don't ship one, producing dozens of harmless 404 logs.
		// Write an empty {} stub to silence the noise.
		const nlsPath = path.join(outDir, 'package.nls.json');
		if (!(await exists(nlsPath))) {
			await writeFile(nlsPath, '{}\n');
		}

		refs.push({ scheme: 'http', path: `/extensions/${id}` });
	}
	return refs;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	if (process.argv.includes('--check')) {
		checkExtensionUpdates()
			.then(printUpdateCheck)
			.catch((e) => {
				console.error(e);
				process.exit(1);
			});
	} else {
		fetchAndUnpackExtensions().then((refs) => {
			console.log('additionalBuiltinExtensions:', JSON.stringify(refs, null, 2));
		}).catch((e) => {
			console.error(e);
			process.exit(1);
		});
	}
}
