import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sirv from 'sirv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const LINUX_BINARIES = ['google-chrome', 'google-chrome-stable', 'chrome', 'chromium', 'chromium-browser'];

/**
 * Where Chrome might be, best first. `CHROME_PATH` wins so a different channel
 * or a Chromium build can be pointed at without touching this list. The win32
 * and posix joins are explicit so the answer does not depend on the host.
 */
export function chromeCandidates(platform = process.platform, env = process.env) {
	if (env.CHROME_PATH) return [env.CHROME_PATH];
	if (platform === 'darwin') {
		return [
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
		];
	}
	if (platform === 'win32') {
		// 32-bit installs land under Program Files (x86), per-user ones under LOCALAPPDATA.
		const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean);
		const searched = roots.length ? roots : ['C:\\Program Files'];
		return [...new Set(searched.map((base) => path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')))];
	}
	// Distros disagree on both the name and the directory, so cover PATH as well.
	const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
	return [...new Set(LINUX_BINARIES.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name))))];
}

/**
 * Chrome keeps every scrap of origin state in its profile directory, so a
 * throwaway one is what makes each run start clean: VS Code Web holds settings,
 * open editors and extension `globalState` in IndexedDB.
 */
async function launchChrome(url) {
	const binary = chromeCandidates().find((candidate) => existsSync(candidate));
	if (!binary) {
		console.log('Chrome not found, open the URL yourself or set CHROME_PATH.');
		return undefined;
	}
	const profile = await mkdtemp(path.join(tmpdir(), 'microbit-ide-'));
	const child = spawn(
		binary,
		[`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url],
		{ stdio: 'ignore' }
	);
	console.log(`Chrome launched on a throwaway profile: ${profile}`);
	// Windows holds the profile's files briefly after Chrome goes, hence the retries.
	const discard = () =>
		rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
	return { child, discard };
}

// A child, since build.mjs runs on import; a failed build has already said why.
function build() {
	return new Promise((resolve) => {
		spawn(process.execPath, [path.join(root, 'build-scripts', 'build.mjs')], { stdio: 'inherit' }).on('exit', (code) =>
			code === 0 ? resolve() : process.exit(code ?? 1)
		);
	});
}

export function serve({ port = Number(process.env.PORT ?? 8080) } = {}) {
	const assets = sirv(dist, { dev: true, single: true });
	const server = createServer((req, res) =>
		assets(req, res, () => {
			res.statusCode = 404;
			res.end('Not found');
		})
	);
	return server.listen(port, () => console.log(`Serving dist/ on http://localhost:${port}/`));
}

// `file://${argv[1]}` never matches on Windows, where argv[1] is `C:\...` and
// the URL is `file:///C:/...`, leaving the server unstarted.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await build();
	const port = Number(process.env.PORT ?? 8080);
	serve({ port });
	const chrome = process.argv.includes('--no-browser') ? undefined : await launchChrome(`http://localhost:${port}/`);
	// Closing the window ends the run, and the profile goes with it. One guarded
	// path for both exits: racing them lets an early `process.exit` abort the
	// removal, and Chrome must be gone before it, or it writes the files back.
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (chrome) {
			if (chrome.child.exitCode === null && !chrome.child.killed) {
				const exited = new Promise((done) => chrome.child.once('exit', done));
				chrome.child.kill();
				await exited;
			}
			await chrome.discard();
		}
		process.exit(0);
	};
	chrome?.child.on('exit', shutdown);
	for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
}
