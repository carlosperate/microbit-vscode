import type { MicrobitManagerApi } from 'vscode-bbcmicrobit-manager-api';
import * as vscode from 'vscode';

import { detectLanguage, scanSignals, type Entry, type Language, type ReadDirectory } from './detect';
import { compatibleApiVersion } from './managerVersion';

const MANAGER_EXTENSION = 'carlosperate.bbcmicrobit-manager';
const MANAGER_API_VERSION = '0.3.0';

const VIEW_ID = 'microbitIde.sidebarActions';
const EXPANDED_ONCE = 'microbitIde.sidebarActions.expandedOnce';
const WELCOME_SHOWN = 'microbitIde.sidebarActions.welcomeShown';
const SIZES_SETTLED = 'microbitIde.sidebarActions.sizesSettled';
const WELCOME_VIEW_TYPE = 'microbitIde.welcome';

// The welcome page's markup, inlined at build time by `esbuild.config.mjs`.
declare const __WELCOME_HTML__: string;

/** The page can ask for these and nothing else, so its markup can never widen what it reaches. */
const WELCOME_COMMANDS = new Set([
	'microbitIde.sidebarActions.buildAndFlash',
	'microbitIde.sidebarActions.openSerialTerminal',
	'microbitIde.sidebarActions.createProject',
	'microbitIde.openLocalFolder',
	'microbitIde.switchStorage',
	'bbcmicrobit-micropython.openSimulator',
]);

/** The six themes `carlosperate.microbit-themes` ships, by the label `workbench.colorTheme` takes. */
const WELCOME_THEMES = new Set([
	'micro:bit Pixel Light',
	'micro:bit Pixel Dark',
	'micro:bit Spark Light',
	'micro:bit Spark Dark',
	'micro:bit Halo Light',
	'micro:bit Halo Dark',
]);

/**
 * An answer given to the picker, for this run of the IDE only. A workspace URI
 * outlives the project in it, so a stored answer would follow a folder into
 * whatever the user opens there next week. The pin button writes the setting.
 */
let answered: Language | undefined;

/**
 * The language extensions own building and the manager owns the board, so every
 * button here is a command someone else registered. Each is checked for before
 * it runs, never assumed from which app we are in.
 */
const LANGUAGES: Record<Language, { label: string; detail: string; flash: string; create: string }> = {
	micropython: {
		label: 'MicroPython',
		detail: 'Python files flashed onto the board',
		flash: 'bbcmicrobit-micropython.flash',
		create: 'bbcmicrobit-micropython.createProject',
	},
	cpp: {
		label: 'C++',
		detail: 'C++ sources compiled with CODAL',
		flash: 'bbcmicrobit-cpp.flash',
		create: 'bbcmicrobit-cpp.createProject',
	},
};

const OPEN_TERMINAL = 'bbcmicrobit-manager.openTerminal';
const SHOW_MENU = 'bbcmicrobit-manager.showMenu';

const fail = (message: string) => void vscode.window.showErrorMessage(`BBC micro:bit IDE: ${message}`);
const warn = (message: string) => void vscode.window.showWarningMessage(`BBC micro:bit IDE: ${message}`);

/** Fetched once per action: it is a round trip to the main thread, not a local lookup. */
const registeredCommands = async () => new Set(await vscode.commands.getCommands(true));

