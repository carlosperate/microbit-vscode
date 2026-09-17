/**
 * Search over the schemes this extension serves. A file system provider alone
 * does not make a workspace searchable: without these, `workspace.findFiles`
 * never settles, which hangs any extension that calls it, and the Search view
 * finds nothing. The query's include and exclude globs are ours to apply: the
 * workbench applies only the include, and only to file results.
 */
import * as vscode from 'vscode';
import { couldMatchInside, escapeRegExp, matchesAny, matchesLoosely } from './glob.js';
import type { EntryType } from './memfs.js';

/** Past this a file is a build output or an asset, not something to grep. */
const MAX_SEARCHABLE_BYTES = 1_000_000;

/** What a search needs of a store. The same shape all three cores already expose. */
export interface SearchableFs {
	readDirectory(path: string): [string, EntryType][] | Promise<[string, EntryType][]>;
	readFile(path: string): Uint8Array | Promise<Uint8Array>;
	/** Only where the size is metadata rather than a read, which is what makes asking worth it. */
	fileSize?(path: string): number | Promise<number>;
}

interface Found {
	/** Absolute in the store, which is what the core takes. */
	path: string;
	/** Relative to the searched folder: what a glob matches. */
	relative: string;
}

/**
 * Read straight from the store rather than through `workspace.fs`, which would
 * leave the extension host and come back to this same extension for every entry.
 * An excluded directory is not descended into.
 */
async function* walk(
	core: SearchableFs,
	options: vscode.SearchOptions,
	token: vscode.CancellationToken
): AsyncGenerator<Found> {
	const queue: Found[] = [{ path: options.folder.path, relative: '' }];
	while (queue.length > 0 && !token.isCancellationRequested) {
		const directory = queue.shift();
		if (!directory) return;
		let entries: [string, EntryType][];
		try {
			entries = await Promise.resolve(core.readDirectory(directory.path));
		} catch {
			// A directory that cannot be read is not a search failure.
			continue;
		}
		for (const [name, type] of entries) {
			const found: Found = {
				path: `${directory.path.replace(/\/$/, '')}/${name}`,
				relative: directory.relative ? `${directory.relative}/${name}` : name,
			};
			if (type === 'directory') {
				if (!couldMatchInside(options.excludes, found.relative)) queue.push(found);
			} else if (!matchesAny(options.excludes, found.relative)) {
				yield found;
			}
		}
	}
}

/** An empty include list is no filter at all, which is what `findFiles` with no pattern means. */
const wanted = (options: vscode.SearchOptions, relative: string) =>
	options.includes.length === 0 || matchesAny(options.includes, relative);

export class WorkspaceFileSearchProvider implements vscode.FileSearchProvider {
	constructor(
		private readonly scheme: string,
		private readonly core: SearchableFs
	) {}

	async provideFileSearchResults(
		query: vscode.FileSearchQuery,
		options: vscode.FileSearchOptions,
		token: vscode.CancellationToken
	): Promise<vscode.Uri[]> {
		const limit = options.maxResults ?? Number.POSITIVE_INFINITY;
		const found: vscode.Uri[] = [];
		for await (const file of walk(this.core, options, token)) {
			// Counted after filtering, or Quick Open's cap of 512 is spent on files
			// nobody typed and the one that was typed never comes back.
			if (!wanted(options, file.relative)) continue;
			if (query.pattern && !matchesLoosely(query.pattern, file.relative)) continue;
			found.push(vscode.Uri.from({ scheme: this.scheme, path: file.path }));
			if (found.length >= limit) break;
		}
		return found;
	}
}

export class WorkspaceTextSearchProvider implements vscode.TextSearchProvider {
	constructor(
		private readonly scheme: string,
		private readonly core: SearchableFs
	) {}

	async provideTextSearchResults(
		query: vscode.TextSearchQuery,
		options: vscode.TextSearchOptions,
		progress: vscode.Progress<vscode.TextSearchMatch>,
		token: vscode.CancellationToken
	): Promise<vscode.TextSearchComplete> {
		let pattern: RegExp;
		try {
			pattern = queryToRegExp(query);
		} catch {
			// A half-typed regular expression is what the Search box sends on every keystroke.
			return {};
		}

		// Unlimited is how the Search view spells `search.maxResults: null`.
		const limit = options.maxResults ?? Number.POSITIVE_INFINITY;
		const cap = options.maxFileSize ?? MAX_SEARCHABLE_BYTES;
		let hits = 0;
		for await (const file of walk(this.core, options, token)) {
			if (hits >= limit || token.isCancellationRequested) break;
			if (!wanted(options, file.relative)) continue;
			const text = await readText(this.core, file.path, cap);
			if (text === undefined) continue;

			const uri = vscode.Uri.from({ scheme: this.scheme, path: file.path });
			for (const match of matchesIn(pattern, text)) {
				progress.report({ uri, ranges: match.range, preview: match.preview });
				if ((hits += 1) >= limit) break;
			}
		}
		return { limitHit: hits >= limit };
	}
}

/** `undefined` for anything not worth searching: too big, unreadable, or not text. */
async function readText(core: SearchableFs, path: string, cap: number): Promise<string | undefined> {
	let bytes: Uint8Array;
	try {
		// Where a store can say how big a file is without reading it, a video in a
		// picked folder never reaches the worker's heap at all.
		if (core.fileSize && (await Promise.resolve(core.fileSize(path))) > cap) return undefined;
		bytes = await Promise.resolve(core.readFile(path));
	} catch {
		return undefined;
	}
	// A NUL in the first block is the usual tell, and the cheapest one.
	if (bytes.byteLength > cap || bytes.subarray(0, 1024).includes(0)) return undefined;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function queryToRegExp(query: vscode.TextSearchQuery): RegExp {
	// A typed newline has to find a file saved on Windows too. Only for a literal
	// query: inside a regular expression the newline is the author's to place.
	const source = query.isRegExp ? query.pattern : escapeRegExp(query.pattern).replace(/\\?\n/g, '\\r?\\n');
	const bounded = query.isWordMatch ? `\\b(?:${source})\\b` : source;
	// `m` alone, never `s`: a multiline query matches across lines through its own newlines.
	return new RegExp(bounded, `gm${query.isCaseSensitive ? '' : 'i'}`);
}

interface Match {
	range: vscode.Range;
	preview: { text: string; matches: vscode.Range };
}

/**
 * Over the whole text rather than line by line, so a query carrying a newline
 * finds what spans one. Offsets become lines through a table built on the first
 * match, which most files never reach, and read with a cursor that only advances.
 */
function* matchesIn(pattern: RegExp, text: string): Generator<Match> {
	let starts: number[] | undefined;
	let line = 0;
	pattern.lastIndex = 0;
	let found: RegExpExecArray | null;
	while ((found = pattern.exec(text)) !== null) {
		// A pattern that can match nothing, such as `a*`, would otherwise never advance.
		if (found[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		starts ??= lineStarts(text);
		const at = (offset: number) => {
			while (line + 1 < starts!.length && starts![line + 1]! <= offset) line += 1;
			return { line, character: offset - starts![line]! };
		};
		const from = at(found.index);
		const startsAt = starts[from.line]!;
		const to = at(found.index + found[0].length);
		const preview = text.slice(startsAt, to.line + 1 < starts.length ? starts[to.line + 1]! - 1 : text.length);
		yield {
			range: new vscode.Range(from.line, from.character, to.line, to.character),
			preview: { text: preview, matches: new vscode.Range(0, from.character, to.line - from.line, to.character) },
		};
	}
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
	return starts;
}
