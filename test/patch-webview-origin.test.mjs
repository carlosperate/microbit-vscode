import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	patchWebviewOriginCheck,
	computeInlineScriptCspHash,
	readDeclaredScriptCspHash,
	hasUnpatchedGuard,
} from '../build-scripts/patch-webview-origin.mjs';

const GUARD = `\t\t\t\tif (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {`;
const sha256 = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

// A miniature of pre/index.html: a CSP meta that pins the inline script by sha256,
// plus an inline <script> that contains the origin guard we patch. The declared
// hash starts deliberately WRONG so the test proves the patch re-syncs it.
//  - `leadEmpty` prepends the empty `<script></script>` Firefox workaround that
//    really precedes the module script in index-no-csp.html.
//  - `selfFirst` puts `'self'` before the hash, exercising source ordering.
//  - `crlf` joins with CRLF, exercising the browser's LF-normalization for hashing.
function fixtureWithCsp({ leadEmpty = false, selfFirst = false, crlf = false } = {}) {
	const stale = "'sha256-STALEHASHSTALEHASHSTALEHASHSTALEHASHSTALEHAS='";
	const scriptSrc = selfFirst ? `script-src 'self' ${stale}` : `script-src ${stale} 'self'`;
	const lines = [
		'<!DOCTYPE html>',
		'<meta http-equiv="Content-Security-Policy"',
		`\tcontent="default-src 'none'; ${scriptSrc}; frame-src 'self';">`,
		...(leadEmpty ? ['<script></script>'] : []),
		'<script async type="module">',
		'\tconst hostname = location.hostname;',
		GUARD,
		'\t\t\t\t\treturn start(parentOrigin);',
		'\t\t\t\t}',
		'</script>',
	];
	return lines.join(crlf ? '\r\n' : '\n');
}

describe('patchWebviewOriginCheck', () => {
	it('prepends a same-origin bypass to the guard', () => {
		const out = patchWebviewOriginCheck(`x\n${GUARD}\n\t\t\t\t\treturn start(parentOrigin);`);
		expect(out).toContain('parentOrigin === location.origin ||');
		// original clauses are preserved after the new one
		expect(out).toContain("hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')");
	});

	it('is idempotent — patching twice changes nothing further', () => {
		const once = patchWebviewOriginCheck(`${GUARD}\n`);
		const twice = patchWebviewOriginCheck(once);
		expect(twice).toBe(once);
	});

	it('throws if the guard anchor is absent (upstream moved — rebase the patch)', () => {
		expect(() => patchWebviewOriginCheck('no guard here')).toThrow(/anchor not found/i);
	});

	it('leaves the rest of the document untouched', () => {
		const doc = `before\n${GUARD}\nafter`;
		const out = patchWebviewOriginCheck(doc);
		expect(out.startsWith('before\n')).toBe(true);
		expect(out.endsWith('\nafter')).toBe(true);
	});

	it('rewrites the CSP script hash to match the patched inline script', () => {
		const patched = patchWebviewOriginCheck(fixtureWithCsp());
		// the guard was patched…
		expect(patched).toContain('parentOrigin === location.origin ||');
		// …and the CSP now declares the hash of the *patched* inline script
		expect(readDeclaredScriptCspHash(patched)).toBe(computeInlineScriptCspHash(patched));
		// and the stale placeholder is gone
		expect(patched).not.toContain('STALEHASH');
	});

	it('CSP re-sync is idempotent on a doc with a pinned inline script', () => {
		const once = patchWebviewOriginCheck(fixtureWithCsp());
		expect(patchWebviewOriginCheck(once)).toBe(once);
	});

	it('re-syncs the hash regardless of source order (`self` before the hash)', () => {
		const patched = patchWebviewOriginCheck(fixtureWithCsp({ selfFirst: true }));
		expect(patched).not.toContain('STALEHASH');
		expect(readDeclaredScriptCspHash(patched)).toBe(computeInlineScriptCspHash(patched));
		expect(patched).toContain("script-src 'self' 'sha256-"); // ordering preserved
	});

	it('hashes the guard-bearing script, not an empty leading <script>', () => {
		const patched = patchWebviewOriginCheck(fixtureWithCsp({ leadEmpty: true }));
		const declared = readDeclaredScriptCspHash(patched);
		expect(declared).toBe(computeInlineScriptCspHash(patched));
		// crucially NOT the hash of the empty leading script
		expect(declared).not.toBe(sha256(''));
	});

	it('hashes LF-normalized content for CRLF documents (matches the browser)', () => {
		const patched = patchWebviewOriginCheck(fixtureWithCsp({ crlf: true }));
		// the declared hash matches what the patch computes…
		expect(readDeclaredScriptCspHash(patched)).toBe(computeInlineScriptCspHash(patched));
		// …and equals the hash of the same document with LF endings (CRLF didn't leak in)
		const lf = patchWebviewOriginCheck(fixtureWithCsp({ crlf: false }));
		expect(readDeclaredScriptCspHash(patched)).toBe(readDeclaredScriptCspHash(lf));
	});

	it('throws when script-src declares multiple sha256 sources (ambiguous)', () => {
		const twoHashes = fixtureWithCsp().replace(
			"'self'",
			"'sha256-OTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHEROT=' 'self'"
		);
		expect(() => patchWebviewOriginCheck(twoHashes)).toThrow(/multiple sha256/i);
	});

	it('patches every occurrence of a duplicated guard', () => {
		const doc = `first\n${GUARD}\nmiddle\n${GUARD}\nlast`;
		const out = patchWebviewOriginCheck(doc);
		expect(hasUnpatchedGuard(out)).toBe(false);
		expect(out.split('parentOrigin === location.origin').length - 1).toBe(2);
	});

	it('does not invent a CSP for docs that have none (index-no-csp variant)', () => {
		const noCsp = `<script></script>\n<script async type="module">\n${GUARD}\n</script>`;
		const out = patchWebviewOriginCheck(noCsp);
		expect(out).toContain('parentOrigin === location.origin ||');
		expect(out).not.toContain('sha256-');
	});
});
