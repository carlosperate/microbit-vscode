import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function getBuildOptions() {
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

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	esbuild.build(getBuildOptions()).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
