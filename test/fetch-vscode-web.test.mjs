import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
	releaseUrls,
	resolveRepoSlug,
	resolveExpectedSha,
	parseSidecar,
	resolveEntryPath,
	fetchVscodeWeb,
} from '../build-scripts/fetch-vscode-web.mjs';

const VERSION = '1.91.1';
const SLUG = 'carlosperate/microbit-vscode';

/**
 * Build a real .zip with the `vscode-web/` shape downstream tooling expects
 * (so unzip + version-read actually work). Returns the bytes and their hash.
 */
async function buildBundleZip(version) {
	const work = await mkdtemp(path.join(os.tmpdir(), 'vw-src-'));
	const bundle = path.join(work, 'vscode-web');
	await mkdir(path.join(bundle, 'out', 'vs', 'workbench'), { recursive: true });
	await writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: 'vscode-web', version }));
	await writeFile(path.join(bundle, 'out', 'vs', 'workbench', 'workbench.web.main.js'), '// stub');
	const zipPath = path.join(work, 'bundle.zip');
	execSync(`zip -rq "${zipPath}" vscode-web`, { cwd: work });
	const buf = await readFile(zipPath);
	const sha = createHash('sha256').update(buf).digest('hex');
	await rm(work, { recursive: true, force: true });
	return { buf, sha };
}

/** A fetch stub that serves a route map and records every requested URL. */
function mockFetch(routes) {
	const calls = [];
	const fn = async (url) => {
		calls.push(url);
		if (!(url in routes)) return { ok: false, status: 404 };
		const body = routes[url];
		return { ok: true, status: 200, arrayBuffer: async () => body };
	};
	fn.calls = calls;
	return fn;
}

const sidecarText = (sha, version) => Buffer.from(`${sha}  vscode-web-v${version}.zip\n`);

describe('releaseUrls', () => {
	it('derives the zip + sidecar URLs from version and repoSlug', () => {
		const { zipName, zipUrl, sha256Url } = releaseUrls(VERSION, SLUG);
		expect(zipName).toBe('vscode-web-v1.91.1.zip');
		expect(zipUrl).toBe(
			'https://github.com/carlosperate/microbit-vscode/releases/download/vscode-web-v1.91.1/vscode-web-v1.91.1.zip'
		);
		expect(sha256Url).toBe(`${zipUrl}.sha256`);
	});
});

describe('resolveRepoSlug', () => {
	it('uses the config slug by default', () => {
		expect(resolveRepoSlug({ repoSlug: SLUG }, {})).toBe(SLUG);
	});
	it('lets REPO_SLUG override the config', () => {
		expect(resolveRepoSlug({ repoSlug: SLUG }, { REPO_SLUG: 'you/fork' })).toBe('you/fork');
	});
});

describe('resolveExpectedSha', () => {
	it('returns null for null / missing / empty sha256 (tracking mode)', () => {
		expect(resolveExpectedSha({ sha256: null })).toBeNull();
		expect(resolveExpectedSha({})).toBeNull();
		expect(resolveExpectedSha({ sha256: '   ' })).toBeNull();
	});
	it('returns a normalised hex string when locked', () => {
		expect(resolveExpectedSha({ sha256: '  ABCDEF  ' })).toBe('abcdef');
	});
});

describe('parseSidecar', () => {
	it('parses the standard `<hash>  <file>` shape', () => {
		expect(parseSidecar('abc123  vscode-web-v1.91.1.zip')).toBe('abc123');
	});
	it('tolerates extra whitespace and \\r\\n line endings', () => {
		expect(parseSidecar('  ABC123 \t file.zip  \r\n')).toBe('abc123');
		expect(parseSidecar('\r\nabc123  file.zip\r\n')).toBe('abc123');
	});
});

describe('resolveEntryPath (zip-slip guard)', () => {
	const dest = '/tmp/target';
	it('allows normal nested entries', () => {
		expect(resolveEntryPath(dest, 'vscode-web/package.json')).toBe('/tmp/target/vscode-web/package.json');
	});
	it('refuses entries that escape via ..', () => {
		expect(() => resolveEntryPath(dest, '../escape.txt')).toThrow(/zip-slip/i);
		expect(() => resolveEntryPath(dest, 'vscode-web/../../escape.txt')).toThrow(/zip-slip/i);
	});
	it('refuses absolute entry paths', () => {
		expect(() => resolveEntryPath(dest, '/etc/passwd')).toThrow(/zip-slip/i);
	});
});

