import { describe, expect, it } from 'vitest';

import { ActiveFS, clearBacking, copyBacking, ensureBase, listPaths, replaceBacking, snapshot, type Backing } from '../src/active.js';
import { FileNotFound, MemFS } from '../src/memfs.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function backing(base: string, files: Record<string, string>): Backing {
	const core = new MemFS();
	if (base) core.createDirectory(base);
	for (const [path, contents] of Object.entries(files)) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			try {
				core.createDirectory(`${base}/${parts.slice(0, i).join('/')}`);
			} catch {
				/* already there */
			}
		}
		core.writeFile(`${base}/${path}`, enc(contents), { create: true, overwrite: true });
	}
	return { core, base };
}

describe('ActiveFS', () => {
	it('lists only the workspace folder at the root', async () => {
		const active = new ActiveFS('Project', backing('/Welcome workspace', {}));
		expect(await active.readDirectory('/')).toEqual([['Project', 'directory']]);
		expect((await active.stat('/')).type).toBe('directory');
	});

	it('reads and writes the active storage, inside its own folder', async () => {
		const scratch = backing('/Welcome workspace', { 'main.py': 'print(1)' });
		const active = new ActiveFS('Project', scratch);
		expect(dec(await active.readFile('/Project/main.py'))).toBe('print(1)');
		await active.writeFile('/Project/new.py', enc('x'), { create: true, overwrite: false });
		expect(dec(scratch.core.readFile('/Welcome workspace/new.py') as Uint8Array)).toBe('x');
	});

	// The workspace folder never changes, so the Explorer never shows it as a row.
	it('shows the other storage at the same paths once switched', async () => {
		const active = new ActiveFS('Project', backing('/Welcome workspace', { 'main.py': '' }));
		active.use(backing('/Browser workspace', { 'main.cpp': '' }));
		expect(await active.readDirectory('/Project')).toEqual([['main.cpp', 'file']]);
	});

	it('maps a storage whose folder is its own root', async () => {
		const active = new ActiveFS('Project', backing('', { 'a.txt': 'a' }));
		expect((await active.stat('/Project')).type).toBe('directory');
		expect(dec(await active.readFile('/Project/a.txt'))).toBe('a');
	});

	// Search asks the size to skip big files unread, so a guess must never cost a read of its own.
	it('reports a size only where the storage knows it without reading the file', async () => {
		const scratch = backing('/w', { 'main.py': 'print(1)' });
		let reads = 0;
		const counted = { ...scratch, core: Object.assign(Object.create(scratch.core), { readFile: (p: string) => (reads += 1, scratch.core.readFile(p)) }) };
		const active = new ActiveFS('Project', counted);
		expect(await active.fileSize('/Project/main.py')).toBe(0);
		expect(reads).toBe(0);
		active.use({ ...scratch, core: Object.assign(Object.create(scratch.core), { fileSize: () => 8 }) });
		expect(await active.fileSize('/Project/main.py')).toBe(8);
	});

	it('finds nothing outside the workspace folder', async () => {
		const active = new ActiveFS('Project', backing('', { 'a.txt': 'a' }));
		await expect(active.stat('/Other/a.txt')).rejects.toBeInstanceOf(FileNotFound);
		await expect(active.writeFile('/', enc(''), { create: true, overwrite: true })).rejects.toBeInstanceOf(FileNotFound);
	});
});

describe('copyBacking', () => {
	it('merges files and folders into the other storage, replacing same names', async () => {
		const from = backing('/Welcome workspace', { 'main.py': 'new', 'lib/a.py': 'a' });
		const to = backing('/Browser workspace', { 'main.py': 'old', 'keep.txt': 'k' });
		await copyBacking(from, to, true);
		expect(Object.fromEntries(await snapshot(to))).toEqual({ 'main.py': 'new', 'lib/a.py': 'a', 'keep.txt': 'k' });
	});

	it('keeps a file already there when told not to overwrite', async () => {
		const to = backing('', { 'main.py': 'saved' });
		await copyBacking(backing('/w', { 'main.py': 'starter', 'README.md': 'r' }), to, false);
		expect(Object.fromEntries(await snapshot(to))).toEqual({ 'main.py': 'saved', 'README.md': 'r' });
	});
});

describe('replaceBacking', () => {
	it('leaves the other storage holding these files and nothing else', async () => {
		const from = backing('/Welcome workspace', { 'main.py': 'mine', 'lib/a.py': 'a' });
		const to = backing('/Replaced workspace', { 'main.py': 'old', 'stale.txt': 's' });
		await replaceBacking(from, to);
		expect(Object.fromEntries(await snapshot(to))).toEqual({ 'main.py': 'mine', 'lib/a.py': 'a' });
		expect(Object.fromEntries(await snapshot(from))).toEqual({ 'main.py': 'mine', 'lib/a.py': 'a' });
	});

	it('creates the other storage folder when it is not there yet', async () => {
		const core = new MemFS();
		core.createDirectory('/w');
		core.writeFile('/w/main.py', enc('x'), { create: true, overwrite: true });
		const spare = { core, base: '/spare' };
		await replaceBacking({ core, base: '/w' }, spare);
		expect(Object.fromEntries(await snapshot(spare))).toEqual({ 'main.py': 'x' });
	});
});

describe('ensureBase', () => {
	it("creates a storage's project folder the first time, and leaves it alone after", async () => {
		const store = { core: new MemFS(), base: '/Browser workspace' };
		await ensureBase(store);
		await ensureBase(store);
		expect(await listPaths(store)).toEqual([]);
	});
});

describe('clearBacking and listPaths', () => {
	it('empties a storage folder, and lists folders before their files', async () => {
		const store = backing('/w', { 'main.py': '', 'lib/a.py': '' });
		expect(await listPaths(store)).toEqual(['main.py', 'lib', 'lib/a.py']);
		await clearBacking(store);
		expect(await listPaths(store)).toEqual([]);
	});
});
