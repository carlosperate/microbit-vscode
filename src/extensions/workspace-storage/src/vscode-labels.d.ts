/**
 * The label formatter from the proposed `resolvers` API, which `@types/vscode`
 * does not carry. Only what `extension.ts` uses, as VS Code 1.91 serves it;
 * `enabledApiProposals` in the manifest is what lets this extension call it.
 */
declare module 'vscode' {
	export interface ResourceLabelFormatting {
		label: string;
		separator: '/' | '';
		/** Shown in brackets after the workspace's name, in the Explorer header and the title. */
		workspaceSuffix?: string;
	}

	export interface ResourceLabelFormatter {
		scheme: string;
		formatting: ResourceLabelFormatting;
	}

	export namespace workspace {
		export function registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable;
	}
}
