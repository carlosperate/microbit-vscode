import type { MicrobitManagerApi } from 'vscode-bbcmicrobit-manager-api';
import * as vscode from 'vscode';

import { detectLanguage, scanSignals, type Entry, type Language, type ReadDirectory } from './detect';
import { compatibleApiVersion } from './managerVersion';
import type { StorageApi } from '../../workspace-storage/src/api';
import { MICROBIT_THEMES, modeContainer, modePins, modeSidebar, modeStarters, modeTheme, type Mode } from './mode';

const MANAGER_EXTENSION = 'carlosperate.bbcmicrobit-manager';
const STORAGE_EXTENSION = 'carlosperate.microbit-ide-workspace-storage';
const MANAGER_API_VERSION = '0.3.0';

const VIEW_ID = 'microbitIde.ui.actions';
const EXPANDED_ONCE = 'microbitIde.ui.actions.expandedOnce';
const SIZES_SETTLED = 'microbitIde.ui.actions.sizesSettled';
const WELCOME_VIEW_TYPE = 'microbitIde.welcome';
const MICROPYTHON_MODE = 'microbitIde.ui.microPythonMode';
const CPP_MODE = 'microbitIde.ui.cppMode';

// Registered by public/index.html, since no VS Code API pins an activity bar container.
const SET_PINNED_HOST = 'microbitIde._setPinnedHost';

// The welcome page's markup, inlined at build time by `esbuild.config.mjs`.
declare const __WELCOME_HTML__: string;

/** The page can ask for these and nothing else, so its markup can never widen what it reaches. */
const WELCOME_COMMANDS = new Set([
	'microbitIde.ui.buildAndFlash',
	'microbitIde.ui.openSerialTerminal',
	'microbitIde.openLocalFolder',
	'microbitIde.switchStorage',
	'microbitIde.useBrowserStorage',
	'microbitIde.useTemporaryStorage',
	'bbcmicrobit-micropython.runInSimulator',
	MICROPYTHON_MODE,
	CPP_MODE,
]);

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
		vscode.commands.registerCommand('microbitIde.ui.buildAndFlash', () => buildAndFlash()),
		vscode.commands.registerCommand('microbitIde.ui.openSerialTerminal', () => run(OPEN_TERMINAL)),
		vscode.commands.registerCommand('microbitIde.ui.showAllActions', () => run(SHOW_MENU)),
		vscode.commands.registerCommand('microbitIde.ui.createProject', () => createProject()),
		vscode.commands.registerCommand('microbitIde.ui.showWelcome', () => showWelcome()),
		vscode.commands.registerCommand(MICROPYTHON_MODE, () => switchMode('micropython')),
		vscode.commands.registerCommand(CPP_MODE, () => switchMode('cpp'))
	);

	// Explorer forces contributed views closed; expand once to preserve later user choices.
	if (!context.globalState.get<boolean>(EXPANDED_ONCE)) {
		void context.globalState.update(EXPANDED_ONCE, true);
		void vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
	}

	// Every session opens on it, in front of any tabs the session restored. With no
	// serializer registered, VS Code never saves the tab, so a session never has two.
	showWelcome();

	registerStatusBarMenu(context);

	// As early as the layout allows: the shorter this wait, the less chance of catching someone mid-action.
	setTimeout(() => {
		arrangeSidebar(context).catch((error: unknown) => console.warn(`[microbit-ide-ui] the sidebar was not arranged: ${String(error)}`));
	}, 300);
}

/** Both steps move the focus, so one runs after the other. */
async function arrangeSidebar(context: vscode.ExtensionContext): Promise<void> {
	await showStarterFolders();
	// Per workspace, since that is where VS Code keeps the sizes being settled.
	if (!context.workspaceState.get<boolean>(SIZES_SETTLED) && (await settleSidebarSizes())) {
		void context.workspaceState.update(SIZES_SETTLED, true);
	}
}

