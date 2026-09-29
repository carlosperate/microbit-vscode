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
import { ActiveFS, clearBacking, copyBacking, ensureBase, listPaths, replaceBacking, snapshot, type Backing, type Core } from './active.js';
import type { StorageApi } from './api.js';
import { closeEditors, closeUnsavedOthers, isInside, settleUnsaved } from './folders.js';
import { IdbFS } from './idbfs.js';
import { LocalFS } from './localfs.js';
import { WorkspaceFileSearchProvider, WorkspaceTextSearchProvider } from './search.js';
import { switchPlan, untouched, type Storage, type SwitchPlan } from './switch.js';


// Injected at build time by `esbuild.config.mjs` via esbuild's `define`
// option. Each entry is a path relative to `welcome-workspace/` plus
// its UTF-8 contents. Empty array if `welcome-workspace/` is missing or empty.
declare const __WELCOME_FILES__: ReadonlyArray<{ path: string; contents: string }>;

// The one folder the window opens, as `config/product.template.json` names it.
const SCHEME = 'microbit';
const FOLDER = 'Project';
const ROOT = vscode.Uri.from({ scheme: SCHEME, path: `/${FOLDER}` });

// Where memfs keeps the project, and what a mode replaced. These names never reach the Explorer.
const WELCOME_ROOT = '/Welcome workspace';
const REPLACED_ROOT = '/Replaced workspace';

const TAGS: Record<Exclude<Storage, 'localfs'>, string> = { memfs: 'Temporary', idbfs: 'Browser storage' };

/** The temporary workspace as the IDE last left it; undefined once it holds the user's own files. */
let pristine: Map<string, string> | undefined = new Map(__WELCOME_FILES__.map((file) => [file.path, file.contents]));

const WARNINGS: Record<NonNullable<SwitchPlan['warning']>, { message: string; detail: string; accept: string }> = {
	loseScratch: {
		message: 'Open a folder on your computer?',
		detail: 'The changes in this temporary workspace will be lost. To keep them, switch to browser storage first.',
		accept: 'Open folder',
	},
	browserToScratch: {
		message: 'Switch to temporary storage?',
		detail: 'Your files are copied across, but temporary storage is emptied when the IDE closes. Stay in browser storage to find them here next time.',
		accept: 'Switch',
	},
	browserToFolder: {
		message: 'Open a folder on your computer?',
		detail: 'Your files stay saved in this browser, but from now on the IDE opens that folder instead. Stay in browser storage to find them here next time.',
		accept: 'Open folder',
	},
};

async function confirmSwitch(warning: keyof typeof WARNINGS): Promise<boolean> {
	const { message, detail, accept } = WARNINGS[warning];
	return (await vscode.window.showWarningMessage(message, { modal: true, detail }, accept)) === accept;
}

function seedWelcome(memfs: MemFS): void {
	try {
		memfs.createDirectory(WELCOME_ROOT);
	} catch {
		// Already exists (e.g. seeded by a previous activate in the same
		// session). Safe to ignore, we still overwrite individual files below.
	}
	const encoder = new TextEncoder();
	for (const file of __WELCOME_FILES__) {
		const parts = file.path.split('/');
		// Ensure every intermediate directory exists.
		for (let i = 0; i < parts.length - 1; i++) {
			const dirPath = `${WELCOME_ROOT}/${parts.slice(0, i + 1).join('/')}`;
			try {
				memfs.createDirectory(dirPath);
			} catch {
				/* already exists */
			}
		}
		const filePath = `${WELCOME_ROOT}/${file.path}`;
		memfs.writeFile(filePath, encoder.encode(file.contents), {
			create: true,
			overwrite: true,
		});
	}
}

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

	constructor(private readonly core: Core) {}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	/** For changes that did not come through this provider, such as another storage taking over. */
	announce(events: vscode.FileChangeEvent[]): void {
		if (events.length) this._emitter.fire(events);
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
			// A new file reported as Changed is invisible to any watcher built with
			// `ignoreCreateEvents: false, ignoreChangeEvents: true`, which is how an
			// extension watches for a file appearing.
			const created = await Promise.resolve(this.core.writeFile(uri.path, content, options));
			this.fire(uri, created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed);
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

// Two small databases shared with public/index.html, each one store of a few values. The session's
// `storage` is the one in use, its `start` the one the page chose to open.
const HANDLES = { db: 'microbit-local-handle', store: 'handles' };
const SESSION = { db: 'microbit-session', store: 'session' };

/** One request against one of those stores, which is created on first use. */
function inStore<T>(where: typeof SESSION, mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(where.db, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(where.store);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const asked = request(open.result.transaction(where.store, mode).objectStore(where.store));
			asked.onsuccess = () => resolve(asked.result);
			asked.onerror = () => reject(asked.error);
			open.result.close();
		};
	});
}

const readStored = (where: typeof SESSION, key: string): Promise<unknown> =>
	inStore(where, 'readonly', (store) => store.get(key)).catch(() => undefined);

