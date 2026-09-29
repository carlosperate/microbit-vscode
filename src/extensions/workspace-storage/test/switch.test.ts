import { describe, expect, it } from 'vitest';

import { switchPlan, untouched } from '../src/switch.js';

describe('switchPlan', () => {
	const none = { copy: false, replace: false, overwrite: false, discard: false };

	it('always carries the temporary workspace into browser storage, without asking', () => {
		expect(switchPlan('memfs', 'idbfs', true)).toEqual({ ...none, copy: true, overwrite: true });
	});

	// A starter nobody edited must never replace a file of the same name already saved there.
	it('copies an untouched temporary workspace only where browser storage has no such file', () => {
		expect(switchPlan('memfs', 'idbfs', false)).toEqual({ ...none, copy: true });
	});

	it('warns that a changed temporary workspace is lost when a local folder opens instead', () => {
		expect(switchPlan('memfs', 'localfs', true)).toEqual({ ...none, discard: true, warning: 'loseScratch' });
		expect(switchPlan('memfs', 'localfs', false)).toEqual({ ...none, discard: true });
	});

	// The IDE reopens browser storage at the next start only while it is the storage in use.
	it('always warns on leaving browser storage, and copies only into temporary storage', () => {
		expect(switchPlan('idbfs', 'memfs', false)).toEqual({ ...none, warning: 'browserToScratch', copy: true, replace: true, overwrite: true });
		expect(switchPlan('idbfs', 'localfs', false)).toEqual({ ...none, warning: 'browserToFolder' });
	});

	it('asks nothing and copies nothing when leaving a local folder, whose files stay on the computer', () => {
		expect(switchPlan('localfs', 'memfs', true)).toEqual(none);
		expect(switchPlan('localfs', 'idbfs', true)).toEqual(none);
		expect(switchPlan('localfs', 'localfs', true)).toEqual(none);
	});

	// Only temporary storage is left behind for good, so only its unsaved edits are dropped.
	it('saves unsaved edits everywhere but a temporary workspace left for a local folder', () => {
		expect(switchPlan('memfs', 'idbfs', true).discard).toBe(false);
		expect(switchPlan('idbfs', 'localfs', true).discard).toBe(false);
		expect(switchPlan('localfs', 'localfs', true).discard).toBe(false);
	});
});

describe('untouched', () => {
	const pristine = new Map([
		['main.py', 'print(1)'],
		['README.md', '# Hi'],
	]);

	it('holds while every file is as it was left', () => {
		expect(untouched(pristine, new Map(pristine))).toBe(true);
	});

	it('fails for an edited, added or deleted file', () => {
		expect(untouched(pristine, new Map([...pristine, ['main.py', 'print(2)']]))).toBe(false);
		expect(untouched(pristine, new Map([...pristine, ['extra.py', '']]))).toBe(false);
		expect(untouched(pristine, new Map([['main.py', 'print(1)']]))).toBe(false);
	});
});
