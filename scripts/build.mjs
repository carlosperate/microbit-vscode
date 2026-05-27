#!/usr/bin/env node
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndUnpackExtensions } from './fetch-openvsx.mjs';
import { buildLocalExtensions } from './build-local-extensions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const vscodeWebDist = path.join(root, 'node_modules', 'vscode-web', 'dist');
const publicDir = path.join(root, 'public');
const productTemplate = path.join(root, 'config', 'product.template.json');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

console.log('Copying vscode-web → dist/vscode/');
await cp(vscodeWebDist, path.join(dist, 'vscode'), { recursive: true });

console.log('Copying public/ → dist/');
await cp(publicDir, dist, { recursive: true });

console.log('Building local extensions:');
const localExtensionRefs = await buildLocalExtensions();

console.log('Fetching Open VSX extensions:');
const openvsxExtensionRefs = await fetchAndUnpackExtensions();

console.log('Generating dist/product.json');
const product = JSON.parse(await readFile(productTemplate, 'utf8'));
const vscodeWebPkg = JSON.parse(
	await readFile(path.join(root, 'node_modules', 'vscode-web', 'package.json'), 'utf8')
);
product.productConfiguration = {
	...product.productConfiguration,
	version: vscodeWebPkg.version,
};
product.additionalBuiltinExtensions = [
	...(product.additionalBuiltinExtensions ?? []),
	...localExtensionRefs,
	...openvsxExtensionRefs,
];
await writeFile(path.join(dist, 'product.json'), JSON.stringify(product, null, '\t') + '\n');

console.log('Build complete 🚀');
