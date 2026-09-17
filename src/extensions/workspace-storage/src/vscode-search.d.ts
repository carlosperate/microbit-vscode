/**
 * The search provider API, which is proposed rather than stable, so `@types/vscode`
 * does not carry it. Only what `search.ts` uses, matching the shape VS Code 1.91
 * serves; `enabledApiProposals` in the manifest is what lets this extension call it.
 */
declare module 'vscode' {
	export interface SearchOptions {
		folder: Uri;
		includes: string[];
		excludes: string[];
		useIgnoreFiles: boolean;
		followSymlinks: boolean;
		useGlobalIgnoreFiles: boolean;
		useParentIgnoreFiles: boolean;
	}

	export interface FileSearchQuery {
		pattern: string;
	}

	export interface FileSearchOptions extends SearchOptions {
		maxResults?: number;
		session?: CancellationToken;
	}

	export interface FileSearchProvider {
		provideFileSearchResults(
			query: FileSearchQuery,
			options: FileSearchOptions,
			token: CancellationToken
		): ProviderResult<Uri[]>;
	}

	export interface TextSearchQuery {
		pattern: string;
		isMultiline?: boolean;
		isRegExp?: boolean;
		isCaseSensitive?: boolean;
		isWordMatch?: boolean;
	}

	export interface TextSearchPreviewOptions {
		matchLines: number;
		charsPerLine: number;
	}

	export interface TextSearchOptions extends SearchOptions {
		/** Absent for an unlimited search, whatever the proposal's own `.d.ts` says. */
		maxResults?: number;
		previewOptions?: TextSearchPreviewOptions;
		maxFileSize?: number;
		encoding?: string;
		beforeContext?: number;
		afterContext?: number;
	}

	export interface TextSearchMatch {
		uri: Uri;
		ranges: Range | Range[];
		preview: { text: string; matches: Range | Range[] };
	}

	export interface TextSearchComplete {
		limitHit?: boolean;
	}

	export interface TextSearchProvider {
		provideTextSearchResults(
			query: TextSearchQuery,
			options: TextSearchOptions,
			progress: Progress<TextSearchMatch>,
			token: CancellationToken
		): ProviderResult<TextSearchComplete>;
	}

	export namespace workspace {
		export function registerFileSearchProvider(scheme: string, provider: FileSearchProvider): Disposable;
		export function registerTextSearchProvider(scheme: string, provider: TextSearchProvider): Disposable;
	}
}