export function activate(context: vscode.ExtensionContext): void {
	// Welcome content requires a registered, empty tree provider.
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider<vscode.TreeItem>(VIEW_ID, {
			getChildren: () => [],
			getTreeItem: (item) => item,
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('microbitIde.sidebarActions.buildAndFlash', () => buildAndFlash()),
		vscode.commands.registerCommand('microbitIde.sidebarActions.openSerialTerminal', () => run(OPEN_TERMINAL)),
		vscode.commands.registerCommand('microbitIde.sidebarActions.showAllActions', () => run(SHOW_MENU)),
		vscode.commands.registerCommand('microbitIde.sidebarActions.createProject', () => createProject()),
		vscode.commands.registerCommand('microbitIde.sidebarActions.showWelcome', () => showWelcome()),
		// Without this the tab is dropped on reload, since a web reload restarts the
		// extension host and nothing would recreate the panel VS Code restored.
		vscode.window.registerWebviewPanelSerializer(WELCOME_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel) => {
				welcomePanel?.dispose();
				welcomePanel = panel;
				hydrateWelcome(panel);
			},
		})
	);

	// Explorer forces contributed views closed; expand once to preserve later user choices.
	if (!context.globalState.get<boolean>(EXPANDED_ONCE)) {
		void context.globalState.update(EXPANDED_ONCE, true);
		void vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
	}

	// Once per profile, not per window: reopening the IDE should not reopen it.
	if (!context.globalState.get<boolean>(WELCOME_SHOWN)) {
		void context.globalState.update(WELCOME_SHOWN, true);
		showWelcome();
	}

	registerStatusBarMenu(context);

	// The IDE swaps folders in place, so a session answer must not follow the user into the next project.
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => (answered = undefined)));

	// Per workspace, since that is where VS Code keeps the sizes being settled.
	if (!context.workspaceState.get<boolean>(SIZES_SETTLED)) {
		// As early as the layout allows: the shorter this wait, the less chance of catching someone mid-action.
		setTimeout(() => {
			void settleSidebarSizes().then((settled) => {
				if (settled) void context.workspaceState.update(SIZES_SETTLED, true);
			});
		}, 300);
	}
}

/**
 * VS Code only persists Explorer pane sizes on a layout after the first, so a
 * fresh window may never save them and a reload lets the first pane swallow the
 * rest. Nudging the sidebar width forces that layout while the first-load sizes
 * are still good. Skipped while someone is typing, because it moves focus.
 */
async function settleSidebarSizes(): Promise<boolean> {
	if (vscode.window.activeTextEditor) return false;
	await vscode.commands.executeCommand('workbench.view.explorer');
	await vscode.commands.executeCommand('workbench.action.increaseViewSize');
	await vscode.commands.executeCommand('workbench.action.decreaseViewSize');
	await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	return true;
}

/**
 * Lists this extension's commands in the manager's status bar menu, the way the
 * language extensions do. The manifest dependency means the manager activated
 * first, so its exports are there; only their version needs checking.
 */
function registerStatusBarMenu(context: vscode.ExtensionContext): void {
	const api = managerApi(vscode.extensions.getExtension(MANAGER_EXTENSION)?.exports);
	if (!api) return;
	try {
		context.subscriptions.push(
			api.registerMenuGroup({
				label: 'BBC micro:bit IDE',
				commands: [
					{ command: 'microbitIde.sidebarActions.showWelcome', label: 'Open the welcome page' },
					{ command: 'microbitIde.sidebarActions.createProject', label: 'Create new project' },
					{ command: 'microbitIde.switchStorage', label: 'Switch workspace storage' },
				],
			})
		);
	} catch (error) {
		console.warn(`[sidebar-actions] the micro:bit Manager refused the menu group: ${String(error)}`);
	}
}

/** The manager refuses nobody, so a version mismatch is only ever noticed here. */
function managerApi(candidate: unknown): MicrobitManagerApi | undefined {
	const served = (candidate as { version?: unknown } | undefined)?.version;
	if (!compatibleApiVersion(served, MANAGER_API_VERSION)) {
		console.warn(`[sidebar-actions] micro:bit Manager API ${String(served)} is not ${MANAGER_API_VERSION}, menu entries skipped`);
		return undefined;
	}
	return candidate as MicrobitManagerApi;
}

let welcomePanel: vscode.WebviewPanel | undefined;

