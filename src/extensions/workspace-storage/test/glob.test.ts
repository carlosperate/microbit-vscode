import { describe, expect, it } from 'vitest';
import { couldMatchInside, matchesAny, matchesLoosely } from '../src/glob.js';

/** Paths are relative to the workspace folder, with forward slashes and no leading one. */
describe('glob matching', () => {
	it('matches a name anywhere with a leading globstar', () => {
		expect(matchesAny(['**/*.cpp'], 'main.cpp')).toBe(true);
		expect(matchesAny(['**/*.cpp'], 'src/deep/main.cpp')).toBe(true);
		expect(matchesAny(['**/*.cpp'], 'main.py')).toBe(false);
	});

	it('keeps a single star inside one segment', () => {
		expect(matchesAny(['*.cpp'], 'main.cpp')).toBe(true);
		expect(matchesAny(['*.cpp'], 'src/main.cpp')).toBe(false);
	});

	it('takes a brace group, which is how an exclude list arrives', () => {
		const excludes = ['{**/.git/**,**/node_modules/**,**/build/**,**/libraries/**}'];
		expect(matchesAny(excludes, 'build/MICROBIT.hex')).toBe(true);
		expect(matchesAny(excludes, 'libraries/codal/x.cpp')).toBe(true);
		expect(matchesAny(excludes, 'src/main.cpp')).toBe(false);
	});

	it('matches what is inside a folder, not the folder, which is what the glob says', () => {
		expect(matchesAny(['**/node_modules/**'], 'a/node_modules/pkg/index.js')).toBe(true);
		expect(matchesAny(['**/node_modules/**'], 'node_modules')).toBe(false);
		// A file can share a folder's name, and an include must not claim it.
		expect(matchesAny(['**/src/**'], 'src')).toBe(false);
	});

	it('answers separately for a directory a walk is about to descend into', () => {
		expect(couldMatchInside(['**/node_modules/**'], 'node_modules')).toBe(true);
		expect(couldMatchInside(['**/node_modules/**'], 'a/node_modules')).toBe(true);
		expect(couldMatchInside(['**/build/**'], 'src')).toBe(false);
	});

	it('lets a globstar stand for no directory at all', () => {
		expect(matchesAny(['src/**/*.cpp'], 'src/main.cpp')).toBe(true);
		expect(matchesAny(['src/**/*.cpp'], 'src/deep/main.cpp')).toBe(true);
		expect(matchesAny(['src/**/*.cpp'], 'other/main.cpp')).toBe(false);
	});

	it('matches nothing rather than throwing on half a pattern', () => {
		expect(matchesAny(['{src,lib'], 'src/a.cpp')).toBe(false);
		expect(couldMatchInside(['{src,lib'], 'src')).toBe(false);
	});

	it('takes the brace and character forms VS Code allows', () => {
		expect(matchesAny(['**/*.{cpp,cc}'], 'a/main.cc')).toBe(true);
		expect(matchesAny(['**/*.{cpp,cc}'], 'a/main.c')).toBe(false);
		expect(matchesAny(['main.?pp'], 'main.cpp')).toBe(true);
		expect(matchesAny(['[mn]ain.cpp'], 'main.cpp')).toBe(true);
		expect(matchesAny(['[!mn]ain.cpp'], 'main.cpp')).toBe(false);
	});

	it('treats a comma outside a brace group as a character', () => {
		expect(matchesAny(['a,b.txt'], 'a,b.txt')).toBe(true);
		expect(matchesAny(['a,b.txt'], 'a.txt')).toBe(false);
	});

	it('escapes regular expression punctuation in a name', () => {
		expect(matchesAny(['**/a+b(1).txt'], 'a+b(1).txt')).toBe(true);
		expect(matchesAny(['**/a+b(1).txt'], 'axb1.txt')).toBe(false);
	});

	it('says no for an empty pattern list, so an empty include means no filter to the caller', () => {
		expect(matchesAny([], 'main.cpp')).toBe(false);
	});

	it('matches a Quick Open query by its letters in order', () => {
		expect(matchesLoosely('mnpy', 'src/main.py')).toBe(true);
		expect(matchesLoosely('MAIN', 'src/main.py')).toBe(true);
		expect(matchesLoosely('ypm', 'src/main.py')).toBe(false);
	});
});
