import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat, mkdtemp } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { unpackVsix, checkExtensionUpdates } from '../build-scripts/fetch-openvsx.mjs';

describe('unpackVsix', () => {
	let work;
	let zipPath;
	let outDir;

	beforeAll(async () => {
		work = await mkdtemp(path.join(os.tmpdir(), 'vsix-test-'));
		const src = path.join(work, 'src');
		await mkdir(path.join(src, 'extension', 'sub'), { recursive: true });
		await writeFile(path.join(src, 'extension', 'package.json'), '{"name":"x"}');
		await writeFile(path.join(src, 'extension', 'foo.js'), 'console.log("hi")');
		await writeFile(path.join(src, 'extension', 'sub', 'nested.txt'), 'nested');
		await mkdir(path.join(src, 'meta'), { recursive: true });
		await writeFile(path.join(src, 'meta', 'manifest.xml'), '<root/>');
		zipPath = path.join(work, 'sample.vsix');
		execSync(`zip -rq "${zipPath}" .`, { cwd: src });
		outDir = path.join(work, 'out');
	});

	afterAll(async () => {
		await rm(work, { recursive: true, force: true });
	});

	it('extracts files under extension/ stripping the prefix', async () => {
		await unpackVsix(zipPath, outDir);
		expect(await readFile(path.join(outDir, 'package.json'), 'utf8')).toBe('{"name":"x"}');
		expect(await readFile(path.join(outDir, 'foo.js'), 'utf8')).toBe('console.log("hi")');
	});

	it('skips entries outside extension/', async () => {
		await unpackVsix(zipPath, outDir);
		await expect(stat(path.join(outDir, 'meta'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('creates nested directories', async () => {
		await unpackVsix(zipPath, outDir);
		expect(await readFile(path.join(outDir, 'sub', 'nested.txt'), 'utf8')).toBe('nested');
	});
});

describe('checkExtensionUpdates', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('classifies each pinned version against the registry latest', async () => {
		// All lookups resolve to 2.0.0 so we exercise every status branch.
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) });

		const results = await checkExtensionUpdates([
			{ publisher: 'p', name: 'behind', version: '1.0.0' },
			{ publisher: 'p', name: 'level', version: '2.0.0' },
			{ publisher: 'p', name: 'ahead', version: '3.0.0' },
			{ publisher: 'p', name: 'loose' },
		]);

		expect(results.map((r) => r.status)).toEqual(['outdated', 'current', 'ahead', 'unpinned']);
		expect(results[0]).toMatchObject({ id: 'p.behind', pinned: '1.0.0', latest: '2.0.0' });
		expect(results[3]).toMatchObject({ id: 'p.loose', pinned: null, latest: '2.0.0' });
	});

	it('reports an error row when the registry lookup fails', async () => {
		// 404 (< 500, not 429) makes resolveVersion give up immediately — no retry delays.
		globalThis.fetch = async () => ({ ok: false, status: 404 });
	
		const [row] = await checkExtensionUpdates([{ publisher: 'p', name: 'missing', version: '1.0.0' }]);
	
		expect(row).toMatchObject({ id: 'p.missing', status: 'error', latest: null });
		expect(row.error).toContain('404');
	});

	// One real Open VSX request. The pin is deliberately ancient, so whatever the
	// current latest is, the result must be 'outdated'.
	it('flags a deliberately-old pin as outdated against the live registry', async () => {
		const [row] = await checkExtensionUpdates([
			{ publisher: 'carlosperate', name: 'uf2editor', version: '0.1.1' },
		]);

		expect(row.status).toBe('outdated');
		expect(row.latest).toBeTruthy();
	});
});
