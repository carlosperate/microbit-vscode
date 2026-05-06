import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { unpackVsix } from './lib/vsix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'scripts', 'extensions.config.json');
const cacheDir = path.join(root, '.cache', 'vsix');
const distExtensions = path.join(root, 'dist', 'extensions');

async function exists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveVersion(publisher, name) {
	const url = `https://open-vsx.org/api/${publisher}/${name}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch metadata for ${publisher}.${name}: ${res.status}`);
	}
	const data = await res.json();
	return data.version;
}

async function downloadVsix(publisher, name, version, destPath) {
	const url = `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${publisher}.${name}-${version}.vsix`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to download VSIX for ${publisher}.${name}@${version}: ${res.status}`);
	}
	await mkdir(path.dirname(destPath), { recursive: true });
	await finished(Readable.fromWeb(res.body).pipe(createWriteStream(destPath)));
}

export async function fetchAndUnpackExtensions() {
	const config = JSON.parse(await readFile(configPath, 'utf8'));
	await mkdir(cacheDir, { recursive: true });
	await mkdir(distExtensions, { recursive: true });

	const refs = [];
	for (const { publisher, name, version: pinned } of config) {
		const version = pinned ?? (await resolveVersion(publisher, name));
		const id = `${publisher}.${name}`;
		const vsixPath = path.join(cacheDir, `${id}-${version}.vsix`);

		if (await exists(vsixPath)) {
			console.log(`Cached    ${id}@${version}`);
		} else {
			console.log(`Downloading ${id}@${version}`);
			await downloadVsix(publisher, name, version, vsixPath);
		}

		const outDir = path.join(distExtensions, id);
		await unpackVsix(vsixPath, outDir);

		const pkg = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
		if (!pkg.browser) {
			console.warn(
				`⚠️  ${id} has no "browser" entry — likely won't run in vscode-web (main: ${pkg.main ?? 'n/a'})`
			);
		}

		// VS Code probes every extension for package.nls.json (localized strings).
		// Most extensions don't ship one, producing dozens of harmless 404 logs.
		// Write an empty {} stub to silence the noise.
		const nlsPath = path.join(outDir, 'package.nls.json');
		if (!(await exists(nlsPath))) {
			await writeFile(nlsPath, '{}\n');
		}

		refs.push({ scheme: 'http', path: `/extensions/${id}` });
	}
	return refs;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	fetchAndUnpackExtensions()
		.then((refs) => {
			console.log('additionalBuiltinExtensions:', JSON.stringify(refs, null, 2));
		})
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}
