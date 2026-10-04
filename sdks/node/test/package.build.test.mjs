import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = fileURLToPath(new URL("..", import.meta.url));
const sdkManifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath ?? join(
  dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js",
);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shardx-package-build-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, ".npmrc"), readFileSync(join(sdkRoot, ".npmrc")));
  writeFileSync(join(root, "user.npmrc"), "");
  writeFileSync(join(root, "blocked.mjs"),
    "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync('lifecycle-ran', 'unexpected');\nprocess.exit(1);\n");
  writeFileSync(join(root, "build.mjs"),
    "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
    "mkdirSync('dist', { recursive: true });\n" +
    "writeFileSync('dist/index.js', 'export const built = true;\\n');\n" +
    "writeFileSync('dist/index.d.ts', 'export declare const built: true;\\n');\n");
  const dependency = join(root, "dependency");
  mkdirSync(dependency);
  writeFileSync(join(dependency, "blocked.mjs"), readFileSync(join(root, "blocked.mjs")));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({
    name: "shardx-fixture-dependency", version: "1.0.0",
    scripts: { install: "node blocked.mjs", postinstall: "node blocked.mjs" },
  }));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "shardx-fixture", version: "1.0.0", type: "module", main: "dist/index.js",
    dependencies: { "shardx-fixture-dependency": "file:./dependency" },
    scripts: {
      build: "node build.mjs", prepack: sdkManifest.scripts.prepack,
      preinstall: "node blocked.mjs", install: "node blocked.mjs",
      postinstall: "node blocked.mjs", prepare: "node blocked.mjs",
    },
  }));
  return root;
}

function packageEnvironment(root, inherited = process.env) {
  // Isolate the fixture from environment/user npm settings that override .npmrc.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.toLowerCase().startsWith("npm_config_") &&
    !key.toUpperCase().startsWith("GIT_")
  ));
  Object.assign(env, {
    npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
  });
  return env;
}

function runNpm(root, args) {
  assert.ok(existsSync(npmCli), "Run these tests through npm test");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root, env: packageEnvironment(root), encoding: "utf8",
    windowsHide: true, timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test("Git preparation has an explicit build hook and disabled nested install scripts", (t) => {
  assert.equal(sdkManifest.scripts.prepack, "npm run build");
  const root = fixture(t);
  assert.equal(runNpm(root, ["config", "get", "ignore-scripts"]), "true");
});

test("package fixtures discard ambient npm and Git configuration", () => {
  const env = packageEnvironment(tmpdir(), {
    PATH: "fixture-path", npm_config_ignore_scripts: "false",
    GIT_DIR: "foreign-repository", GIT_WORK_TREE: "foreign-worktree",
    GIT_INDEX_FILE: "foreign-index", GIT_TEMPLATE_DIR: "foreign-hooks",
    git_config_count: "1", GIT_CONFIG_KEY_0: "fixture", GIT_CONFIG_VALUE_0: "fixture",
  });
  assert.equal(env.PATH, "fixture-path");
  assert.equal(env.npm_config_ignore_scripts, undefined);
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase().startsWith("GIT_")), []);
});

test("nested offline npm install skips package and dependency lifecycle hooks", (t) => {
  const root = fixture(t);
  runNpm(root, ["install", "--package-lock=false"]);
  assert.equal(existsSync(join(root, "lifecycle-ran")), false);
  assert.equal(existsSync(join(root, "dependency", "lifecycle-ran")), false);
  assert.equal(existsSync(join(root, "dist")), false);
});

test("explicit prepack builds exports even while automatic lifecycle scripts are disabled", (t) => {
  const root = fixture(t);
  runNpm(root, ["run", "prepack"]);
  assert.equal(readFileSync(join(root, "dist", "index.js"), "utf8"),
    "export const built = true;\n");
  assert.ok(existsSync(join(root, "dist", "index.d.ts")));
  assert.equal(existsSync(join(root, "lifecycle-ran")), false);
});

