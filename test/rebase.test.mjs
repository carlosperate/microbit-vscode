// Tests the pure rebase helper used by public/index.html to rewrite
// `additionalBuiltinExtensions` URIs before passing them to the workbench.
// `public/rebase.js` is a classic browser script that sets
// `window.microbitRebase`; we evaluate it in a sandbox to access the function.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '../public/rebase.js'), 'utf8');
const win = {};
new Function('window', source)(win);
const rebase = win.microbitRebase;

describe('rebase', () => {
	it('rewrites bare http URI under a sub-path deploy', () => {
		const out = rebase(
			{ scheme: 'http', path: '/extensions/foo' },
			'user.github.io',
			'https',
			'/microbit-vscode'
		);
		expect(out).toEqual({
			scheme: 'https',
			authority: 'user.github.io',
			path: '/microbit-vscode/extensions/foo',
		});
	});

	it('rewrites bare http URI at root (empty basePath)', () => {
		const out = rebase(
			{ scheme: 'http', path: '/extensions/foo' },
			'localhost:8080',
			'http',
			''
		);
		expect(out).toEqual({
			scheme: 'http',
			authority: 'localhost:8080',
			path: '/extensions/foo',
		});
	});

	it('leaves a URI alone when it already has an authority', () => {
		const input = {
			scheme: 'http',
			authority: 'cdn.example.com',
			path: '/extensions/foo',
		};
		expect(rebase(input, 'user.github.io', 'https', '/microbit-vscode')).toEqual(input);
	});

	it('leaves a URI alone when scheme is not http or https', () => {
		const input = { scheme: 'memfs', path: '/welcome' };
		expect(rebase(input, 'user.github.io', 'https', '/microbit-vscode')).toEqual(input);
	});
});