/** One panel per window: reopening reveals the existing one rather than stacking tabs. */
function showWelcome(): void {
	if (welcomePanel) {
		welcomePanel.reveal(vscode.ViewColumn.One);
		return;
	}

	// No retainContextWhenHidden: the page keeps its one bit of state itself via setState.
	welcomePanel = vscode.window.createWebviewPanel(WELCOME_VIEW_TYPE, 'Welcome', vscode.ViewColumn.One, {
		enableScripts: true,
	});
	hydrateWelcome(welcomePanel);
}

/** Shared by a fresh panel and one VS Code restored after a reload. */
function hydrateWelcome(panel: vscode.WebviewPanel): void {
	const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
	panel.webview.options = { enableScripts: true };
	panel.webview.html = __WELCOME_HTML__.replace(/\{\{nonce\}\}/g, nonce);

	// The page cannot see a rejection, so this boundary is where one becomes a message.
	panel.webview.onDidReceiveMessage((message: { type?: string; command?: string; theme?: string }) => {
		let action: Thenable<unknown> | undefined;
		if (message?.type === 'run' && message.command && WELCOME_COMMANDS.has(message.command)) {
			action = run(message.command);
		} else if (message?.type === 'theme' && message.theme && WELCOME_THEMES.has(message.theme)) {
			action = vscode.workspace
				.getConfiguration('workbench')
				.update('colorTheme', message.theme, vscode.ConfigurationTarget.Global);
		}
		if (action) {
			Promise.resolve(action).catch((error: unknown) =>
				fail(`that did not work. ${error instanceof Error ? error.message : String(error)}`)
			);
		}
	});

	panel.onDidDispose(() => {
		if (welcomePanel === panel) welcomePanel = undefined;
	});
}

async function buildAndFlash(): Promise<void> {
	const commands = await registeredCommands();
	const installed = installedLanguages(commands);
	if (installed.length === 0) {
		fail('no MicroPython or C++ extension is available to build with.');
		return;
	}

	const language = await resolveLanguage(installed);
	if (language) await run(LANGUAGES[language].flash, commands);
}

/**
 * Asks outright: a new project is the one case where the files cannot answer,
 * since the choice starts the project rather than describing it. The languages
 * offered are the ones installed, not the ones that can create, so an extension
 * too old to create one says so instead of the other one quietly winning.
 */
async function createProject(): Promise<void> {
	const commands = await registeredCommands();
	const installed = installedLanguages(commands);
	if (installed.length === 0) {
		fail('no MicroPython or C++ extension is available to create a project with.');
		return;
	}

	let language = installed[0];
	if (installed.length > 1) {
		const picked = await vscode.window.showQuickPick(installed.map(toItem), {
			title: 'Create new project',
			placeHolder: 'Which language is the new project in?',
		});
		if (!picked) return;
		language = picked.language;
	}

	const create = LANGUAGES[language].create;
	if (!commands.has(create)) {
		fail(
			`this version of the ${LANGUAGES[language].label} extension cannot create a project. ` +
				'Update it from the Extensions view, then try again.'
		);
		return;
	}
	await vscode.commands.executeCommand(create);
}

/** Runs another extension's command, saying which one is missing rather than failing silently. */
async function run(command: string, known?: Set<string>): Promise<void> {
	const commands = known ?? (await registeredCommands());
	if (!commands.has(command)) {
		fail(`${command} is not available, so nothing ran.`);
		return;
	}
	await vscode.commands.executeCommand(command);
}

/**
 * The setting wins, then what the files say, then an answer already given. The
 * files come before that answer so editing the project, or opening a different
 * one, corrects a stale choice rather than being overruled by it.
 */
