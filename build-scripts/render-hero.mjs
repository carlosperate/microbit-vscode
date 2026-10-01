import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromeCandidates } from './dev-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heroDir = path.join(root, 'assets', 'hero');
const svgPath = path.join(heroDir, 'hero.svg');
const pngPath = path.join(heroDir, 'hero.png');

export function readPngSize(buf) {
	if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG file');
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="(\\d+(?:\\.\\d+)?)"`))?.[1];

export function canvasSize(svg) {
	const tag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
	const [width, height] = [attr(tag, 'width'), attr(tag, 'height')].map(Number);
	if (!width || !height) throw new Error('The root <svg> needs a width and height');
	return { width, height };
}

export function declaredImages(svg) {
	const images = [];
	for (const [tag] of svg.matchAll(/<image\b[^>]*>/g)) {
		const href = tag.match(/\bhref="([^"]+)"/)?.[1];
		if (!href || href.startsWith('data:')) continue;
		images.push({ href, width: Number(attr(tag, 'width')), height: Number(attr(tag, 'height')) });
	}
	return images;
}

// The crop viewBox in hero.svg is in screenshot pixels, so a size change needs it updated.
async function checkScreenshots(svg) {
	for (const { href, width, height } of declaredImages(svg)) {
		const actual = readPngSize(await readFile(path.join(heroDir, href)));
		if (actual.width !== width || actual.height !== height) {
			throw new Error(
				`${href} is ${actual.width}x${actual.height} but hero.svg declares ${width}x${height}. ` +
					'Update the <image> size and the crop viewBox in hero.svg.',
			);
		}
	}
}

async function render() {
	const svg = await readFile(svgPath, 'utf8');
	await checkScreenshots(svg);
	const { width, height } = canvasSize(svg);

	const binary = chromeCandidates().find((candidate) => existsSync(candidate));
	if (!binary) throw new Error('Chrome not found, set CHROME_PATH.');

	// A throwaway profile stops a running Chrome from swallowing the headless launch.
	const profile = await mkdtemp(path.join(tmpdir(), 'microbit-hero-'));
	try {
		const child = spawn(
			binary,
			[
				'--headless=new',
				'--disable-gpu',
				'--hide-scrollbars',
				'--force-device-scale-factor=1',
				`--user-data-dir=${profile}`,
				`--window-size=${width},${height}`,
				'--virtual-time-budget=4000',
				`--screenshot=${pngPath}`,
				pathToFileURL(svgPath).href,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		// On a fresh profile Chrome lingers after writing the file, so stop it once it reports.
		const written = await new Promise((resolve, reject) => {
			let seen = false;
			const watch = (chunk) => {
				if (seen || !chunk.toString().includes('written to file')) return;
				seen = true;
				child.kill();
			};
			child.stdout.on('data', watch);
			child.stderr.on('data', watch);
			child.once('error', reject);
			child.once('exit', () => resolve(seen));
		});
		if (!written) throw new Error('Chrome exited without writing the screenshot');
	} finally {
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
	console.log(`Wrote ${path.relative(root, pngPath)} (${width}x${height})`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await render();
