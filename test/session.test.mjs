// `public/session.js` is a classic browser script setting `window.microbitSession`,
// so it is evaluated in a sandbox, as rebase.test.mjs does.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(join(__dirname, '../public/session.js'), 'utf8'))(win);
const { setPinned, startStorage } = win.microbitSession;

describe('startStorage', () => {
	it('reopens browser storage', () => {
		expect(startStorage('idbfs', false)).toBe('idbfs');
	});

	// Without access the workspace would show a folder nothing can read.
	it('reopens a local folder only while the browser still grants access', () => {
		expect(startStorage('localfs', true)).toBe('localfs');
		expect(startStorage('localfs', false)).toBe('memfs');
	});

	it('starts afresh after a memfs session, or with nothing remembered', () => {
		expect(startStorage('memfs', true)).toBe('memfs');
		expect(startStorage(undefined, true)).toBe('memfs');
		expect(startStorage(42, true)).toBe('memfs');
	});
});

describe('setPinned', () => {
	const stored = JSON.stringify([
		{ id: 'explorer', pinned: true, visible: true, order: 0 },
		{ id: 'python', pinned: true, visible: true, order: 1 },
		{ id: 'cpp', pinned: true, visible: true, order: 2 },
	]);

	it('pins and unpins the containers named, leaving the rest as they were', () => {
		expect(JSON.parse(setPinned(stored, { cpp: false }))).toEqual([
			{ id: 'explorer', pinned: true, visible: true, order: 0 },
			{ id: 'python', pinned: true, visible: true, order: 1 },
			{ id: 'cpp', pinned: false, visible: true, order: 2 },
		]);
	});

	// VS Code pins any container missing from the list.
	it('adds a container the list does not have yet, after the others', () => {
		expect(JSON.parse(setPinned(stored, { manager: false })).pop()).toEqual({
			id: 'manager',
			pinned: false,
			visible: true,
			order: 3,
		});
		expect(JSON.parse(setPinned(undefined, { cpp: false }))).toEqual([{ id: 'cpp', pinned: false, visible: true, order: 0 }]);
	});

	// How the page tells a copy VS Code flushed that agrees with the request from one that undoes it.
	it('returns the stored value itself when it already has those pins', () => {
		expect(setPinned(stored, { python: true, cpp: true })).toBe(stored);
		expect(setPinned(stored, { cpp: false })).not.toBe(stored);
	});
});
