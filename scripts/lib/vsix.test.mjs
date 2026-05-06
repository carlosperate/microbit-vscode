import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat, mkdtemp } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { unpackVsix } from './vsix.mjs';

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
