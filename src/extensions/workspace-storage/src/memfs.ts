export class FileNotFound extends Error {
	constructor(p: string) {
		super(`File not found: ${p}`);
		this.name = 'FileNotFound';
	}
}
export class FileExists extends Error {
	constructor(p: string) {
		super(`File exists: ${p}`);
		this.name = 'FileExists';
	}
}
export class FileIsADirectory extends Error {
	constructor(p: string) {
		super(`File is a directory: ${p}`);
		this.name = 'FileIsADirectory';
	}
}
export class FileNotADirectory extends Error {
	constructor(p: string) {
		super(`File is not a directory: ${p}`);
		this.name = 'FileNotADirectory';
	}
}
export class DirectoryNotEmpty extends Error {
	constructor(p: string) {
		super(`Directory not empty: ${p}`);
		this.name = 'DirectoryNotEmpty';
	}
}

export type EntryType = 'file' | 'directory';

interface BaseEntry {
	name: string;
	ctime: number;
	mtime: number;
}
interface FileEntry extends BaseEntry {
	type: 'file';
	data: Uint8Array;
}
interface DirectoryEntry extends BaseEntry {
	type: 'directory';
	entries: Map<string, Entry>;
}
type Entry = FileEntry | DirectoryEntry;

export interface Stat {
	type: EntryType;
	size: number;
	ctime: number;
	mtime: number;
}

function splitPath(p: string): string[] {
	return p.split('/').filter((s) => s.length > 0);
}

export class MemFS {
	private root: DirectoryEntry = {
		type: 'directory',
		name: '',
		ctime: Date.now(),
		mtime: Date.now(),
		entries: new Map(),
	};

	private lookup(p: string): Entry {
		const parts = splitPath(p);
		let cur: Entry = this.root;
		for (const part of parts) {
			if (cur.type !== 'directory') {
				throw new FileNotADirectory(p);
			}
			const next = cur.entries.get(part);
			if (!next) {
				throw new FileNotFound(p);
			}
			cur = next;
		}
		return cur;
	}

	private lookupParent(p: string): DirectoryEntry {
		const parts = splitPath(p);
		parts.pop();
		let cur: Entry = this.root;
		for (const part of parts) {
			if (cur.type !== 'directory') {
				throw new FileNotADirectory(p);
			}
			const next = cur.entries.get(part);
			if (!next) {
				throw new FileNotFound(p);
			}
			cur = next;
		}
		if (cur.type !== 'directory') {
			throw new FileNotADirectory(p);
		}
		return cur;
	}

	private basename(p: string): string {
		const parts = splitPath(p);
		return parts[parts.length - 1] ?? '';
	}

	stat(p: string): Stat {
		const e = this.lookup(p);
		return {
			type: e.type,
			ctime: e.ctime,
			mtime: e.mtime,
			size: e.type === 'file' ? e.data.byteLength : 0,
		};
	}

	readDirectory(p: string): [string, EntryType][] {
		const e = this.lookup(p);
		if (e.type !== 'directory') throw new FileNotADirectory(p);
		return Array.from(e.entries.values()).map((en) => [en.name, en.type]);
	}

	readFile(p: string): Uint8Array {
		const e = this.lookup(p);
		if (e.type !== 'file') throw new FileIsADirectory(p);
		return e.data;
	}

	writeFile(p: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
		const name = this.basename(p);
		const parent = this.lookupParent(p);
		const existing = parent.entries.get(name);
		const now = Date.now();
		if (existing) {
			if (existing.type === 'directory') throw new FileIsADirectory(p);
			if (!options.overwrite) throw new FileExists(p);
			existing.data = content;
			existing.mtime = now;
		} else {
			if (!options.create) throw new FileNotFound(p);
			parent.entries.set(name, { type: 'file', name, ctime: now, mtime: now, data: content });
			parent.mtime = now;
		}
	}

	rename(oldPath: string, newPath: string, options: { overwrite: boolean }): void {
		const oldParent = this.lookupParent(oldPath);
		const oldName = this.basename(oldPath);
		const entry = oldParent.entries.get(oldName);
		if (!entry) throw new FileNotFound(oldPath);
		const newParent = this.lookupParent(newPath);
		const newName = this.basename(newPath);
		const target = newParent.entries.get(newName);
		if (target) {
			if (!options.overwrite) throw new FileExists(newPath);
		}
		oldParent.entries.delete(oldName);
		entry.name = newName;
		newParent.entries.set(newName, entry);
		const now = Date.now();
		oldParent.mtime = now;
		newParent.mtime = now;
	}

	delete(p: string, options: { recursive: boolean }): void {
		const parent = this.lookupParent(p);
		const name = this.basename(p);
		const entry = parent.entries.get(name);
		if (!entry) throw new FileNotFound(p);
		if (entry.type === 'directory' && !options.recursive && entry.entries.size > 0) {
			throw new DirectoryNotEmpty(p);
		}
		parent.entries.delete(name);
		parent.mtime = Date.now();
	}

	createDirectory(p: string): void {
		const name = this.basename(p);
		const parent = this.lookupParent(p);
		if (parent.entries.has(name)) throw new FileExists(p);
		const now = Date.now();
		parent.entries.set(name, {
			type: 'directory',
			name,
			ctime: now,
			mtime: now,
			entries: new Map(),
		});
		parent.mtime = now;
	}
}