/**
 * A temporary session keeps nothing of the last one, so its Explorer starts with every folder
 * closed and a starter program inside one is out of sight. Kept storage restores its own tree.
 */
async function showStarterFolders(): Promise<void> {
	const root = projectFolder()?.uri;
	if (!root || vscode.window.activeTextEditor || storageApi()?.storage() !== 'memfs') return;
	let revealed = false;
	for (const mode of Object.keys(LANGUAGES) as Mode[]) {
		const [segments] = modeStarters(mode, projectSegments(root));
		const starter = vscode.Uri.joinPath(root, ...segments);
		if (segments.length > 1 && (await exists(starter))) {
			await vscode.commands.executeCommand('revealInExplorer', starter);
			revealed = true;
		}
	}
	if (!revealed) return;
	// Revealing selects the file and takes the focus, and a fresh start wants neither.
	await vscode.commands.executeCommand('list.clear');
	await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
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
					{ command: 'microbitIde.ui.showWelcome', label: 'Open the welcome page' },
					{ command: MICROPYTHON_MODE, label: 'Switch to MicroPython mode' },
					{ command: CPP_MODE, label: 'Switch to C++ mode' },
					{ command: 'microbitIde.ui.createProject', label: 'Create new project' },
					{ command: 'microbitIde.switchStorage', label: 'Switch workspace storage' },
				],
			})
		);
	} catch (error) {
		console.warn(`[microbit-ide-ui] the micro:bit Manager refused the menu group: ${String(error)}`);
	}
}

/** The manager refuses nobody, so a version mismatch is only ever noticed here. */
function managerApi(candidate: unknown): MicrobitManagerApi | undefined {
	const served = (candidate as { version?: unknown } | undefined)?.version;
	if (!compatibleApiVersion(served, MANAGER_API_VERSION)) {
		console.warn(`[microbit-ide-ui] micro:bit Manager API ${String(served)} is not ${MANAGER_API_VERSION}, menu entries skipped`);
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
	const panel = vscode.window.createWebviewPanel(WELCOME_VIEW_TYPE, 'Welcome', vscode.ViewColumn.One, {
		enableScripts: true,
	});
	welcomePanel = panel;
	const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
	panel.webview.html = __WELCOME_HTML__.replace(/\{\{nonce\}\}/g, nonce);

	// The page names the storage in use and offers the other. It asks again each time
	// it reloads, which it does whenever the tab is shown after being hidden.
	const tellStorage = () => void panel.webview.postMessage({ type: 'storage', storage: storageApi()?.storage() });
	const following = storageApi()?.onDidChangeStorage(tellStorage);

	// The page cannot see a rejection, so this boundary is where one becomes a message.
	panel.webview.onDidReceiveMessage((message: { type?: string; command?: string; theme?: string }) => {
		if (message?.type === 'ready') return tellStorage();
		let action: Thenable<unknown> | undefined;
		if (message?.type === 'run' && message.command && WELCOME_COMMANDS.has(message.command)) {
			action = run(message.command);
		} else if (message?.type === 'theme' && message.theme && MICROBIT_THEMES.has(message.theme)) {
			action = setTheme(message.theme);
		}
		if (action) {
			Promise.resolve(action).catch((error: unknown) => fail(`that did not work. ${errorText(error)}`));
		}
	});

	panel.onDidDispose(() => {
		following?.dispose();
		welcomePanel = undefined;
	});
}

/** The storage extension's exports: a manifest dependency, so it has activated before this one. */
const storageApi = () => vscode.extensions.getExtension<StorageApi>(STORAGE_EXTENSION)?.exports;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const setTheme = (theme: string) =>
	vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);

/** Without the page's bridge the activity bar just stays as it is. */
async function pin(changes: Record<string, boolean>): Promise<void> {
	const pinned = await Promise.resolve(vscode.commands.executeCommand<boolean>(SET_PINNED_HOST, changes)).catch(() => false);
	if (!pinned) console.warn('[microbit-ide-ui] the page could not pin the micro:bit sidebars');
}

