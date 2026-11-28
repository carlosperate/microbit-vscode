// What this repo takes from the pinned VS Code bundle without patching it. A VS Code upgrade
// that renames any of these would otherwise only show as a fault in the browser.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleVersion, loadConfig } from '../build-scripts/fetch-vscode-web.mjs';
import { localExtensions } from '../build-scripts/build-local-extensions.mjs';
import { ACCOUNTS_KEY } from '../build-scripts/layout-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, '.cache', 'vscode-web');
const found = bundleVersion(bundle);
const page = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const layout = JSON.parse(readFileSync(path.join(root, 'config', 'layout.config.json'), 'utf8'));

let cached;
const workbench = () => (cached ??= readFileSync(path.join(bundle, 'out', 'vs', 'workbench', 'workbench.web.main.internal.js'), 'utf8'));
// Asserted as a boolean: on a failure vitest prints the value under test, and this one is 14 MB.
const has = (text) => workbench().includes(text);

// The bundle is a download, so with none these are skipped. CI fetches it first, and fails here.
describe.skipIf(found === null && !process.env.CI)('the VS Code bundle in .cache/vscode-web', () => {
	it('is the pinned version (`npm run fetch:vscode`)', () => {
		expect(found).toBe(loadConfig().vscodeVersion);
	});

	it('has every path public/index.html names', () => {
		const named = [...new Set(page.match(/vscode\/out\/[\w./-]+/g))];
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter((file) => !existsSync(path.join(bundle, file.replace('vscode/', ''))))).toEqual([]);
	});

	// The page writes VS Code's own storage: to pin activity bar icons (`setPinned`), and to
	// clear a temporary session (`forgetEditorState`).
	it.each(['vscode-web-state-db-', 'ItemTable', 'workbench.activity.pinnedViewlets2', 'vscode-web-db'])(
		'still has the storage name %s, which the page uses',
		(name) => {
			expect(page.includes(name)).toBe(true);
			expect(has(`"${name}"`)).toBe(true);
		}
	);

	it('still broadcasts changes to the application storage', () => {
		expect(has('id:"global",broadcastChanges:!0')).toBe(true);
	});

	it('still syncs storage between windows as { changed, deleted }', () => {
		expect(/\{changed:[\w$.]+,deleted:[\w$.]+\}/.test(workbench())).toBe(true);
	});

	// VS Code ignores an unknown id in the seed, so a renamed view would just reappear.
	const seededIds = [...layout.activityBar, ...layout.explorerViews]
		.map((view) => view.id)
		.filter((id) => !id.startsWith('workbench.view.extension.') && !id.startsWith('microbitIde.'));
	it.each([...seededIds, ACCOUNTS_KEY])('still has %s, which the layout seed names', (id) => {
		expect(has(`"${id}"`)).toBe(true);
	});

	// The local extensions type these by hand, and a proposal gains a version when its shape breaks.
	const proposals = localExtensions.flatMap((dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).enabledApiProposals ?? []);
	it.each(proposals)('still offers the proposed API %s, without a version', (proposal) => {
		const [entry, version] = workbench().match(new RegExp(`\\b${proposal}:\\{proposal:"[^"]*"(?:,version:(\\d+))?\\}`)) ?? [];
		expect(entry).toBeDefined();
		expect(version).toBeUndefined();
	});
});
