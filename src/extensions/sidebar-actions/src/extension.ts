import * as vscode from 'vscode';

const VIEW_ID = 'microbitIde.sidebarActions';

const COMMANDS = [
	'microbitIde.sidebarActions.buildAndFlash',
	'microbitIde.sidebarActions.openSerialTerminal',
	'microbitIde.sidebarActions.showAllActions',
];

const EXPANDED_ONCE = 'microbitIde.sidebarActions.expandedOnce';

export function activate(context: vscode.ExtensionContext): void {
	// The rows are welcome content, written in the manifest. VS Code shows it only
	// over a tree that has a provider and no children; with no provider the view
	// says so instead, and the content never appears.
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider<vscode.TreeItem>(VIEW_ID, {
			getChildren: () => [],
			getTreeItem: (item) => item,
		})
	);

	for (const command of COMMANDS) {
		context.subscriptions.push(vscode.commands.registerCommand(command, () => {}));
	}

	// VS Code forces any extension view in the Explorer to start collapsed, so
	// opening it takes a command. Once only: a later collapse is the user's.
	if (!context.globalState.get<boolean>(EXPANDED_ONCE)) {
		void context.globalState.update(EXPANDED_ONCE, true);
		void vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
	}
}

export function deactivate(): void {}
