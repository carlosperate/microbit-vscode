/**
 * The one workspace folder the window ever opens, served from whichever storage
 * is active: VS Code shows a folder swapped in place as a row under "Untitled
 * (Workspace)", so a switch swaps what is behind the folder instead. Pure.
 */
import { FileNotFound, type EntryType, type Stat } from './memfs.js';

/** What the three stores have in common, whether they answer at once or later. */
export interface Core {
	stat(p: string): Stat | Promise<Stat>;
	readDirectory(p: string): [string, EntryType][] | Promise<[string, EntryType][]>;
	readFile(p: string): Uint8Array | Promise<Uint8Array>;
	fileSize?(p: string): number | Promise<number>;
	writeFile(p: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): boolean | Promise<boolean>;
	rename(oldPath: string, newPath: string, options: { overwrite: boolean }): void | Promise<void>;
	delete(p: string, options: { recursive: boolean }): void | Promise<void>;
	createDirectory(p: string): void | Promise<void>;
}

/** A store and the folder in it that holds the project; empty for the store's root. */
export interface Backing {
	core: Core;
	base: string;
}

const join = (base: string, relative: string) => (relative ? `${base}/${relative}` : base || '/');

const FOLDER_STAT: Stat = { type: 'directory', size: 0, ctime: 0, mtime: 0 };

export class ActiveFS implements Core {
	constructor(
		private readonly folder: string,
		private backing: Backing
	) {}

	use(backing: Backing): void {
		this.backing = backing;
	}

	/** The store path for a workspace path, or undefined for `/`, which only lists the folder. */
	private map(p: string): string | undefined {
		const [folder, ...rest] = p.split('/').filter(Boolean);
		if (folder === undefined) return undefined;
		if (folder !== this.folder) throw new FileNotFound(p);
		return join(this.backing.base, rest.join('/'));
	}

	private inside(p: string): string {
		const mapped = this.map(p);
		if (mapped === undefined) throw new FileNotFound(p);
		return mapped;
	}

	async stat(p: string): Promise<Stat> {
		const mapped = this.map(p);
		return mapped === undefined ? FOLDER_STAT : this.backing.core.stat(mapped);
	}

	async readDirectory(p: string): Promise<[string, EntryType][]> {
		const mapped = this.map(p);
		return mapped === undefined ? [[this.folder, 'directory']] : this.backing.core.readDirectory(mapped);
	}

	async readFile(p: string): Promise<Uint8Array> {
		return this.backing.core.readFile(this.inside(p));
	}

	/** 0 where only reading the file would tell: search reads it next anyway, and checks then. */
	async fileSize(p: string): Promise<number> {
		return this.backing.core.fileSize?.(this.inside(p)) ?? 0;
	}

	async writeFile(p: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<boolean> {
		return this.backing.core.writeFile(this.inside(p), content, options);
	}

	async rename(oldPath: string, newPath: string, options: { overwrite: boolean }): Promise<void> {
		await this.backing.core.rename(this.inside(oldPath), this.inside(newPath), options);
	}

	async delete(p: string, options: { recursive: boolean }): Promise<void> {
		await this.backing.core.delete(this.inside(p), options);
	}

	async createDirectory(p: string): Promise<void> {
		await this.backing.core.createDirectory(this.inside(p));
	}
}

/** Every folder and file in a store's project folder, relative, each folder before its contents. */
async function walk(backing: Backing, relative = ''): Promise<[string, EntryType][]> {
	const entries: [string, EntryType][] = [];
	for (const [name, type] of await backing.core.readDirectory(join(backing.base, relative))) {
		const path = relative ? `${relative}/${name}` : name;
		entries.push([path, type]);
		if (type === 'directory') entries.push(...(await walk(backing, path)));
	}
	return entries;
}

export const listPaths = async (backing: Backing): Promise<string[]> => (await walk(backing)).map(([path]) => path);

/** Every file's text by relative path, to tell later whether anything changed. */
export async function snapshot(backing: Backing): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const [path, type] of await walk(backing)) {
		if (type === 'file') files.set(path, new TextDecoder().decode(await backing.core.readFile(join(backing.base, path))));
	}
	return files;
}

// Awaited inside a try, as the in-memory store throws at once rather than rejecting.
async function exists(core: Core, p: string): Promise<boolean> {
	try {
		await core.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Merges one store's project into another's; without `overwrite`, a file already there is kept. */
export async function copyBacking(from: Backing, to: Backing, overwrite: boolean): Promise<void> {
	for (const [path, type] of await walk(from)) {
		const target = join(to.base, path);
		// A file that is overwritten anyway needs no look at what is there.
		if (!(type === 'file' && overwrite) && (await exists(to.core, target))) continue;
		if (type === 'directory') await to.core.createDirectory(target);
		else await to.core.writeFile(target, await from.core.readFile(join(from.base, path)), { create: true, overwrite: true });
	}
}

export async function ensureBase(backing: Backing): Promise<void> {
	if (backing.base && !(await exists(backing.core, backing.base))) await backing.core.createDirectory(backing.base);
}

export async function clearBacking(backing: Backing): Promise<void> {
	for (const [name] of await backing.core.readDirectory(join(backing.base, ''))) {
		await backing.core.delete(join(backing.base, name), { recursive: true });
	}
}

/** Leaves `to` holding exactly what `from` holds. */
export async function replaceBacking(from: Backing, to: Backing): Promise<void> {
	await ensureBase(to);
	await clearBacking(to);
	await copyBacking(from, to, true);
}
