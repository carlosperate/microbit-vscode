import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Full esbuild options for this extension.
 * The project extensions orchestrator imports these options and overrides
 * what it needs to pack the extension for the VS Code deployment.
 */
export async function getBuildOptions() {
	return {
		entryPoints: [path.join(here, 'src', 'extension.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2020',
		external: ['vscode'],
		outfile: path.join(here, 'dist', 'extension.js'),
		sourcemap: true,
		logLevel: 'warning',
	};
}

// Built standalone (`node esbuild.config.mjs`): bundle into the extension's own
// `dist/`. The package.json next to this file already points `browser` at it,
// so the extension folder is directly loadable after a standalone build.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	getBuildOptions()
		.then((options) => esbuild.build(options))
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}
