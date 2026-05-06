import {
	FileNotFound,
	FileExists,
	FileIsADirectory,
	FileNotADirectory,
	DirectoryNotEmpty,
	type EntryType,
	type Stat,
} from './memfs.js';

interface Record {
	path: string;
	type: EntryType;
	data?: Uint8Array;
	ctime: number;
	mtime: number;
}

const STORE = 'entries';

function normalize(p: string): string {
	const parts = p.split('/').filter((s) => s.length > 0);
	return '/' + parts.join('/');
}

function parentOf(p: string): string {
	const norm = normalize(p);
	if (norm === '/') return '/';
	const idx = norm.lastIndexOf('/');
	return idx === 0 ? '/' : norm.slice(0, idx);
}

function basenameOf(p: string): string {
	const norm = normalize(p);
	const idx = norm.lastIndexOf('/');
	return norm.slice(idx + 1);
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export class IdbFS {
	private dbPromise: Promise<IDBDatabase> | undefined;

	constructor(private readonly dbName = 'microbit-workspace-storage') {}

	private db(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = new Promise((resolve, reject) => {
				const req = indexedDB.open(this.dbName, 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore(STORE, { keyPath: 'path' });
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		}
		return this.dbPromise;
	}

	async close(): Promise<void> {
		if (this.dbPromise) {
			const db = await this.dbPromise;
			db.close();
			this.dbPromise = undefined;
		}
	}

	private async get(path: string): Promise<Record | undefined> {
		const db = await this.db();
		const tx = db.transaction(STORE, 'readonly');
		return promisifyRequest(tx.objectStore(STORE).get(normalize(path))) as Promise<Record | undefined>;
	}

	private async put(record: Record): Promise<void> {
		const db = await this.db();
		const tx = db.transaction(STORE, 'readwrite');
		await promisifyRequest(tx.objectStore(STORE).put(record));
	}

	private async remove(path: string): Promise<void> {
		const db = await this.db();
		const tx = db.transaction(STORE, 'readwrite');
		await promisifyRequest(tx.objectStore(STORE).delete(normalize(path)));
	}

	private async assertParent(path: string): Promise<void> {
		const parent = parentOf(path);
		if (parent === '/') return;
		const rec = await this.get(parent);
		if (!rec) throw new FileNotFound(parent);
		if (rec.type !== 'directory') throw new FileNotADirectory(parent);
	}

	async stat(path: string): Promise<Stat> {
		const norm = normalize(path);
		if (norm === '/') {
			return { type: 'directory', size: 0, ctime: 0, mtime: 0 };
		}
		const rec = await this.get(norm);
		if (!rec) throw new FileNotFound(path);
		return {
			type: rec.type,
			size: rec.type === 'file' ? rec.data?.byteLength ?? 0 : 0,
			ctime: rec.ctime,
			mtime: rec.mtime,
		};
	}

	async readDirectory(path: string): Promise<[string, EntryType][]> {
		const norm = normalize(path);
		if (norm !== '/') {
			const rec = await this.get(norm);
			if (!rec) throw new FileNotFound(path);
			if (rec.type !== 'directory') throw new FileNotADirectory(path);
		}
		const db = await this.db();
		const tx = db.transaction(STORE, 'readonly');
		const all = (await promisifyRequest(tx.objectStore(STORE).getAll())) as Record[];
		const out: [string, EntryType][] = [];
		for (const rec of all) {
			if (parentOf(rec.path) === norm && rec.path !== norm) {
				out.push([basenameOf(rec.path), rec.type]);
			}
		}
		return out;
	}

	async readFile(path: string): Promise<Uint8Array> {
		const rec = await this.get(path);
		if (!rec) throw new FileNotFound(path);
		if (rec.type !== 'file') throw new FileIsADirectory(path);
		return rec.data ?? new Uint8Array();
	}

	async writeFile(
		path: string,
		content: Uint8Array,
		options: { create: boolean; overwrite: boolean }
	): Promise<void> {
		await this.assertParent(path);
		const existing = await this.get(path);
		const now = Date.now();
		if (existing) {
			if (existing.type === 'directory') throw new FileIsADirectory(path);
			if (!options.overwrite) throw new FileExists(path);
			await this.put({ ...existing, data: content, mtime: now });
		} else {
			if (!options.create) throw new FileNotFound(path);
			await this.put({ path: normalize(path), type: 'file', data: content, ctime: now, mtime: now });
		}
	}

	async createDirectory(path: string): Promise<void> {
		await this.assertParent(path);
		const existing = await this.get(path);
		if (existing) throw new FileExists(path);
		const now = Date.now();
		await this.put({ path: normalize(path), type: 'directory', ctime: now, mtime: now });
	}

	async delete(path: string, options: { recursive: boolean }): Promise<void> {
		const rec = await this.get(path);
		if (!rec) throw new FileNotFound(path);
		if (rec.type === 'directory') {
			const children = await this.readDirectory(path);
			if (children.length > 0 && !options.recursive) throw new DirectoryNotEmpty(path);
			for (const [name] of children) {
				await this.delete(`${normalize(path)}/${name}`, { recursive: true });
			}
		}
		await this.remove(path);
	}

	async rename(
		oldPath: string,
		newPath: string,
		options: { overwrite: boolean }
	): Promise<void> {
		const rec = await this.get(oldPath);
		if (!rec) throw new FileNotFound(oldPath);
		const target = await this.get(newPath);
		if (target) {
			if (!options.overwrite) throw new FileExists(newPath);
			await this.delete(newPath, { recursive: true });
		}
		await this.assertParent(newPath);
		await this.put({ ...rec, path: normalize(newPath), mtime: Date.now() });
		// For directories, move children as well.
		if (rec.type === 'directory') {
			const oldNorm = normalize(oldPath);
			const newNorm = normalize(newPath);
			const db = await this.db();
			const tx = db.transaction(STORE, 'readonly');
			const all = (await promisifyRequest(tx.objectStore(STORE).getAll())) as Record[];
			for (const r of all) {
				if (r.path.startsWith(oldNorm + '/')) {
					const moved = r.path.replace(oldNorm, newNorm);
					await this.put({ ...r, path: moved, mtime: Date.now() });
					await this.remove(r.path);
				}
			}
		}
		await this.remove(oldPath);
	}
}