/** In turn with a storage switch or another mode, either of which would change the files under this one. */
function switchMode(mode: Mode): Promise<void> {
	const exclusive = storageApi()?.exclusive ?? ((task: () => Promise<void>) => task());
	return exclusive(() => applyMode(mode));
}

/** Only the confirmation comes before any change, so declining it leaves the IDE as it was. */
async function applyMode(mode: Mode): Promise<void> {
	if (!(await registeredCommands()).has(LANGUAGES[mode].create)) {
		fail(`the ${LANGUAGES[mode].label} extension is not available, so the mode was not changed.`);
		return;
	}
	try {
		const root = projectFolder()?.uri;
		const storage = storageApi();
		// The temporary workspace, whose files a mode replaces. Kept storage is only ever added to.
		const scratch = storage?.storage() === 'memfs' ? storage : undefined;
		if (scratch && (await scratch.scratchChanged()) && !(await confirmReplace(mode))) return;

		const { kind } = vscode.window.activeColorTheme;
		await setTheme(modeTheme(mode, kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast));
		// Opening a container still unpinned makes VS Code store its own copy of the list, which
		// flushes over ours, and unpinning the one showing leaves its icon behind once it closes.
		await pin({ [modeContainer(mode)]: true });
		await vscode.commands.executeCommand(modeSidebar(mode));
		await pin(modePins(mode));

		if (!root) return;
		// The last step, and undone if the starter fails, so a failed switch costs no files.
		const starter = () => openStarter(mode, root);
		await (scratch ? scratch.replaceScratch(starter) : starter());
	} catch (error) {
		fail(`switching to ${LANGUAGES[mode].label} mode did not finish. ${errorText(error)}`);
	}
}

async function confirmReplace(mode: Mode): Promise<boolean> {
	const replace = 'Replace files';
	const answer = await vscode.window.showWarningMessage(
		`Replace the files in this workspace with a new ${LANGUAGES[mode].label} project?`,
		{ modal: true, detail: 'Your changes will be deleted. To keep them, switch to browser storage first.' },
		replace
	);
	return answer === replace;
}

const exists = (uri: vscode.Uri) =>
	vscode.workspace.fs.stat(uri).then(
		() => true,
		() => false
	);

/** The language extension writes its own template, never over a file; an existing one is just opened. */
async function openStarter(mode: Mode, root: vscode.Uri): Promise<void> {
	const places = modeStarters(mode, projectSegments(root)).map((segments) => vscode.Uri.joinPath(root, ...segments));
	const starter = async () => {
		for (const place of places) if (await exists(place)) return place;
		return undefined;
	};
	const present = await starter();
	if (present) {
		await vscode.window.showTextDocument(present);
		return;
	}
	// C++ takes the folder, MicroPython always uses its configured project folder.
	await vscode.commands.executeCommand(LANGUAGES[mode].create, ...(mode === 'cpp' ? [root] : []));
	// Both report a failure themselves and return, so only the file says whether it worked.
	if (!(await starter())) throw new Error('The starter program was not created.');
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
 * The setting wins, then what the files say. A project they leave undecided is
 * asked about every time, as one holding both languages may mean either.
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

/** Picking answers this once; the pin button on each row writes the setting. */
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
			resolve(chosen);
		});

		pick.show();
	});
}

/** The project folder's own settings, so the choice stays with its files when the storage changes. */
async function remember(language: Language): Promise<void> {
	const folder = projectFolder();
	const target = folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
	try {
		await vscode.workspace.getConfiguration('microbitIde', folder?.uri).update('projectLanguage', language, target);
	} catch (error) {
		warn(`the choice of ${LANGUAGES[language].label} could not be saved. ${errorText(error)}`);
	}
}

function settingLanguage(): Language | undefined {
	const configured = vscode.workspace.getConfiguration('microbitIde', projectFolder()?.uri).get<string>('projectLanguage');
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
