import { describe, expect, it, vi } from 'vitest';

import { detectLanguage, scanSignals, type Entry } from '../src/detect';

const NOTHING = { pythonAtProjectRoot: false, cppSource: false };

describe('detectLanguage', () => {
	it('follows the only language with any evidence', () => {
		expect(detectLanguage({ ...NOTHING, pythonAtProjectRoot: true })).toBe('micropython');
		expect(detectLanguage({ ...NOTHING, cppSource: true })).toBe('cpp');
	});

	it('gives up on an empty folder rather than guessing', () => {
		expect(detectLanguage(NOTHING)).toBeUndefined();
	});

	describe('both languages present', () => {
		const both = { ...NOTHING, pythonAtProjectRoot: true, cppSource: true };

		// What the user is looking at is the best evidence of what they meant.
		it('breaks the tie on the focused editor', () => {
			expect(detectLanguage({ ...both, activeLanguageId: 'python' })).toBe('micropython');
			expect(detectLanguage({ ...both, activeLanguageId: 'cpp' })).toBe('cpp');
			expect(detectLanguage({ ...both, activeLanguageId: 'c' })).toBe('cpp');
		});

		it('asks rather than guess when nothing breaks the tie', () => {
			expect(detectLanguage(both)).toBeUndefined();
			expect(detectLanguage({ ...both, activeLanguageId: 'markdown' })).toBeUndefined();
		});
	});

	// A scan that stopped early has not shown C++ is absent, so Python alongside
	// it is the same undecided case as finding both.
	describe('an unknown C++ answer', () => {
		const unknown = { pythonAtProjectRoot: true, cppSource: 'unknown' } as const;

		it('does not settle on MicroPython', () => {
			expect(detectLanguage(unknown)).toBeUndefined();
			expect(detectLanguage({ ...unknown, activeLanguageId: 'cpp' })).toBe('cpp');
			expect(detectLanguage({ ...unknown, activeLanguageId: 'python' })).toBe('micropython');
		});

		it('is no evidence of C++ on its own', () => {
			expect(detectLanguage({ pythonAtProjectRoot: false, cppSource: 'unknown' })).toBeUndefined();
		});
	});
});

/** Builds a `readDirectory` over a plain tree, keyed by `/`-joined path. */
function tree(entries: Record<string, string[]>) {
	return vi.fn(async (segments: string[]): Promise<Entry[]> =>
		(entries[segments.join('/')] ?? []).map((name) =>
			name.endsWith('/') ? { name: name.slice(0, -1), isDirectory: true } : { name, isDirectory: false }
		)
	);
}

describe('scanSignals', () => {
	it('sees Python only at the project root, since the board has no folders', async () => {
		const read = tree({ '': ['main.py', 'README.md'] });
		expect(await scanSignals(read, [])).toMatchObject({ pythonAtProjectRoot: true });

		const nested = tree({ '': ['src/'], src: ['main.py'] });
		expect(await scanSignals(nested, [])).toMatchObject({ pythonAtProjectRoot: false });
	});

	// The setting says where the Python lives, never that the project is MicroPython.
	it('looks for Python under the configured project folder', async () => {
		const read = tree({ '': ['src/'], src: ['main.py'] });
		expect(await scanSignals(read, ['src'])).toMatchObject({ pythonAtProjectRoot: true });
	});

	it('reports no Python when the configured folder holds none', async () => {
		const read = tree({ '': ['main.py', 'src/'], src: ['notes.txt'] });
		expect(await scanSignals(read, ['src'])).toMatchObject({ pythonAtProjectRoot: false });
	});

	it('finds C++ sources at any depth', async () => {
		const read = tree({ '': ['source/'], source: ['main.cpp'] });
		expect(await scanSignals(read, [])).toMatchObject({ cppSource: true });
	});

	// Directory order belongs to the filesystem provider, so a scan that stopped at
	// the first `.cpp` would report a different language on memfs than on localfs.
	it('reports both languages whichever order the entries arrive in', async () => {
		const cppFirst = tree({ '': ['main.cpp', 'main.py'] });
		expect(await scanSignals(cppFirst, [])).toEqual({ pythonAtProjectRoot: true, cppSource: true });

		const pythonFirst = tree({ '': ['main.py', 'main.cpp'] });
		expect(await scanSignals(pythonFirst, [])).toEqual({ pythonAtProjectRoot: true, cppSource: true });
	});

	// The C++ walk can exhaust its budget long before it reaches the project root.
	it('still sees Python when the C++ walk runs out of budget', async () => {
		const read = tree({ '': ['deep/', 'main.py'], deep: Array.from({ length: 40 }, (_, i) => `f${i}.txt`) });
		expect(await scanSignals(read, [], { maxDepth: 3, maxEntries: 10 })).toEqual({
			pythonAtProjectRoot: true,
			cppSource: 'unknown',
		});
	});

	it('counts only sources the compiler takes, not headers', async () => {
		expect(await scanSignals(tree({ '': ['MicroBit.h'] }), [])).toMatchObject({ cppSource: false });
		expect(await scanSignals(tree({ '': ['a.cc'] }), [])).toMatchObject({ cppSource: true });
		expect(await scanSignals(tree({ '': ['a.cxx'] }), [])).toMatchObject({ cppSource: true });
	});

	// A vendored CODAL checkout would otherwise make every workspace look like C++.
	it('skips dependency and build folders', async () => {
		const read = tree({ '': ['libraries/', 'build/', 'node_modules/', '.git/'], libraries: ['codal.cpp'], build: ['out.cpp'], node_modules: ['x.cpp'], '.git': ['y.cpp'] });
		expect(await scanSignals(read, [])).toMatchObject({ cppSource: false });
	});

	// Nothing that deep is the program being flashed, so the answer stays a real no.
	it('stops descending past the depth limit', async () => {
		const read = tree({ '': ['a/'], a: ['b/'], b: ['c/'], 'a/b': ['c/'], 'a/b/c': ['deep.cpp'] });
		expect(await scanSignals(read, [], { maxDepth: 2, maxEntries: 100 })).toMatchObject({ cppSource: false });
	});

	it('stops after the entry budget rather than walking a huge workspace', async () => {
		const read = tree({ '': Array.from({ length: 50 }, (_, i) => `f${i}.txt`).concat(['late.cpp']) });
		expect(await scanSignals(read, [], { maxDepth: 3, maxEntries: 10 })).toMatchObject({ cppSource: 'unknown' });
	});

	// The bug this guards: a `.cpp` past the budget used to read as absent, so the
	// same workspace answered MicroPython or C++ depending on listing order.
	it('does not call a project MicroPython over an unfinished C++ search', async () => {
		const docs = Array.from({ length: 50 }, (_, i) => `doc${i}.md`);
		const signals = await scanSignals(tree({ '': ['main.py', ...docs, 'main.cpp'] }), [], {
			maxDepth: 3,
			maxEntries: 10,
		});
		expect(detectLanguage({ ...signals, activeLanguageId: 'cpp' })).toBe('cpp');
	});

	it('survives an unreadable folder', async () => {
		const read = vi.fn(async (segments: string[]): Promise<Entry[]> => {
			if (segments.length === 0) return [{ name: 'locked', isDirectory: true }, { name: 'main.py', isDirectory: false }];
			throw new Error('EACCES');
		});
		expect(await scanSignals(read, [])).toMatchObject({ pythonAtProjectRoot: true, cppSource: false });
	});
});
