import * as vscode from 'vscode';

import { detectLanguage, scanSignals, type Entry, type Language, type ReadDirectory } from './detect';

const VIEW_ID = 'microbitIde.sidebarActions';
const EXPANDED_ONCE = 'microbitIde.sidebarActions.expandedOnce';

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
		vscode.commands.registerCommand('microbitIde.sidebarActions.createProject', () => createProject())
	);

	// Explorer forces contributed views closed; expand once to preserve later user choices.
	if (!context.globalState.get<boolean>(EXPANDED_ONCE)) {
		void context.globalState.update(EXPANDED_ONCE, true);
		void vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
	}
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
		pick.onDidTriggerItemButton(async ({ item }) => {
			pick.busy = true;
			await remember(item.language);
			settle(item.language);
		});
		pick.onDidHide(() => {
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
			`built as ${LANGUAGES[language].label}, but the choice could not be saved. ` +
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