test("pnpm 11 prepares a pinned local Git SDK subdirectory only after exact build approval", {
  skip: !process.env.SHARDX_TEST_PNPM_CLI,
  timeout: 60000,
}, (t) => {
  const pnpmCli = process.env.SHARDX_TEST_PNPM_CLI;
  assert.ok(existsSync(pnpmCli));
  const root = fixture(t);
  const repository = join(root, "repository");
  const sdkDirectory = join(repository, "sdks", "node");
  mkdirSync(sdkDirectory, { recursive: true });
  for (const name of [".npmrc", "package.json", "build.mjs", "blocked.mjs", "dependency"]) {
    cpSync(join(root, name), join(sdkDirectory, name), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8"));
  manifest.name = sdkManifest.name;
  manifest.files = ["dist"];
  // A local dev dependency exercises nested npm scripts without any registry traffic.
  manifest.devDependencies = manifest.dependencies;
  delete manifest.dependencies;
  delete manifest.scripts.prepare;
  // Match the real SDK, which has no consumer-time install hooks.
  delete manifest.scripts.preinstall;
  delete manifest.scripts.install;
  delete manifest.scripts.postinstall;
  writeFileSync(join(sdkDirectory, "dependency", "blocked.mjs"),
    "import { writeFileSync } from 'node:fs';\n" +
    `writeFileSync(${JSON.stringify(join(root, "git-lifecycle-ran"))}, 'unexpected');\n` +
    "process.exit(1);\n");
  writeFileSync(join(sdkDirectory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "shardx-git-fixture-root", version: "1.0.0", private: true,
  }));
  writeFileSync(join(repository, "package-lock.json"), JSON.stringify({
    name: "shardx-git-fixture-root", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "shardx-git-fixture-root", version: "1.0.0" } },
  }));
  const env = packageEnvironment(root);
  // Keep fixture Git commands independent of user hooks, signing and URL rewrites.
  writeFileSync(join(root, "user.gitconfig"), "");
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: join(root, "user.gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  });
  function runGit(args) {
    const result = spawnSync("git", [
      "-c", "core.hooksPath=" + join(root, "no-hooks"),
      "-c", "commit.gpgSign=false", "-c", "user.name=SDK fixture",
      "-c", "user.email=sdk-fixture@example.invalid", ...args,
    ], { cwd: repository, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  }
  runGit(["init", "--quiet"]);
  runGit(["add", "package.json", "package-lock.json", "sdks/node"]);
  runGit(["commit", "--quiet", "-m", "fixture: exercise SDK Git preparation"]);
  const commit = runGit(["rev-parse", "HEAD"]);
  const source = `git+${pathToFileURL(repository).href}#${commit}&path:sdks/node`;
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "shardx-git-consumer-fixture", version: "1.0.0", private: true, type: "module",
    dependencies: { [sdkManifest.name]: source },
  }));
  writeFileSync(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
  function install() {
    const result = spawnSync(process.execPath, [
      pnpmCli, "install", "--offline", "--ignore-scripts=false",
      "--store-dir", join(root, "pnpm-store"), "--reporter=append-only",
    ], { cwd: consumer, env, encoding: "utf8", windowsHide: true, timeout: 25000 });
    assert.ifError(result.error);
    return result;
  }
  const denied = install();
  assert.notEqual(denied.status, 0);
  assert.match(`${denied.stdout}\n${denied.stderr}`, /GIT_DEP_PREPARE_NOT_ALLOWED/);
  assert.equal(existsSync(join(consumer, "node_modules", "@proxyshard", "shardx", "dist")), false);
  writeFileSync(join(consumer, "pnpm-workspace.yaml"),
    `packages: []\nallowBuilds:\n  ${JSON.stringify(`${sdkManifest.name}@${source}`)}: true\n`);
  const installed = install();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const imported = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    "import { built } from '@proxyshard/shardx'; if (built !== true) process.exit(1);",
  ], { cwd: consumer, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
  assert.ok(lockfile.includes(commit));
  assert.ok(lockfile.includes("sdks/node"));
  assert.equal(existsSync(join(root, "git-lifecycle-ran")), false);
  for (const directory of [sdkDirectory, join(sdkDirectory, "dependency")]) {
    assert.equal(existsSync(join(directory, "lifecycle-ran")), false);
  }
});
