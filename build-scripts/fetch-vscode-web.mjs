/**
 * Fetch the prebuilt vscode-web bundle from the GitHub release.
 *
 * Reads config/vscode-web.config.json to pull the `vscodeVersion` from
 * `repoSlug` and populate the .cache/vscode-web/ bundle.
 *
 * Decision tree:
 *   1. <cache>/vscode-web/package.json already matches vscodeVersion -> skip.
 *   2. else wipe <cache>/vscode-web and obtain the release zip:
 *        - cached zip with expected hash → reuse the zip.
 *        - else
 *            - locked (config.sha256 set) -> download the zip, verify against
 *              the committed hash.
 *            - config.sha256 null -> download zip + .sha256 sidecar,
 *              verify the zip against the sidecar hash.
 *      then unzip into <cache>/.
 *
 * Verification runs on every download AND every cache hit. Cache files live at
 * <cache>/vscode-web-v<version>.zip (+ .sha256 in tracking mode), keyed by
 * version, so a version bump invalidates them automatically.
 *
 * Available as `npm run fetch:vscode`. Wired into `prebuild` in a later chunk.
 */

import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yauzl from 'yauzl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read and parse config/vscode-web.config.json. */
function loadConfig() {
	return JSON.parse(readFileSync(path.join(root, 'config', 'vscode-web.config.json'), 'utf8'));
}

/** Derive the release asset URLs for a version + repo slug. */
export function releaseUrls(version, repoSlug) {
	const zipName = `vscode-web-v${version}.zip`;
	const base = `https://github.com/${repoSlug}/releases/download/vscode-web-v${version}`;
	return { zipName, zipUrl: `${base}/${zipName}`, sha256Url: `${base}/${zipName}.sha256` };
}

/** REPO_SLUG env var overrides the config slug (for forks). */
export function resolveRepoSlug(config, env = process.env) {
	return env.REPO_SLUG || config.repoSlug;
}

/**
 * The committed trust anchor, or null when none is set.
 * A non-empty string means locked mode; null/missing/blank means tracking mode.
 */
export function resolveExpectedSha(config) {
	const v = config.sha256;
	return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null;
}

/** Parse the first hash token from `sha256sum` output (tolerates whitespace / CRLF). */
export function parseSidecar(text) {
	const line = text.replace(/\r/g, '').split('\n').find((l) => l.trim() !== '') ?? '';
	return line.trim().split(/\s+/)[0].toLowerCase();
}

/**
 * Resolve a zip entry path against the extraction root, refusing any entry that
 * escapes it (zip-slip: `../…` or absolute paths).
 */
export function resolveEntryPath(destDir, entryName) {
	const resolved = path.resolve(destDir, entryName);
	const rel = path.relative(destDir, resolved);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`Refusing to extract entry outside target dir (zip-slip): ${entryName}`);
	}
	return resolved;
}

/** SHA-256 of a file as a lowercase hex string. */
async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/**
 * Verify a file against an expected hash. On mismatch, run `cleanup` (to clear
 * the bad cache) and throw a mode-specific error.
 */
async function verifyChecksum(filePath, expectedHex, mode, version, cleanup) {
	const actual = await sha256File(filePath);
	if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
		await cleanup();
		throw new Error(
			mode === 'locked'
				? 'checksum mismatch against config/vscode-web.config.json sha256 — ' +
					'the release artifact does not match the committed hash; investigate or update the lock'
				: `checksum mismatch against vscode-web-v${version}.zip.sha256 — ` +
					'corrupted download or tampered cache; cleared, please retry'
		);
	}
}

/** Download a URL to a file. Throws a helpful error on 404 / non-OK. */
async function downloadFile(url, destPath, fetchImpl, ctx) {
	const res = await fetchImpl(url);
	if (!res.ok) {
		if (res.status === 404) {
			throw new Error(
				`Release asset not found (404): ${url}\n` +
				`No vscode-web-v${ctx.version} release exists yet for ${ctx.repoSlug}.\n` +
				`Build it locally with \`npm run build:vscode\`, or push a vscode-web-v${ctx.version} ` +
				`tag to trigger the build-vscode workflow.`
			);
		}
		throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await mkdir(path.dirname(destPath), { recursive: true });
	await writeFile(destPath, buf);
}

/**
 * Unzip an in-memory zip Buffer into destDir, guarding every entry against
 * zip-slip.
 *
 * We use yauzl.fromBuffer (not yauzl.open) deliberately: yauzl's fd-backed read
 * streams (fd-slicer doing a per-entry fs.read) deadlock on large multi-chunk
 * entries on Linux — the first chunk is read, then nothing re-schedules the
 * next read and the event loop drains with the promise unsettled. Slicing an
 * in-memory buffer skips fs.read entirely, so there's nothing to stall.
 */
async function unzip(zipBuffer, destDir) {
	await mkdir(destDir, { recursive: true });
	const zip = await new Promise((resolve, reject) =>
		yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, z) =>
			err ? reject(err) : resolve(z)
		)
	);
	await new Promise((resolve, reject) => {
		zip.on('error', reject);
		zip.on('end', resolve);
		zip.on('entry', (entry) => {
			// Drive each entry to completion, then pull the next. Any failure
			// rejects the whole unzip, so readEntry() is always either called
			// again or the promise is settled — it can't hang.
			extractEntry(zip, entry, destDir)
				.then(() => zip.readEntry())
				.catch(reject);
		});
		zip.readEntry();
	});
}

