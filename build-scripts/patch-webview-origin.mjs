import { createHash } from 'node:crypto';

/**
 * Patch the webview bootstrap's parent-origin check to accept same-origin webviews,
 * and re-sync the Content-Security-Policy hash that pins its inline script.
 *
 * Upstream (`out/vs/workbench/contrib/webview/browser/pre/index.html`, and the
 * `index-no-csp.html` sibling) only trusts a webview whose *hostname* equals a
 * per-webview sha-256 hash — a scheme that requires serving each webview from a
 * unique wildcard subdomain (`https://<hash>.vscode-cdn.net/…`). We self-host the
 * webview assets from our own single origin (GitHub Pages / localhost), so that
 * check can never pass and every webview (markdown preview, custom editors…) dies
 * with "Expected '<hash>' as hostname or subdomain!".
 *
 * We add one clause: also trust the webview when its own origin equals the parent
 * origin. This holds only because we serve `pre/…` from the same origin as the
 * workbench, so it strictly widens trust to the same-origin case and nothing else.
 * (This is the trade-off code-server makes too: webviews lose cross-origin
 * isolation from the workbench.)
 *
 * `index.html` also carries `<meta http-equiv="Content-Security-Policy" …
 * script-src 'sha256-<hash>'>` where `<hash>` is the sha-256 of its **inline
 * bootstrap script** — the very script we just edited. Leaving the old hash makes
 * the browser block the (now-modified) script under CSP, which is a *blank*
 * webview with a console CSP violation rather than the origin error. So after
 * editing the guard we recompute the inline-script hash and rewrite the CSP.
 * `index-no-csp.html` has no such meta, so that step is a no-op there.
 *
 * Anchored on the exact guard line; throws if upstream changed it, so the build
 * fails loudly and signals a rebase rather than silently shipping broken webviews.
 */
const GUARD = `if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {`;
const PATCHED = `if (parentOrigin === location.origin || hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {`;

// The CSP-pinned bootstrap is the inline script carrying the origin-guard logic
// (it references `parentOriginHash`). We select it by that symbol rather than
// "the first <script>" so unrelated leading scripts are skipped — notably the
// empty `<script></script>` Firefox workaround that already precedes it in
// index-no-csp.html and could appear in index.html on a future upstream bump.
const GUARD_SYMBOL = 'parentOriginHash';
const INLINE_SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
// CSP sources inside an HTML `content="…"` meta are single-quoted (the attribute
// itself is double-quoted, so a source can't be). Match the sha-256 source
// anywhere in the script-src directive — order-independent, so a future
// `script-src 'self' 'sha256-…'` is handled just like `'sha256-…' 'self'`.
const CSP_HASH_SOURCE_RE = /'sha256-([A-Za-z0-9+/=]+)'/g;

/**
 * Content of the CSP-pinned inline script (the guard-bearing one), or null.
 *
 * Normalized to LF because the HTML parser normalizes CRLF/CR → LF *before* the
 * inline-script bytes are hashed for CSP; hashing raw CRLF would produce a hash
 * the browser never computes, silently breaking the webview.
 */
function guardScriptContent(html) {
	for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
		if (m[1].includes(GUARD_SYMBOL)) return m[1].replace(/\r\n?/g, '\n');
	}
	return null;
}

/** The CSP `script-src` directive's source list, or null if the doc has no CSP script-src. */
function scriptSrcDirective(html) {
	for (const meta of html.matchAll(/content\s*=\s*(["'])([\s\S]*?)\1/gi)) {
		for (const directive of meta[2].split(';')) {
			if (directive.trim().startsWith('script-src')) return directive;
		}
	}
	return null;
}

/** All sha-256 sources declared in the CSP script-src (each: [token, base64]). */
function declaredScriptHashes(html) {
	const directive = scriptSrcDirective(html);
	return directive ? [...directive.matchAll(CSP_HASH_SOURCE_RE)] : [];
}

/** The `sha256-<base64>` a compliant CSP must declare for this doc's inline script, or null if it has none. */
export function computeInlineScriptCspHash(html) {
	const content = guardScriptContent(html);
	if (content === null) return null;
	return 'sha256-' + createHash('sha256').update(content, 'utf8').digest('base64');
}

/** The single `sha256-<base64>` the CSP script-src declares, or null if it declares zero (or ambiguously many). */
export function readDeclaredScriptCspHash(html) {
	const hashes = declaredScriptHashes(html);
	return hashes.length === 1 ? 'sha256-' + hashes[0][1] : null;
}

/** Whether the doc pins an inline script via a CSP script-src sha-256 source. */
export function hasCspScriptHash(html) {
	return declaredScriptHashes(html).length > 0;
}

/** Whether an un-patched origin guard still remains (build postcondition helper). */
export function hasUnpatchedGuard(html) {
	return html.includes(GUARD);
}

/** Rewrite the CSP script-src hash to match this doc's (already-patched) inline script. */
function syncInlineScriptCsp(html) {
	const hash = computeInlineScriptCspHash(html);
	if (hash === null) return html; // no guard script to pin
	const hashes = declaredScriptHashes(html);
	if (hashes.length === 0) return html; // no CSP hash source (e.g. index-no-csp.html)
	if (hashes.length > 1) {
		throw new Error(
			'patch-webview-origin: CSP script-src declares multiple sha256 sources — the ' +
			'single-inline-script assumption no longer holds; update patch-webview-origin.mjs ' +
			'(see WORKBENCH_PATCH.md).'
		);
	}
	return html.replace(hashes[0][0], () => `'${hash}'`);
}

export function patchWebviewOriginCheck(html) {
	let out = html;
	if (out.includes(GUARD)) {
		out = out.replaceAll(GUARD, PATCHED); // patch every occurrence, not just the first
	} else if (!out.includes(PATCHED)) {
		throw new Error(
			'patch-webview-origin: guard anchor not found in webview pre/*.html — ' +
			'upstream VS Code changed the parent-origin check; rebase this patch.'
		);
	}
	// Always re-sync the CSP against the current inline script so the result is
	// self-consistent and idempotent (recomputing an unchanged script is a no-op).
	return syncInlineScriptCsp(out);
}
