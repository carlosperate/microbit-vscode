/**
 * Host-side wrapper for the Dockerised VS Code source build.
 *
 * Builds the build image from build-scripts/vscode/Dockerfile, then runs it
 * with the repo mounted at /work. The in-container entrypoint
 * (build-scripts/vscode/build-vscode.mjs) does the actual clone + patch +
 * gulp vscode-web-min, saving the final build to .cache/vscode-web/.
 *
 * Docker resources: the VSCode build runs Node with an 8 GB heap and is
 * memory-hungry. Give Docker ≥9 GB RAM, or GC-thrashes and appears to hang.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'microbit-vscode-build';
const RECOMMENDED_MEM_GIB = 9;

/** Warn early if the Docker VM has too little RAM for the gulp mangler/minify. */
function warnIfLowMemory() {
  const info = spawnSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' });
  const memBytes = Number(info.stdout?.trim());
  if (!Number.isFinite(memBytes) || memBytes <= 0) return;
  const memGiB = memBytes / 1024 ** 3;
  if (memGiB < RECOMMENDED_MEM_GIB) {
    console.warn(
      `\n⚠  Docker has configured only ${memGiB.toFixed(1)} GiB RAM. The VS Code build requests an 8 GB\n` +
      `   Node heap and needs ≥${RECOMMENDED_MEM_GIB} GiB to avoid GC thrashing (it tends to stall at the\n` +
      `   "compile-src"/mangler step otherwise).\n`
    );
  }
}

/** Build the Docker image from build-scripts/vscode/Dockerfile. Returns its exit status. */
function buildImage() {
  return spawnSync('docker', ['build', '-t', TAG, 'build-scripts/vscode'],
    { stdio: 'inherit', cwd: root }).status ?? 1;
}

/** Run the build container with the repo mounted at /work. Returns its exit status. */
function runContainer() {
  // The build clone must live OUTSIDE /work: TypeScript resolves `import 'vscode'`
  // by walking up node_modules, and if the clone sits under /work it finds our
  // repo's @types/vscode and compiles it against the wrong VS Code version. So we
  // mount the host .cache at /build (a node_modules-free parent) and point the
  // build there via BUILD_DIR. The clone/scratch live in .cache/vscode-build and
  // the published bundle in .cache/vscode-web — same host dir, just addressed via
  // /build so the in-container path has a clean parent.
  const cacheDir = path.join(root, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const args = [
    'run',
    '--rm',
    '-e', 'HOME=/tmp',
    '-e', 'BUILD_DIR=/build',
    '-v', `${root}:/work`,
    '-v', `${cacheDir}:/build`,
  ];
  if (os.platform() !== 'win32') {
    // On macOS/Linux pass --user $(id -u):$(id -g) so files in .cache/ are
    // owned by the invoking user rather than root.
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  args.push(TAG);
  return spawnSync('docker', args, { stdio: 'inherit', cwd: root }).status ?? 1;
}

function main() {
  warnIfLowMemory();
  const buildStatus = buildImage();
  if (buildStatus !== 0) process.exit(buildStatus);
  process.exit(runContainer());
}

export { warnIfLowMemory, buildImage, runContainer, main };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
