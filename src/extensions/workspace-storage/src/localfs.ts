import {
	FileNotFound,
	FileExists,
	FileIsADirectory,
	FileNotADirectory,
	DirectoryNotEmpty,
	type EntryType,
	type Stat,
} from './memfs.js';

// Browser API typings (subset; not in older lib.dom.d.ts).
type FSHandle = FileSystemDirectoryHandle | FileSystemFileHandle;
interface FileSystemDirectoryHandle {
	kind: 'directory';
	name: string;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterableIterator<FSHandle>;
	queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
	requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}
interface FileSystemFileHandle {
	kind: 'file';
	name: string;
	getFile(): Promise<File>;
	createWritable(): Promise<FileSystemWritableFileStream>;
}
interface FileSystemWritableFileStream extends WritableStream {
	write(data: BufferSource | Blob | string): Promise<void>;
	close(): Promise<void>;
}

function splitPath(p: string): string[] {
	return p.split('/').filter((s) => s.length > 0);
}

/**
 * FileSystemProvider backed by the browser's File System Access API
 * (Chromium-only). Persists the user-selected directory handle in IndexedDB
 * so the workspace can be re-opened after a reload (subject to a permission
 * prompt).
 */
export class LocalFS {
	private root: FileSystemDirectoryHandle | undefined;

	setRoot(handle: FileSystemDirectoryHandle): void {
		this.root = handle;
	}

	hasRoot(): boolean {
		return !!this.root;
	}

	private requireRoot(): FileSystemDirectoryHandle {
		if (!this.root) throw new FileNotFound('/ (no folder selected)');
		return this.root;
	}

	private async resolveDir(parts: string[]): Promise<FileSystemDirectoryHandle> {
		let dir = this.requireRoot();
		for (const part of parts) {
			try {
				dir = await dir.getDirectoryHandle(part);
			} catch (e: any) {
				if (e?.name === 'NotFoundError') throw new FileNotFound(parts.join('/'));
				if (e?.name === 'TypeMismatchError') throw new FileNotADirectory(parts.join('/'));
				throw e;
			}
		}
		return dir;
	}

	private async resolveEntry(p: string): Promise<FSHandle> {
		const parts = splitPath(p);
		if (parts.length === 0) return this.requireRoot();
		const name = parts.pop()!;
		const parent = await this.resolveDir(parts);
		try {
			return await parent.getFileHandle(name);
		} catch {
			try {
				return await parent.getDirectoryHandle(name);
			} catch (e: any) {
				if (e?.name === 'NotFoundError') throw new FileNotFound(p);
				throw e;
			}
		}
	}

	async stat(p: string): Promise<Stat> {
		const entry = await this.resolveEntry(p);
		if (entry.kind === 'directory') {
			return { type: 'directory', size: 0, ctime: 0, mtime: 0 };
		}
		const file = await entry.getFile();
		return {
			type: 'file',
			size: file.size,
			ctime: 0,
			mtime: file.lastModified,
		};
	}

	async readDirectory(p: string): Promise<[string, EntryType][]> {
		const dir = await this.resolveDir(splitPath(p));
		const out: [string, EntryType][] = [];
		for await (const entry of dir.values()) {
			out.push([entry.name, entry.kind === 'directory' ? 'directory' : 'file']);
		}
		return out;
	}

	async readFile(p: string): Promise<Uint8Array> {
		const entry = await this.resolveEntry(p);
		if (entry.kind !== 'file') throw new FileIsADirectory(p);
		const file = await entry.getFile();
		return new Uint8Array(await file.arrayBuffer());
	}

	async writeFile(
		p: string,
		content: Uint8Array,
		options: { create: boolean; overwrite: boolean }
	): Promise<void> {
		const parts = splitPath(p);
		const name = parts.pop();
		if (!name) throw new FileNotFound(p);
		const parent = await this.resolveDir(parts);
		let existing: FileSystemFileHandle | undefined;
		try {
			existing = await parent.getFileHandle(name);
		} catch {
			/* not present */
		}
		if (existing) {
			if (!options.overwrite) throw new FileExists(p);
		} else if (!options.create) {
			throw new FileNotFound(p);
		}
		const handle = await parent.getFileHandle(name, { create: true });
		const writable = await handle.createWritable();
		await writable.write(content);
		await writable.close();
	}

	async createDirectory(p: string): Promise<void> {
		const parts = splitPath(p);
		const name = parts.pop();
		if (!name) throw new FileExists(p);
		const parent = await this.resolveDir(parts);
		try {
			await parent.getDirectoryHandle(name);
			throw new FileExists(p);
		} catch (e: any) {
			if (e instanceof FileExists) throw e;
			// Not found is the expected case; create it.
		}
		await parent.getDirectoryHandle(name, { create: true });
	}

	async delete(p: string, options: { recursive: boolean }): Promise<void> {
		const parts = splitPath(p);
		const name = parts.pop();
		if (!name) throw new FileNotFound(p);
		const parent = await this.resolveDir(parts);
		try {
			await parent.removeEntry(name, { recursive: options.recursive });
		} catch (e: any) {
			if (e?.name === 'NotFoundError') throw new FileNotFound(p);
			if (e?.name === 'InvalidModificationError') throw new DirectoryNotEmpty(p);
			throw e;
		}
	}

	async rename(
		oldPath: string,
		newPath: string,
		options: { overwrite: boolean }
	): Promise<void> {
		// File System Access API has no native rename; emulate by copy + delete.
		const bytes = await this.readFile(oldPath);
		await this.writeFile(newPath, bytes, { create: true, overwrite: options.overwrite });
		await this.delete(oldPath, { recursive: false });
	}
}