/** Extract a single zip entry to destDir (directory or file), guarding zip-slip. */
async function extractEntry(zip, entry, destDir) {
	const dest = resolveEntryPath(destDir, entry.fileName);
	if (entry.fileName.endsWith('/')) {
		await mkdir(dest, { recursive: true });
		return;
	}
	await mkdir(path.dirname(dest), { recursive: true });
	const stream = await new Promise((resolve, reject) =>
		zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)))
	);
	const chunks = await new Promise((resolve, reject) => {
		const buf = [];
		stream.on('data', (c) => buf.push(c));
		stream.on('end', () => resolve(buf));
		stream.on('error', reject);
	});
	await writeFile(dest, Buffer.concat(chunks));
}

/**
 * Ensure <cache>/vscode-web/ holds the pinned version, downloading + verifying
 * the release zip when needed. Throws (does not exit) on any error so it's
 * testable; the CLI wrapper maps that onto a non-zero exit.
 *
 * @returns {Promise<{ action: 'skip' | 'downloaded', version: string }>}
 */
export async function fetchVscodeWeb({
	config = loadConfig(),
	cacheDir = path.join(root, '.cache'),
	fetchImpl = globalThis.fetch,
	env = process.env,
	log = console.log,
} = {}) {
	const version = config.vscodeVersion;
	const repoSlug = resolveRepoSlug(config, env);
	const lockedSha = resolveExpectedSha(config);
	const mode = lockedSha ? 'locked' : 'tracking';

	const bundleDir = path.join(cacheDir, 'vscode-web');
	const bundlePkg = path.join(bundleDir, 'package.json');
	const { zipName, zipUrl, sha256Url } = releaseUrls(version, repoSlug);
	const zipPath = path.join(cacheDir, zipName);
	const sidecarPath = path.join(cacheDir, `${zipName}.sha256`);

	// 1. Already at the right version → nothing to do.
	if (existsSync(bundlePkg)) {
		const current = JSON.parse(await readFile(bundlePkg, 'utf8')).version;
		if (current === version) {
			log(`vscode-web ${version} already present in ${path.relative(root, bundleDir)} — skipping.`);
			return { action: 'skip', version };
		}
		log(`Cached vscode-web is ${current}, want ${version} — refetching.`);
	}

	// 2. Clear any stale bundle, then obtain + verify the zip.
	await rm(bundleDir, { recursive: true, force: true });
	await mkdir(cacheDir, { recursive: true });

	if (mode === 'locked') {
		if (existsSync(zipPath)) {
			log(`Using cached ${zipName}`);
		} else {
			log(`Downloading ${zipUrl}`);
			await downloadFile(zipUrl, zipPath, fetchImpl, { version, repoSlug });
		}
		await verifyChecksum(zipPath, lockedSha, 'locked', version, () => rm(zipPath, { force: true }));
		log(`Verified ${zipName} against config/vscode-web.config.json sha256 (locked) ✓`);
	} else {
		if (existsSync(zipPath) && existsSync(sidecarPath)) {
			log(`Using cached ${zipName} (+ sidecar)`);
		} else {
			log(`Downloading ${zipUrl}`);
			await downloadFile(zipUrl, zipPath, fetchImpl, { version, repoSlug });
			log(`Downloading ${sha256Url}`);
			await downloadFile(sha256Url, sidecarPath, fetchImpl, { version, repoSlug });
		}
		const expectedSha = parseSidecar(await readFile(sidecarPath, 'utf8'));
		await verifyChecksum(zipPath, expectedSha, 'tracking', version, async () => {
			await rm(zipPath, { force: true });
			await rm(sidecarPath, { force: true });
		});
		log(`Verified ${zipName} against ${zipName}.sha256 release sidecar (tracking) ✓`);
	}

	log(`Unpacking ${zipName} → ${path.relative(root, bundleDir)}`);
	await unzip(await readFile(zipPath), cacheDir);

	if (!existsSync(bundlePkg)) {
		throw new Error(
			`unzip did not produce ${path.relative(root, bundlePkg)} — unexpected archive layout`
		);
	}
	return { action: 'downloaded', version };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	fetchVscodeWeb().catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
