import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function getBuildOptions() {
	// Inlined rather than fetched at runtime: the extension host is a worker with
	// no filesystem provider for its own http-served resources.
	const welcomeHtml = readFileSync(path.join(here, 'media', 'welcome.html'), 'utf8');

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
		define: { __WELCOME_HTML__: JSON.stringify(welcomeHtml) },
	};
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	esbuild.build(getBuildOptions()).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
