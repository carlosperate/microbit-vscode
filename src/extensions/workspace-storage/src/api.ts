/** What this extension exports, for the `ui` extension. Types only, so importing it bundles nothing. */
import type * as vscode from 'vscode';

import type { Storage } from './switch.js';

export interface StorageApi {
	storage(): Storage;
	onDidChangeStorage: vscode.Event<Storage>;
	/** Runs `task` once every earlier change to the project's files has finished. */
	exclusive<T>(task: () => Promise<T>): Promise<T>;
	/** Whether the temporary workspace holds work of the user's own. */
	scratchChanged(): Promise<boolean>;
	/** Swaps the temporary files for what `write` creates, and puts them back if it fails. */
	replaceScratch(write: () => Promise<void>): Promise<void>;
}
