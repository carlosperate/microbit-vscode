/**
 * VS Code web source build.
 *
 * Reads the pinned version from config/vscode-web.config.json, shallow-clones
 * microsoft/vscode at that tag, applies the vendored bootstrap patch
 * (build-scripts/vscode/workbench.ts), runs `gulp vscode-web-min`, and publishes
 * the result to <cache>/vscode-web/ — the single consumable bundle that
 * build.mjs and fetch-vscode-web.mjs read and version-check.
 *
 * Layout under the cache dir (default ./.cache):
 *   vscode-build/            build scratch (disposable)
 *     vscode-repo/           the clone
 *     vscode-web/            gulp's raw output (name forced by upstream)
 *   vscode-web/              published consumable bundle  <-- readers use this
 *
 * Script requirements: Node 22+ and yarn (classic), git, a C/C++ toolchain
 * + native headers for VS Code's node-gyp deps
 *
 * Configuration precedence: CLI flag > env var > config file.
 *
 *  - version:   --version <tag>,    VSCODE_VERSION, config.vscodeVersion
 *  - repo slug: --repo <owner/name>, REPO_SLUG,     config.repoSlug
 *  - cache dir: --build-dir <path>,  BUILD_DIR,      default ./.cache
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse the supported `--flag value` / `--flag=value` options. */
function parseArgs(argv) {
  const opts = {};
  const map = { '--version': 'version', '--repo': 'repoSlug', '--build-dir': 'buildDir' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const key = map[flag];
    if (!key) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    opts[key] = inlineValue ?? argv[++i];
    if (opts[key] === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
  }
  return opts;
}

/** Resolve effective settings from CLI args, env vars, and the config file. */
function resolveConfig(cliOpts = {}) {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, 'config', 'vscode-web.config.json'), 'utf8')
  );
  const vscodeVersion = cliOpts.version ?? process.env.VSCODE_VERSION ?? config.vscodeVersion;
  const repoSlug = cliOpts.repoSlug ?? process.env.REPO_SLUG ?? config.repoSlug;
  const cacheDir = path.resolve(
    cliOpts.buildDir ?? process.env.BUILD_DIR ?? path.join(root, '.cache')
  );
  if (!vscodeVersion) {
    throw new Error('No VS Code version set (config "vscodeVersion", VSCODE_VERSION, or --version).');
  }
  return { vscodeVersion, repoSlug, cacheDir };
}

/** Run a command, inheriting stdio, with a chosen cwd. */
function run(cmd, args, cwd, env) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd=${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** Read the exact tag the clone's HEAD points at, or null if it can't be determined. */
function currentTag(cloneDir) {
  try {
    return execFileSync('git', ['-C', cloneDir, 'describe', '--tags', '--exact-match'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Shallow-clone microsoft/vscode at the pinned tag.
 *
 * Reuses an existing clone only when its checked-out tag matches the requested
 * version; otherwise wipes and re-clones, so bumping the version can never
 * silently rebuild the old tree. A matching clone is reused as-is, so in-tree
 * edits to a matching tag survive between runs.
 */
function cloneVscode(vscodeVersion, scratchDir, cloneDir) {
  if (fs.existsSync(cloneDir)) {
    const current = currentTag(cloneDir);
    if (current === vscodeVersion) {
      console.log(`Reusing existing clone at ${cloneDir} (${current}).`);
      return;
    }
    console.log(`Clone is at ${current ?? 'unknown'}, want ${vscodeVersion} — re-cloning.`);
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
  run('git', [
    'clone', '--depth', '1', '--branch', vscodeVersion,
    'https://github.com/microsoft/vscode.git', cloneDir,
  ], scratchDir);
}

/** Copy the vendored bootstrap patch over the upstream workbench entrypoint. */
function applyWorkbenchPatch(vscodeVersion, cloneDir) {
  const target = path.join(cloneDir, 'src', 'vs', 'code', 'browser', 'workbench', 'workbench.ts');
  if (!fs.existsSync(target)) {
    throw new Error(
      `upstream moved the workbench entrypoint — patch may need rebasing ` +
      `against vscodeVersion=${vscodeVersion}\n` +
      `  expected: ${path.relative(cloneDir, target)}`
    );
  }
  fs.copyFileSync(path.join(root, 'build-scripts', 'vscode', 'workbench.ts'), target);
}

/**
 * Publish gulp's freshly built bundle to the consumable location.
 *
 * gulp writes to <scratch>/vscode-web (a sibling of the clone; the name is
 * forced by upstream). We verify it exists and that its version matches what we
 * built, then atomically replace <cache>/vscode-web — the single bundle that
 * build.mjs and fetch-vscode-web.mjs read and version-check. This runs only on
 * gulp success (a failed build aborts before reaching here), so the consumable
 * is never partial; a stale (wrong-version) consumable is caught by the version
 * assert here and by the readers' own version check.
 */
function collectOutput(vscodeVersion, scratchDir, outputDir) {
  const builtOutput = path.join(scratchDir, 'vscode-web');
  if (!fs.existsSync(builtOutput)) {
    throw new Error(`expected gulp output at ${builtOutput} but it does not exist`);
  }
  const builtVersion = JSON.parse(
    fs.readFileSync(path.join(builtOutput, 'package.json'), 'utf8')
  ).version;
  if (builtVersion !== vscodeVersion) {
    throw new Error(
      `built bundle reports version ${builtVersion} but we built ${vscodeVersion}; refusing to publish`
    );
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.renameSync(builtOutput, outputDir);
}

function main(cliOpts = {}) {
  const { vscodeVersion, repoSlug, cacheDir } = resolveConfig(cliOpts);
  const scratchDir = path.join(cacheDir, 'vscode-build');
  const cloneDir = path.join(scratchDir, 'vscode-repo');
  const outputDir = path.join(cacheDir, 'vscode-web');

  console.log(`Building vscode-web ${vscodeVersion} (repoSlug=${repoSlug})`);
  fs.mkdirSync(scratchDir, { recursive: true });

  cloneVscode(vscodeVersion, scratchDir, cloneDir);
  run('yarn', ['install', '--frozen-lockfile'], cloneDir, {
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  });
  applyWorkbenchPatch(vscodeVersion, cloneDir);
  run('yarn', ['gulp', 'vscode-web-min'], cloneDir);
  collectOutput(vscodeVersion, scratchDir, outputDir);

  console.log(`\nDone. VS Code web bundle published to ${outputDir}`);
}

export { parseArgs, resolveConfig, main };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(parseArgs(process.argv.slice(2)));
}
