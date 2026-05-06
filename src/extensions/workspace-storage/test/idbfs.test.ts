import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IdbFS } from '../src/idbfs.js';
import { FileNotFound } from '../src/memfs.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let testCounter = 0;
const uniqueDb = () => `test-${++testCounter}-${Date.now()}`;

describe('IdbFS', () => {
	it('writeFile + readFile roundtrip', async () => {
		const fs = new IdbFS(uniqueDb());
		await fs.writeFile('/a.txt', enc('hi'), { create: true, overwrite: true });
		expect(dec(await fs.readFile('/a.txt'))).toBe('hi');
	});

	it('persists across instances (close + reopen)', async () => {
		const dbName = uniqueDb();
		const fs1 = new IdbFS(dbName);
		await fs1.writeFile('/persist.txt', enc('keep'), { create: true, overwrite: true });
		await fs1.close();
		const fs2 = new IdbFS(dbName);
		expect(dec(await fs2.readFile('/persist.txt'))).toBe('keep');
	});

	it('createDirectory + readDirectory lists entries', async () => {
		const fs = new IdbFS(uniqueDb());
		await fs.createDirectory('/d');
		await fs.writeFile('/d/x', enc('x'), { create: true, overwrite: true });
		const entries = await fs.readDirectory('/d');
		expect(entries).toEqual([['x', 'file']]);
	});

	it('delete removes a file', async () => {
		const fs = new IdbFS(uniqueDb());
		await fs.writeFile('/gone.txt', enc(''), { create: true, overwrite: true });
		await fs.delete('/gone.txt', { recursive: false });
		await expect(fs.stat('/gone.txt')).rejects.toThrow(FileNotFound);
	});

	it('stat throws FileNotFound on missing', async () => {
		const fs = new IdbFS(uniqueDb());
		await expect(fs.stat('/missing')).rejects.toThrow(FileNotFound);
	});
});
