import esbuild from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'extensions', 'workspace-storage');
const outDir = path.join(root, 'dist', 'extensions', 'microbit.workspace-storage');

export async function buildWorkspaceStorageExtension() {
	await mkdir(path.join(outDir, 'dist'), { recursive: true });
	await esbuild.build({
		entryPoints: [path.join(srcDir, 'src', 'extension.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2020',
		external: ['vscode'],
		outfile: path.join(outDir, 'dist', 'extension.js'),
		sourcemap: true,
		logLevel: 'warning',
	});
	await copyFile(path.join(srcDir, 'package.json'), path.join(outDir, 'package.json'));
	// Empty NLS stub so VS Code's localized-strings probe doesn't 404.
	await writeFile(path.join(outDir, 'package.nls.json'), '{}\n');
	return { scheme: 'http', path: '/extensions/microbit.workspace-storage' };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	buildWorkspaceStorageExtension().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
