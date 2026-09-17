/**
 * The slice of VS Code's glob syntax a search query uses, as a regular
 * expression: `**`, `*`, `?`, `{a,b}` and `[abc]`. Search options carry these as
 * strings and the workbench does not apply them for us, so the providers do.
 */

/** Compiled patterns are reused across queries; the Search box compiles one per keystroke. */
const cache = new Map<string, RegExp>();
const CACHE_LIMIT = 200;

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The letters of `query` in order somewhere in `text`, which is what Quick Open
 * means by a match. Loose on purpose: the workbench scores and orders what comes
 * back, so this only has to avoid discarding a candidate it would have wanted.
 */
export function matchesLoosely(query: string, text: string): boolean {
	const wanted = query.toLowerCase();
	const against = text.toLowerCase();
	let at = 0;
	for (const letter of wanted) {
		at = against.indexOf(letter, at) + 1;
		if (at === 0) return false;
	}
	return true;
}

/** Whether any pattern matches, against a path relative to the folder with forward slashes. */
export const matchesAny = (patterns: readonly string[], relativePath: string) =>
	patterns.some((pattern) => compiled(pattern, false).test(relativePath));

/**
 * Whether a directory is itself matched or could hold something that matches, which
 * is what a walk needs to know before descending. `**​/build/**` excludes `build`.
 */
export const couldMatchInside = (patterns: readonly string[], directoryPath: string) =>
	patterns.some((pattern) => compiled(pattern, true).test(directoryPath));

/** Half a pattern is what the Search box sends on every keystroke, and it must match nothing, not throw. */
const NEVER = /(?!)/;

function compiled(pattern: string, forDirectory: boolean): RegExp {
	const key = forDirectory ? `d:${pattern}` : pattern;
	const known = cache.get(key);
	if (known) return known;

	let built: RegExp;
	try {
		built = new RegExp(`^${source(pattern, forDirectory)}$`);
	} catch {
		built = NEVER;
	}
	// Bounded, since every half-typed pattern in the Search box arrives here.
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(key, built);
	return built;
}

function source(pattern: string, forDirectory: boolean): string {
	let out = '';
	let braces = 0;
	for (let at = 0; at < pattern.length; at += 1) {
		const char = pattern[at];
		const rest = pattern.slice(at);
		if (rest.startsWith('/**/')) {
			// `**` stands for no directory at all as well as for several, so `src/**/a` holds `src/a`.
			out += '\\/(?:.*\\/)?';
			at += 3;
		} else if (rest.startsWith('/**')) {
			// The tail of a pattern, where a directory is what the walk is asking about.
			out += forDirectory && at + 3 === pattern.length ? '(?:\\/.*)?' : '\\/.*';
			at += 2;
		} else if (rest.startsWith('**/')) {
			out += '(?:.*\\/)?';
			at += 2;
		} else if (char === '*') {
			out += pattern[at + 1] === '*' ? (at += 1) && '.*' : '[^/]*';
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '{') {
			braces += 1;
			out += '(?:';
		} else if (char === '}' && braces > 0) {
			braces -= 1;
			out += ')';
		} else if (char === ',' && braces > 0) {
			out += '|';
		} else if (char === '[') {
			const end = pattern.indexOf(']', at + 1);
			if (end === -1) {
				out += '\\[';
			} else {
				const body = pattern.slice(at + 1, end);
				out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
				at = end;
			}
		} else {
			out += escapeRegExp(char ?? '');
		}
	}
	return out;
}