describe('fetchVscodeWeb', () => {
	let cacheDir;
	const log = () => {};

	beforeEach(async () => {
		cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vw-cache-'));
	});
	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true });
	});

	const zipPath = () => path.join(cacheDir, `vscode-web-v${VERSION}.zip`);
	const sidecarPath = () => path.join(cacheDir, `vscode-web-v${VERSION}.zip.sha256`);
	const bundlePkg = () => path.join(cacheDir, 'vscode-web', 'package.json');

	async function seedBundle(version) {
		await mkdir(path.join(cacheDir, 'vscode-web'), { recursive: true });
		await writeFile(bundlePkg(), JSON.stringify({ name: 'vscode-web', version }));
	}

	it('skips when the cached bundle already matches the version', async () => {
		await seedBundle(VERSION);
		const fetchImpl = mockFetch({});
		const res = await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG }, cacheDir, fetchImpl, log });
		expect(res.action).toBe('skip');
		expect(fetchImpl.calls).toEqual([]);
	});

	it('tracking-mode cache hit: verifies via sidecar, unzips, no network', async () => {
		const { buf, sha } = await buildBundleZip(VERSION);
		await writeFile(zipPath(), buf);
		await writeFile(sidecarPath(), sidecarText(sha, VERSION));
		const fetchImpl = mockFetch({});

		await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: null }, cacheDir, fetchImpl, log });

		expect(fetchImpl.calls).toEqual([]);
		expect(JSON.parse(await readFile(bundlePkg(), 'utf8')).version).toBe(VERSION);
	});

	it('tracking-mode cache miss: downloads zip + sidecar, verifies, unzips', async () => {
		const { buf, sha } = await buildBundleZip(VERSION);
		const { zipUrl, sha256Url } = releaseUrls(VERSION, SLUG);
		const fetchImpl = mockFetch({ [zipUrl]: buf, [sha256Url]: sidecarText(sha, VERSION) });

		await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: null }, cacheDir, fetchImpl, log });

		expect(fetchImpl.calls).toContain(zipUrl);
		expect(fetchImpl.calls).toContain(sha256Url);
		expect(JSON.parse(await readFile(bundlePkg(), 'utf8')).version).toBe(VERSION);
	});

	it('locked-mode cache hit: verifies against config sha, no sidecar needed, no network', async () => {
		const { buf, sha } = await buildBundleZip(VERSION);
		await writeFile(zipPath(), buf);
		const fetchImpl = mockFetch({});

		await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: sha }, cacheDir, fetchImpl, log });

		expect(fetchImpl.calls).toEqual([]);
		expect(existsSync(sidecarPath())).toBe(false);
		expect(JSON.parse(await readFile(bundlePkg(), 'utf8')).version).toBe(VERSION);
	});

	it('locked-mode cache miss: downloads the zip only (never the sidecar)', async () => {
		const { buf, sha } = await buildBundleZip(VERSION);
		const { zipUrl, sha256Url } = releaseUrls(VERSION, SLUG);
		const fetchImpl = mockFetch({ [zipUrl]: buf, [sha256Url]: sidecarText(sha, VERSION) });

		await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: sha }, cacheDir, fetchImpl, log });

		expect(fetchImpl.calls).toContain(zipUrl);
		expect(fetchImpl.calls).not.toContain(sha256Url);
		expect(JSON.parse(await readFile(bundlePkg(), 'utf8')).version).toBe(VERSION);
	});

	it('locked-mode mismatch: errors, deletes the zip, leaves bundle unpopulated', async () => {
		const { buf } = await buildBundleZip(VERSION);
		await writeFile(zipPath(), buf);
		const fetchImpl = mockFetch({});

		await expect(
			fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: '0'.repeat(64) }, cacheDir, fetchImpl, log })
		).rejects.toThrow(/committed hash/);

		expect(existsSync(zipPath())).toBe(false);
		expect(existsSync(bundlePkg())).toBe(false);
	});

	it('tracking-mode mismatch: errors, deletes zip + sidecar', async () => {
		const { buf } = await buildBundleZip(VERSION);
		await writeFile(zipPath(), buf);
		await writeFile(sidecarPath(), sidecarText('0'.repeat(64), VERSION));
		const fetchImpl = mockFetch({});

		await expect(
			fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: null }, cacheDir, fetchImpl, log })
		).rejects.toThrow(/corrupted download or tampered cache/);

		expect(existsSync(zipPath())).toBe(false);
		expect(existsSync(sidecarPath())).toBe(false);
	});

	it('refetches when the cached bundle version mismatches (from cache, no network)', async () => {
		await seedBundle('0.0.1');
		const { buf, sha } = await buildBundleZip(VERSION);
		await writeFile(zipPath(), buf);
		await writeFile(sidecarPath(), sidecarText(sha, VERSION));
		const fetchImpl = mockFetch({});

		await fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: null }, cacheDir, fetchImpl, log });

		expect(fetchImpl.calls).toEqual([]);
		expect(JSON.parse(await readFile(bundlePkg(), 'utf8')).version).toBe(VERSION);
	});

	it('reports a clear error (with the URL) when the release asset is missing', async () => {
		const fetchImpl = mockFetch({}); // every URL 404s
		await expect(
			fetchVscodeWeb({ config: { vscodeVersion: VERSION, repoSlug: SLUG, sha256: null }, cacheDir, fetchImpl, log })
		).rejects.toThrow(/build:vscode/);
	});
});
