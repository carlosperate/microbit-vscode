/** The editors of the workspace's files, around a change of what is behind them. */
import * as vscode from 'vscode';

export const isInside = (uri: vscode.Uri, root: vscode.Uri) =>
	uri.scheme === root.scheme && uri.path.startsWith(root.path.endsWith('/') ? root.path : `${root.path}/`);

/**
 * Saved, or discarded, first: an edit left unsaved would be applied to the wrong
 * storage's file. False when a save failed, which leaves that edit in its editor.
 */
export async function settleUnsaved(root: vscode.Uri, unsaved: 'save' | 'discard'): Promise<boolean> {
	for (const document of vscode.workspace.textDocuments.filter((doc) => doc.isDirty && isInside(doc.uri, root))) {
		if (unsaved === 'save') {
			const saved = await Promise.resolve(document.save()).catch(() => false);
			if (!saved) return false;
		} else {
			await vscode.window.showTextDocument(document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	}
	return true;
}

/** The files a tab shows: two for a diff, none for a webview or a terminal. */
function tabUris(input: unknown): vscode.Uri[] {
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
		return [input.uri];
	}
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return [input.original, input.modified];
	}
	return [];
}

const tabsUnder = (root: vscode.Uri) =>
	vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tabUris(tab.input).some((uri) => isInside(uri, root)));

/**
 * Only a text document can be saved or reverted from here, so any other unsaved
 * editor is closed while its file is still the one it edited, and VS Code asks
 * what to do with it. False when the user keeps one open.
 */
export async function closeUnsavedOthers(root: vscode.Uri): Promise<boolean> {
	const tabs = tabsUnder(root).filter(
		(tab) => tab.isDirty && !(tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTextDiff)
	);
	return tabs.length === 0 || vscode.window.tabGroups.close(tabs);
}

/** Closes the editors of files under `root`, except the text editors whose path from it `keep` accepts. */
export async function closeEditors(root: vscode.Uri, keep: (path: string) => boolean): Promise<void> {
	// Only a text editor reloads when its file changes behind it, so only one of those can stay.
	const kept = (input: unknown) => input instanceof vscode.TabInputText && keep(input.uri.path.slice(root.path.length + 1));
	await vscode.window.tabGroups.close(tabsUnder(root).filter((tab) => !kept(tab.input)));
}