async function resolveLanguage(installed: Language[]): Promise<Language | undefined> {
	// Before the single-language shortcut: asking for a language that is not here
	// is worth saying out loud, rather than quietly building the other one.
	const configured = settingLanguage();
	if (configured) {
		if (installed.includes(configured)) return configured;
		fail(
			`microbitIde.projectLanguage is set to ${LANGUAGES[configured].label}, and that extension ` +
				'is not available, so nothing was built.'
		);
		return undefined;
	}

	// Nothing to decide, and no question worth asking.
	if (installed.length === 1) return installed[0];

	const folder = projectFolder();
	const detected = folder
		? detectLanguage({
				...(await scanSignals(readDirectory(folder.uri), projectSegments(folder.uri))),
				activeLanguageId: vscode.window.activeTextEditor?.document.languageId,
			})
		: undefined;
	if (detected && installed.includes(detected)) return detected;

	if (answered && installed.includes(answered)) return answered;
	return ask(installed);
}

interface LanguageItem extends vscode.QuickPickItem {
	language: Language;
}

const toItem = (language: Language): LanguageItem => ({
	label: LANGUAGES[language].label,
	detail: LANGUAGES[language].detail,
	language,
});

/** Picking answers for this session only; the pin button on each row writes the setting. */
function ask(installed: Language[]): Promise<Language | undefined> {
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<LanguageItem>();
		pick.title = 'Build & flash project';
		pick.placeholder = 'Which language is this project written in?';
		pick.items = installed.map((language) => ({
			...toItem(language),
			buttons: [
				{
					iconPath: new vscode.ThemeIcon('pin'),
					tooltip: `Always build this project as ${LANGUAGES[language].label}`,
				},
			],
		}));

		let chosen: Language | undefined;
		const settle = (language: Language | undefined) => {
			chosen = language;
			pick.hide();
		};

		pick.onDidAccept(() => settle(pick.selectedItems[0]?.language));
		// Saved before the pick closes, so the build never starts against a
		// half-written setting and a failed save is reported before the flash.
		let hidden = false;
		pick.onDidTriggerItemButton(async ({ item }) => {
			pick.busy = true;
			await remember(item.language);
			// Escape during the save means cancel: the choice is kept, the build is not.
			if (!hidden) settle(item.language);
		});
		pick.onDidHide(() => {
			hidden = true;
			pick.dispose();
			if (chosen) answered = chosen;
			resolve(chosen);
		});

		pick.show();
	});
}

/** Workspace scope where there is one, so the choice travels with the project and not the user. */
async function remember(language: Language): Promise<void> {
	const target = vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
	try {
		await vscode.workspace.getConfiguration('microbitIde').update('projectLanguage', language, target);
	} catch (error) {
		warn(
			`the choice of ${LANGUAGES[language].label} could not be saved. ` +
				`${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function settingLanguage(): Language | undefined {
	const configured = vscode.workspace.getConfiguration('microbitIde').get<string>('projectLanguage');
	return configured === 'micropython' || configured === 'cpp' ? configured : undefined;
}

/**
 * A language is available when its flash command is registered, which is also
 * how an extension that failed to activate reads as absent.
 */
const installedLanguages = (commands: Set<string>): Language[] =>
	(Object.keys(LANGUAGES) as Language[]).filter((language) => commands.has(LANGUAGES[language].flash));

/**
 * The folder the user is working in, which the active-editor tiebreak already
 * follows. Only the first folder without one, and this IDE opens a single root.
 */
function projectFolder(): vscode.WorkspaceFolder | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
}

/** `bbcmicrobit-micropython.projectFolder`, resource-scoped, ignored when it escapes the workspace. */
function projectSegments(resource: vscode.Uri): string[] {
	const configured = vscode.workspace
		.getConfiguration('bbcmicrobit-micropython', resource)
		.get<unknown>('projectFolder');
	if (typeof configured !== 'string' || /^([a-z][a-z0-9+.-]*:|[/\\])/i.test(configured)) return [];
	const segments = configured
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	return segments.includes('..') ? [] : segments;
}

const readDirectory =
	(root: vscode.Uri): ReadDirectory =>
	async (segments): Promise<Entry[]> =>
		(await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...segments))).map(([name, type]) => ({
			name,
			// A symlinked directory carries both bits.
			isDirectory: (type & vscode.FileType.Directory) !== 0,
		}));
