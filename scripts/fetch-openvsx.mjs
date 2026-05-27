import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import semver from 'semver';
import yauzl from 'yauzl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'extensions.config.json');
const cacheDir = path.join(root, '.cache', 'vsix');
const distExtensions = path.join(root, 'dist', 'extensions');

const VSIX_PREFIX = 'extension/';

/** Read and parse config/extensions.config.json. */
function loadExtensionsConfig() {
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

/**
 * Unpack the `extension/` directory of a VSIX (which is a ZIP) into outDir.
 * Strips the `extension/` prefix. Entries outside `extension/` are ignored.
 *
 * @throws If the ZIP is invalid or any file operations fail.
 *
 * @param {string} zipPath Path to the VSIX file.
 * @param {string} outDir Directory to write the unpacked extension files into.
 *     Will be created if it doesn't exist. Will be emptied if it does exist.
 * @returns {Promise<void>} Resolves when unpacking is complete.
 */
export async function unpackVsix(zipPath, outDir) {
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
			if (err) return reject(err);
			zip.on('error', reject);
			zip.on('end', resolve);
			zip.on('entry', (entry) => {
				const name = entry.fileName;
				if (!name.startsWith(VSIX_PREFIX) || name === VSIX_PREFIX) {
					zip.readEntry();
					return;
				}
				const rel = name.slice(VSIX_PREFIX.length);
				const dest = path.join(outDir, rel);

				if (name.endsWith('/')) {
					mkdir(dest, { recursive: true })
						.then(() => zip.readEntry())
						.catch(reject);
					return;
				}

				mkdir(path.dirname(dest), { recursive: true })
					.then(() => {
						zip.openReadStream(entry, (err, stream) => {
							if (err) return reject(err);
							const out = createWriteStream(dest);
							stream.pipe(out);
							out.on('finish', () => zip.readEntry());
							out.on('error', reject);
						});
					})
					.catch(reject);
			});
			zip.readEntry();
		});
	});
}

/**
 * Get the latest version from a Open VSX package.
 *
 * Retries a few times with backoff if the request fails or is rate-limited.
 * Throws if all attempts fail or if the response is invalid.
 * 
 * @param {string} publisher
 * @param {string} name
 * @returns {Promise<string>} Latest version string from the registry
 */
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
 * @param {Array<{ publisher: string, name: string, version?: string }>} config
 * @returns {Promise<Array<{ id: string, pinned: string|null, latest: string|null, status: string, error?: string }>>}
 *     One result per extension in the config, with status vs registry.
 *     status = 'outdated' | 'current' | 'ahead' | 'unpinned' | 'error'
 */
export async function checkExtensionUpdates(config) {
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
 *
 * @param {Array<{ id: string, pinned: string|null, latest: string|null, status: string, error?: string }>} results
 *     The results from `checkExtensionUpdates()`.
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
		if (r.status === 'error') {
			console.log(`  ${id}  ${labels.error}: ${r.error}`);
		} else {
			const latest = r.latest ? ` (latest ${r.latest})` : '';
			console.log(`  ${id}  ${r.pinned ?? '—'}${latest}\t\t${labels[r.status]}`);
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
	const config = loadExtensionsConfig();
	await mkdir(cacheDir, { recursive: true });
	await mkdir(distExtensions, { recursive: true });

	const refs = [];
	for (const { publisher, name, version: pinned } of config) {
		const version = pinned ?? (await resolveVersion(publisher, name));
		const id = `${publisher}.${name}`;
		const vsixPath = path.join(cacheDir, `${id}-${version}.vsix`);

		if (existsSync(vsixPath)) {
			console.log(`\tCached    ${id}@${version}`);
		} else {
			console.log(`\tDownloading ${id}@${version}`);
			await downloadVsix(publisher, name, version, vsixPath);
		}

		const outDir = path.join(distExtensions, id);
		await unpackVsix(vsixPath, outDir);

		const pkg = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
		if (pkg.main && !pkg.browser) {
			console.warn(
				`\t⚠️  ${id} has a "main" entry with no "browser" one, likely won't run in vscode-web`
			);
		}

		// VS Code probes every extension for package.nls.json (localized strings).
		// Most extensions don't ship one, producing dozens of harmless 404 logs.
		// Write an empty {} stub to silence the noise.
		const nlsPath = path.join(outDir, 'package.nls.json');
		if (!existsSync(nlsPath)) {
			await writeFile(nlsPath, '{}\n');
		}

		refs.push({ scheme: 'http', path: `/extensions/${id}` });
	}
	return refs;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	if (process.argv.includes('--check')) {
		checkExtensionUpdates(loadExtensionsConfig())
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
