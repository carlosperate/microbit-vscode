import * as vscode from 'vscode';
import {
	MemFS,
	FileNotFound,
	FileExists,
	FileIsADirectory,
	FileNotADirectory,
	DirectoryNotEmpty,
	type Stat,
	type EntryType,
} from './memfs.js';
import { IdbFS } from './idbfs.js';
import { LocalFS } from './localfs.js';

type CoreFS = MemFS | IdbFS | LocalFS;

function toVscodeError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
	if (err instanceof FileNotFound) return vscode.FileSystemError.FileNotFound(uri);
	if (err instanceof FileExists) return vscode.FileSystemError.FileExists(uri);
	if (err instanceof FileIsADirectory) return vscode.FileSystemError.FileIsADirectory(uri);
	if (err instanceof FileNotADirectory) return vscode.FileSystemError.FileNotADirectory(uri);
	if (err instanceof DirectoryNotEmpty) return new vscode.FileSystemError(`Directory not empty: ${uri.path}`);
	return err instanceof Error ? new vscode.FileSystemError(err.message) : new vscode.FileSystemError(String(err));
}

function toFileType(type: EntryType): vscode.FileType {
	return type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File;
}

class FsAdapter implements vscode.FileSystemProvider {
	private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this._emitter.event;

	constructor(private readonly core: CoreFS) {}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
		this._emitter.fire([{ type, uri }]);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		try {
			const s: Stat = await Promise.resolve(this.core.stat(uri.path));
			return {
				type: toFileType(s.type),
				ctime: s.ctime,
				mtime: s.mtime,
				size: s.size,
			};
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		try {
			const entries = await Promise.resolve(this.core.readDirectory(uri.path));
			return entries.map(([name, type]) => [name, toFileType(type)]);
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		try {
			return await Promise.resolve(this.core.readFile(uri.path));
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}

	async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { create: boolean; overwrite: boolean }
	): Promise<void> {
		try {
			await Promise.resolve(this.core.writeFile(uri.path, content, options));
			this.fire(uri, vscode.FileChangeType.Changed);
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}

	async rename(
		oldUri: vscode.Uri,
		newUri: vscode.Uri,
		options: { overwrite: boolean }
	): Promise<void> {
		try {
			await Promise.resolve(this.core.rename(oldUri.path, newUri.path, options));
			this.fire(oldUri, vscode.FileChangeType.Deleted);
			this.fire(newUri, vscode.FileChangeType.Created);
		} catch (e) {
			throw toVscodeError(e, oldUri);
		}
	}

	async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
		try {
			await Promise.resolve(this.core.delete(uri.path, options));
			this.fire(uri, vscode.FileChangeType.Deleted);
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		try {
			await Promise.resolve(this.core.createDirectory(uri.path));
			this.fire(uri, vscode.FileChangeType.Created);
		} catch (e) {
			throw toVscodeError(e, uri);
		}
	}
}

const HANDLE_STORE_DB = 'microbit-local-handle';
const HANDLE_KEY = 'root';

async function loadStoredHandle(): Promise<FileSystemDirectoryHandle | undefined> {
	return new Promise((resolve) => {
		const req = indexedDB.open(HANDLE_STORE_DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore('handles');
		req.onerror = () => resolve(undefined);
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction('handles', 'readonly');
			const get = tx.objectStore('handles').get(HANDLE_KEY);
			get.onsuccess = () => resolve(get.result as FileSystemDirectoryHandle | undefined);
			get.onerror = () => resolve(undefined);
		};
	});
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const memfs = new MemFS();
	const idbfs = new IdbFS();
	const localfs = new LocalFS();

	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('memfs', new FsAdapter(memfs), {
			isCaseSensitive: true,
		}),
		vscode.workspace.registerFileSystemProvider('idbfs', new FsAdapter(idbfs), {
			isCaseSensitive: true,
		}),
		vscode.workspace.registerFileSystemProvider('localfs', new FsAdapter(localfs), {
			isCaseSensitive: true,
		})
	);

	// Restore a previously-picked local folder handle BEFORE activation
	// resolves, so the workbench doesn't try to enumerate `localfs:/` against
	// an empty LocalFS instance after a reload.
	const handle = await loadStoredHandle();
	if (handle) {
		try {
			const perm = await handle.queryPermission?.({ mode: 'readwrite' });
			if (perm === 'granted') {
				localfs.setRoot(handle);
			}
		} catch {
			/* ignore */
		}
	}

	// Swap the (single) workspace root in-place. We use
	// `updateWorkspaceFolders` instead of `vscode.openFolder` because the
	// latter routes through vscode-web's `hostService.openWindow` → default
	// `workspaceProvider.open` (no-op) path, which can fall into
	// `pickFolderAndOpen` and throw "Can't open folders" for non-`file`
	// schemes, AND wouldn't reload the workbench anyway. The
	// `updateWorkspaceFolders` API rebinds the workspace folder without a
	// reload, preserving tabs/layout.
	//
	// Return `true` if the workspace is now rooted at `uri` (including the
	// short-circuit case where it already was). Only `false` if VS Code
	// rejected a real change.
	function setWorkspaceRoot(uri: vscode.Uri): boolean {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 1 && folders[0].uri.toString() === uri.toString()) {
			return true; // already rooted here; updateWorkspaceFolders would no-op-and-return-false
		}
		return vscode.workspace.updateWorkspaceFolders(0, folders.length, { uri });
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('microbit.switchStorage', async () => {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'memfs:// (ephemeral)', scheme: 'memfs' },
					{ label: 'idbfs:// (persistent in this browser)', scheme: 'idbfs' },
					{ label: 'localfs:// (real folder on disk, Chromium-only)', scheme: 'localfs' },
				],
				{ placeHolder: 'Pick a workspace storage backend' }
			);
			if (!pick) return;
			if (pick.scheme === 'localfs' && !localfs.hasRoot()) {
				await vscode.commands.executeCommand('microbit.openLocalFolder');
				return;
			}
			if (!setWorkspaceRoot(vscode.Uri.parse(`${pick.scheme}:/`))) {
				vscode.window.showErrorMessage(`Failed to switch workspace to ${pick.scheme}://`);
			}
		}),
		vscode.commands.registerCommand('microbit.openLocalFolder', async () => {
			// `showDirectoryPicker` is window-only; the extension host runs in a
			// Web Worker that has no `window`. We delegate to a host-side command
			// registered via `IWorkbenchConstructionOptions.commands` in
			// `public/index.html`. That handler picks the folder, persists the
			// handle to IndexedDB, and returns success.
			let ok: boolean;
			try {
				ok = (await vscode.commands.executeCommand<boolean>(
					'microbit._pickLocalFolderHost'
				)) === true;
			} catch (e: any) {
				vscode.window.showErrorMessage(
					'Failed to invoke folder picker: ' + (e?.message ?? String(e))
				);
				return;
			}
			if (!ok) return; // unsupported browser, user cancelled, or persistence failed

			// Pull the just-saved handle back out of IndexedDB and install it on
			// the worker-side `LocalFS` instance so reads/writes work immediately.
			const handle = await loadStoredHandle();
			if (!handle) {
				vscode.window.showErrorMessage('Folder picked but handle could not be retrieved.');
				return;
			}
			try {
				const perm = await handle.queryPermission?.({ mode: 'readwrite' });
				if (perm !== 'granted') {
					vscode.window.showErrorMessage('Read/write permission not granted for the picked folder.');
					return;
				}
			} catch {
				/* old browsers without queryPermission — assume granted */
			}
			localfs.setRoot(handle);
			if (!setWorkspaceRoot(vscode.Uri.parse('localfs:/'))) {
				vscode.window.showErrorMessage('Failed to switch workspace to localfs://');
			}
		})
	);
}

export function deactivate(): void {
	/* no-op */
}
