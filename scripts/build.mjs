#!/usr/bin/env node
import { cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const vscodeWebDist = path.join(root, 'node_modules', 'vscode-web', 'dist');
const publicDir = path.join(root, 'public');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

console.log('Copying vscode-web → dist/vscode/');
await cp(vscodeWebDist, path.join(dist, 'vscode'), { recursive: true });

console.log('Copying public/ → dist/');
await cp(publicDir, dist, { recursive: true });

console.log('Build complete: dist/');