const loadStoredHandle = () => readStored(HANDLES, 'root') as Promise<FileSystemDirectoryHandle | undefined>;

function rememberStorage(storage: Storage): void {
	inStore(SESSION, 'readwrite', (store) => store.put(storage, 'storage')).catch(() =>
		console.warn('micro:bit IDE: the storage in use was not remembered')
	);
}

export async function activate(context: vscode.ExtensionContext): Promise<StorageApi> {
	const memfs = new MemFS();
	const idbfs = new IdbFS();
	const localfs = new LocalFS();

	// Seed the welcome workspace into memfs. The manifest is generated at build
	// time by walking the repo-root `welcome-workspace/` directory (see
	// `esbuild.config.mjs`); memfs is wiped on every reload so this
	// rewrites the full tree on each activation. Cheap, ~kb of data.
	seedWelcome(memfs);

	const backings: Record<Storage, Backing> = {
		memfs: { core: memfs, base: WELCOME_ROOT },
		// The database's root, where the files of earlier versions of this IDE already are.
		idbfs: { core: idbfs, base: '' },
		localfs: { core: localfs, base: '' },
	};
	// The temporary files a mode is replacing, held until the mode's own are in place.
	const replaced: Backing = { core: memfs, base: REPLACED_ROOT };

	// The page chooses, as it has to know before VS Code loads whether to start it afresh.
	const started = await readStored(SESSION, 'start');
	let storage: Storage = started === 'idbfs' ? 'idbfs' : 'memfs';
	// A folder picked in an earlier session has to be back, with access, before it is served.
	if (started === 'localfs') {
		const handle = await loadStoredHandle();
		try {
			if (handle && (await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') {
				localfs.setRoot(handle);
				storage = 'localfs';
			}
		} catch {
			/* ignore */
		}
	}
	await ensureBase(backings[storage]);
	const active = new ActiveFS(FOLDER, backings[storage]);
	const adapter = new FsAdapter(active);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, adapter, { isCaseSensitive: true }));

	// Serving files is not enough: without these, `workspace.findFiles` never
	// settles and the Search view finds nothing. Both are proposed API, and
	// registering one the host has not enabled throws, so a mismatch costs
	// search rather than the workspace and every command below it.
	try {
		context.subscriptions.push(
			vscode.workspace.registerFileSearchProvider(SCHEME, new WorkspaceFileSearchProvider(SCHEME, active)),
			vscode.workspace.registerTextSearchProvider(SCHEME, new WorkspaceTextSearchProvider(SCHEME, active))
		);
	} catch (e) {
		console.warn(`micro:bit IDE: no workspace search (${String(e)})`);
	}

	// The folder's name never changes, so the tag after it is what says which storage is behind it.
	let tag: vscode.Disposable | undefined;
	function showStorage(): void {
		tag?.dispose();
		try {
			tag = vscode.workspace.registerResourceLabelFormatter({
				scheme: SCHEME,
				formatting: {
					label: '${path}',
					separator: '/',
					workspaceSuffix: storage === 'localfs' ? localfs.rootName() : TAGS[storage],
				},
			});
		} catch (e) {
			console.warn(`micro:bit IDE: the storage is not named in the Explorer (${String(e)})`);
		}
	}
	context.subscriptions.push({ dispose: () => tag?.dispose() });
	showStorage();
	rememberStorage(storage);

	async function scratchChanged(): Promise<boolean> {
		if (storage === 'memfs' && vscode.workspace.textDocuments.some((doc) => doc.isDirty && isInside(doc.uri, ROOT))) return true;
		return !pristine || !untouched(pristine, await snapshot(backings.memfs));
	}

	/** The page answers, as only it can see whether the browser has a folder picker. */
	async function canPickLocalFolder(): Promise<boolean> {
		const able = await Promise.resolve(vscode.commands.executeCommand<boolean>('microbitIde._canPickLocalFolderHost')).catch(() => false);
		if (able !== true) {
			void vscode.window.showErrorMessage('This browser cannot open a folder on your computer.', {
				modal: true,
				detail: 'That needs a Chromium-based browser, such as Chrome or Edge. In this browser, use browser storage to keep your files.',
			});
		}
		return able === true;
	}

	async function pickLocalFolder(): Promise<boolean> {
		// `showDirectoryPicker` is window-only, so the page picks the folder and
		// stores its handle in IndexedDB for this worker to read back.
		let ok: boolean;
		try {
			ok = (await vscode.commands.executeCommand<boolean>('microbitIde._pickLocalFolderHost')) === true;
		} catch (e: any) {
			vscode.window.showErrorMessage('Failed to invoke folder picker: ' + (e?.message ?? String(e)));
			return false;
		}
		if (!ok) return false; // unsupported browser, user cancelled, or persistence failed

		const handle = await loadStoredHandle();
		if (!handle) {
			vscode.window.showErrorMessage('Folder picked but handle could not be retrieved.');
			return false;
		}
		try {
			const perm = await handle.queryPermission?.({ mode: 'readwrite' });
			if (perm !== 'granted') {
				vscode.window.showErrorMessage('Read/write permission not granted for the picked folder.');
				return false;
			}
		} catch {
			/* old browsers without queryPermission, assume granted */
		}
		localfs.setRoot(handle);
		return true;
	}

	const uriOf = (path: string) => vscode.Uri.joinPath(ROOT, path);
	const changed = new vscode.EventEmitter<Storage>();

	/** Asks first and picks the folder next, so declining either leaves everything as it was. */
	async function switchStorage(to: Storage): Promise<void> {
		const from = storage;
		// Only a local folder can be switched to again, for another folder.
		if (to === from && to !== 'localfs') return;
		// Said before any other question, so nobody confirms a switch that cannot happen.
		if (to === 'localfs' && !(await canPickLocalFolder())) return;
		const plan = switchPlan(from, to, from === 'memfs' && (await scratchChanged()));
		if (plan.warning && !(await confirmSwitch(plan.warning))) return;

		const before = await listPaths(backings[from]);
		// Edits to keep are saved where they were made. Edits to lose go only once the folder is picked.
		if (!plan.discard && !(await settleUnsaved(ROOT, 'save'))) {
			void vscode.window.showErrorMessage('A file could not be saved, so the storage was not switched.');
			return;
		}
		// Before the folder is picked, as a save after it could land in the new one.
		if (!(await closeUnsavedOthers(ROOT))) return;
		if (to === 'localfs' && !(await pickLocalFolder())) return;
		if (plan.discard) await settleUnsaved(ROOT, 'discard');
		const target = backings[to];
		await ensureBase(target);
		if (plan.replace) await clearBacking(target);
		if (plan.copy) await copyBacking(backings[from], target, plan.overwrite);
		// Copied in from elsewhere, the temporary workspace now holds the user's own files.
		if (to === 'memfs' && plan.copy) pristine = undefined;

		storage = to;
		active.use(target);
		showStorage();
		rememberStorage(to);
		changed.fire(to);

		await showFiles(before, await listPaths(target));
	}

	/** Same folder, other files: tabs whose file is still there stay open and reload. */
	async function showFiles(before: string[], after: string[]): Promise<void> {
		const was = new Set(before);
		const now = new Set(after);
		await closeEditors(ROOT, (path) => now.has(path));
		adapter.announce([
			...before.filter((path) => !now.has(path)).map((path) => ({ type: vscode.FileChangeType.Deleted, uri: uriOf(path) })),
			...after.map((path) => ({
				type: was.has(path) ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
				uri: uriOf(path),
			})),
		]);
	}

	/** For a mode, inside its turn: the temporary files make way for what `write` creates, or come back. */
	async function replaceScratch(write: () => Promise<void>): Promise<void> {
		// Saved rather than reverted, so putting the files back brings the edits too.
		if (!(await settleUnsaved(ROOT, 'save'))) await settleUnsaved(ROOT, 'discard');
		if (!(await closeUnsavedOthers(ROOT))) throw new Error('An unsaved editor was left open, so no files were replaced.');
		const before = await listPaths(backings.memfs);
		await replaceBacking(backings.memfs, replaced);
		try {
			await clearBacking(backings.memfs);
			await showFiles(before, []);
			await write();
			pristine = await snapshot(backings.memfs);
		} catch (error) {
			const written = await listPaths(backings.memfs);
			await replaceBacking(replaced, backings.memfs);
			await showFiles(written, before);
			throw error;
		} finally {
			await clearBacking(replaced);
		}
	}

	// A storage switch and a mode both replace the project's files, so each waits for the one before.
	let last: Promise<unknown> = Promise.resolve();
	function exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = last.then(task);
		last = run.catch(() => undefined);
		return run;
	}
	const switchTo = (to: Storage) => exclusive(() => switchStorage(to));

	context.subscriptions.push(
		changed,
		vscode.commands.registerCommand('microbitIde.switchStorage', async () => {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'Temporary storage', description: 'cleared when you close the tab', storage: 'memfs' as const },
					{ label: 'Browser storage', description: 'saved in this browser', storage: 'idbfs' as const },
					{ label: 'Local folder', description: 'a folder on your computer, in Chrome or Edge', storage: 'localfs' as const },
				],
				{ placeHolder: 'Where should the project files be kept?' }
			);
			if (pick) await switchTo(pick.storage);
		}),
		vscode.commands.registerCommand('microbitIde.openLocalFolder', () => switchTo('localfs')),
		vscode.commands.registerCommand('microbitIde.useBrowserStorage', () => switchTo('idbfs')),
		vscode.commands.registerCommand('microbitIde.useTemporaryStorage', () => switchTo('memfs'))
	);

	return { storage: () => storage, onDidChangeStorage: changed.event, exclusive, scratchChanged, replaceScratch };
}

export function deactivate(): void {
	/* no-op */
}
