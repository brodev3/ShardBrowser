import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { chromium } from "patchright";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { Browser, Profile, ShardX } from "../dist/index.js";
import { MANIFEST_URL, PUB_BASE } from "../dist/runtime.js";
import { makeNativeBinary, widevineBinaryPath, widevineEntries, writeWidevine } from "./helpers/runtime.fixtures.mjs";

const LOCAL_VERSION = "151.0.7999.7";
const LOCAL_METADATA = {
  installed_chromium_version: LOCAL_VERSION,
  installed_engine_build: "local-build",
  installed_grease_brand: "Local Brand",
  installed_grease_version: "25",
  installed_tls: { cipher_suites: ["local-suite"] },
};
const GEO_RESPONSE = {
  status: "success", query: "192.0.2.1", country: "Germany", countryCode: "DE",
  timezone: "Europe/Berlin", lat: 52.5, lon: 13.4,
};
const LAUNCH_OPTIONS = {
  screenMode: "profile", proxy: "socks5://127.0.0.1:1080", probeTimeoutMs: 1,
};

function fingerprint(auto = false) {
  return {
    name: "template",
    navigator: {
      platform: "Windows", user_agent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
      language: auto ? "auto" : "en-US",
    },
    timezone: auto ? "auto" : "UTC",
    client_hints: { brand_version: "149" },
    tls: { cipher_suites: ["template-suite"] },
  };
}

function engineBinary() {
  return makeNativeBinary();
}

function fixture(t, options = {}) {
  const container = mkdtempSync(join(tmpdir(), "shardx-auto-install-"));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const root = join(container, "cache");
  const sdk = new ShardX({ cacheDir: root, autoInstall: false, ...options });
  const fingerprints = join(root, "fingerprints");
  const widevine = join(root, ...sdk.runtime.spec.widevineSubpath);
  return { sdk, root, fingerprints, widevine };
}

function prepareLocal({ sdk, fingerprints, widevine }) {
  mkdirSync(dirname(sdk.runtime.binaryPath), { recursive: true });
  writeFileSync(sdk.runtime.binaryPath, engineBinary());
  if (process.platform !== "win32") chmodSync(sdk.runtime.binaryPath, 0o755);
  if (sdk.runtime.spec.widevine) {
    writeWidevine(widevine);
  }
  mkdirSync(fingerprints, { recursive: true });
  writeFileSync(join(fingerprints, "template.json"), JSON.stringify(fingerprint()));
  writeFileSync(sdk.runtime.manifestPath, JSON.stringify(LOCAL_METADATA));
}

function snapshot(root) {
  const files = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === "profiles") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const stat = lstatSync(path);
        files[relative(root, path)] = {
          contents: readFileSync(path).toString("hex"), mode: stat.mode, mtime: stat.mtimeMs,
        };
      }
    }
  }
  if (existsSync(root)) walk(root);
  return files;
}

function mockIO(t) {
  const io = {
    installerRequests: [], geoRequests: 0, udpProbes: 0, spawns: [],
    cdpConnections: [], fetchHandler: null, extractArchives: false, onGeo: null,
  };
  const saved = {
    fetch: globalThis.fetch, spawn: childProcess.spawn, spawnSync: childProcess.spawnSync,
    http: http.request, https: https.request, tcp: net.createConnection,
    udp: dgram.createSocket, cdp: chromium.connectOverCDP, dispatcher: getGlobalDispatcher(),
  };
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get("http://ip-api.com").intercept({ path: /\/json\// }).reply(() => {
    io.geoRequests++;
    io.onGeo?.();
    return { statusCode: 200, data: JSON.stringify(GEO_RESPONSE) };
  }).persist();
  setGlobalDispatcher(agent);
  t.after(async () => {
    globalThis.fetch = saved.fetch;
    childProcess.spawn = saved.spawn;
    childProcess.spawnSync = saved.spawnSync;
    http.request = saved.http;
    https.request = saved.https;
    net.createConnection = saved.tcp;
    dgram.createSocket = saved.udp;
    chromium.connectOverCDP = saved.cdp;
    syncBuiltinESMExports();
    setGlobalDispatcher(saved.dispatcher);
    await agent.close();
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === MANIFEST_URL || url.startsWith(PUB_BASE + "/")) {
      io.installerRequests.push(url);
      if (io.fetchHandler) return io.fetchHandler(url);
      throw new Error("unexpected installer request: " + url);
    }
    assert.equal(url, "http://127.0.0.1:9222/json/version");
    return new Response(JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/mock",
    }));
  };
  childProcess.spawn = (binary, args) => {
    io.spawns.push({ binary, args });
    const child = new EventEmitter();
    child.pid = 12345;
    child.kill = (signal) => {
      queueMicrotask(() => {
        child.emit("exit", 0, signal);
        child.emit("close", 0, signal);
      });
      return true;
    };
    if (args.includes("--remote-debugging-port=0")) {
      const udd = args.find((arg) => arg.startsWith("--user-data-dir=")).slice(16);
      writeFileSync(join(udd, "DevToolsActivePort"), "9222\n/mock\n");
    }
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  childProcess.spawnSync = (command, args) => {
    assert.equal(io.extractArchives, true, "unexpected synchronous process");
    assert.equal(command, "unzip");
    new AdmZip(args[2]).extractAllTo(args[4], true);
    return { status: 0, signal: null, stderr: Buffer.alloc(0) };
  };
  const geoRequest = (options, callback) => {
    assert.equal(options.host, "ip-api.com");
    io.geoRequests++;
    io.onGeo?.();
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify(GEO_RESPONSE)));
        response.emit("end");
      });
    };
    return request;
  };
  http.request = geoRequest;
  https.request = () => { throw new Error("unexpected HTTPS request"); };
  net.createConnection = () => {
    io.udpProbes++;
    const socket = new EventEmitter();
    socket.setTimeout = () => socket;
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("error", new Error("mock UDP relay unavailable")));
    return socket;
  };
  dgram.createSocket = () => { throw new Error("unexpected UDP socket"); };
  chromium.connectOverCDP = async (url) => {
    io.cdpConnections.push(url);
    return { close: async () => {} };
  };
  syncBuiltinESMExports();
  return io;
}

function ordinaryOperations(sdk) {
  const profile = () => new Profile(fingerprint(true), "preflight");
  return [
    () => sdk.listProfiles(),
    () => sdk.randomProfile(),
    () => sdk.createProfile("template"),
    () => sdk.createProfile(),
    () => sdk.launch(profile(), LAUNCH_OPTIONS),
    () => sdk.session(profile(), LAUNCH_OPTIONS),
    () => new Browser(sdk.runtime).launch(profile(), LAUNCH_OPTIONS),
  ];
}

async function assertBlocked(sdk, io) {
  sdk.runtime.install = async () => { assert.fail("implicit install must not be called"); };
  for (const operation of ordinaryOperations(sdk)) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.code, "RUNTIME_NOT_INSTALLED");
      assert.match(error.message, /^RUNTIME_NOT_INSTALLED:/);
      return true;
    });
  }
  assert.deepEqual(io.installerRequests, []);
  assert.equal(io.geoRequests, 0);
  assert.equal(io.udpProbes, 0);
  assert.deepEqual(io.spawns, []);
  assert.deepEqual(io.cdpConnections, []);
}

function makeZip(entries) {
  const archive = new AdmZip();
  for (const [name, contents] of Object.entries(entries)) archive.addFile(name, Buffer.from(contents));
  return archive.toBuffer();
}

function allowSyntheticInstall(sdk, io) {
  const { spec } = sdk.runtime;
  const archives = new Map([
    [spec.browser.key, makeZip({ [spec.binarySubpath.join("/")]: engineBinary() })],
    ["ShardX-Fingerprints.zip", makeZip({
      "shardx-fingerprints/template.json": JSON.stringify(fingerprint()),
    })],
  ]);
  if (spec.widevine) {
    const wrapper = spec.widevine.key.replace(/\.zip$/, "");
    archives.set(spec.widevine.key, makeZip(widevineEntries(wrapper + "/WidevineCdm")));
  }
  io.extractArchives = true;
  io.fetchHandler = (url) => {
    if (url === MANIFEST_URL) return new Response(JSON.stringify({
      archives: Object.fromEntries([...archives.keys()].map((key) => [key, "test-etag"])),
      chromium_version: "152.0.7977.65",
    }));
    const archive = archives.get(url.slice((PUB_BASE + "/").length));
    assert.ok(archive, "unexpected mock archive");
    return new Response(archive, {
      headers: { etag: "test-etag", "content-length": String(archive.length) },
    });
  };
  return [MANIFEST_URL, ...[spec.browser, spec.widevine].filter(Boolean)
    .map((archive) => PUB_BASE + "/" + archive.key), PUB_BASE + "/ShardX-Fingerprints.zip"];
}

test("autoInstall false rejects a missing cache before preflight and does not create it", async (t) => {
  const { sdk, root, fingerprints } = fixture(t);
  const io = mockIO(t);
  await assertBlocked(sdk, io);
  assert.equal(sdk.runtime.fingerprintsDir, fingerprints);
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(fingerprints), false);
});

const corruptions = [
  ["missing executable", ({ sdk }) => rmSync(sdk.runtime.binaryPath)],
  ["invalid executable", ({ sdk }) => writeFileSync(sdk.runtime.binaryPath, "not executable")],
  ["executable with only magic bytes", ({ sdk }) => writeFileSync(sdk.runtime.binaryPath, engineBinary().subarray(0, 4))],
  ["truncated executable data", ({ sdk }) => writeFileSync(sdk.runtime.binaryPath, engineBinary().subarray(0, -1))],
  ["library at the executable path", ({ sdk }) => writeFileSync(sdk.runtime.binaryPath, makeNativeBinary("library", process.platform, true))],
  ["missing Widevine", ({ widevine }) => rmSync(widevine, { recursive: true })],
  ["empty Widevine", ({ widevine }) => { rmSync(widevine, { recursive: true }); mkdirSync(widevine); }],
  ["Widevine with only an unrelated file", ({ widevine }) => {
    rmSync(widevine, { recursive: true });
    mkdirSync(widevine);
    writeFileSync(join(widevine, "notes.txt"), "not a CDM");
  }],
  ["Widevine without its library", ({ widevine }) => rmSync(join(widevine, widevineBinaryPath()))],
  ["corrupt Widevine manifest", ({ widevine }) => writeFileSync(join(widevine, "manifest.json"), "{")],
  ["Widevine without a version", ({ widevine }) => writeFileSync(join(widevine, "manifest.json"), "{}")],
  ["Widevine with an invalid version", ({ widevine }) => writeFileSync(join(widevine, "manifest.json"), '{"version":false}')],
  ["truncated Widevine library", ({ widevine }) => writeFileSync(join(widevine, widevineBinaryPath()), makeNativeBinary("cdm", process.platform, true).subarray(0, 4))],
  ["missing fingerprints directory", ({ fingerprints }) => rmSync(fingerprints, { recursive: true })],
  ["empty fingerprint library", ({ fingerprints }) => rmSync(join(fingerprints, "template.json"))],
  ["corrupt fingerprint JSON", ({ fingerprints }) => writeFileSync(join(fingerprints, "template.json"), "{")],
  ["null fingerprint", ({ fingerprints }) => writeFileSync(join(fingerprints, "template.json"), "null")],
  ["array fingerprint", ({ fingerprints }) => writeFileSync(join(fingerprints, "template.json"), "[]")],
  ["mixed valid and corrupt fingerprints", ({ fingerprints }) => writeFileSync(join(fingerprints, "corrupt.json"), "{")],
  ["missing metadata", ({ sdk }) => rmSync(sdk.runtime.manifestPath)],
  ["corrupt metadata JSON", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, "{")],
  ["null metadata", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, "null")],
  ["array metadata", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, "[]")],
  ["missing cached version", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, "{}")],
  ["invalid cached version", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, JSON.stringify({
    ...LOCAL_METADATA, installed_chromium_version: "151.0.0",
  }))],
  ["invalid optional GREASE metadata", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, JSON.stringify({
    ...LOCAL_METADATA, installed_grease_version: 25,
  }))],
  ["invalid optional TLS metadata", ({ sdk }) => writeFileSync(sdk.runtime.manifestPath, JSON.stringify({
    ...LOCAL_METADATA, installed_tls: null,
  }))],
];

for (const [name, corrupt] of corruptions) {
  test("autoInstall false rejects " + name + " without installer requests or repair", async (t) => {
    const local = fixture(t);
    prepareLocal(local);
    corrupt(local);
    const before = snapshot(local.root);
    const io = mockIO(t);
    await assertBlocked(local.sdk, io);
    assert.deepEqual(snapshot(local.root), before);
    assert.equal(existsSync(join(local.root, "profiles")), false);
  });
}

test("autoInstall false rejects a non-executable Unix file without chmod", {
  skip: process.platform === "win32",
}, async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  chmodSync(local.sdk.runtime.binaryPath, 0o644);
  const before = snapshot(local.root);
  await assertBlocked(local.sdk, mockIO(t));
  assert.deepEqual(snapshot(local.root), before);
});

test("autoInstall false loads cached metadata and permits ordinary operations without installing", async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  const { sdk } = local;
  const before = snapshot(local.root);
  const io = mockIO(t);
  sdk.runtime.install = async () => { assert.fail("implicit install must not be called"); };
  assert.deepEqual(await sdk.listProfiles(), ["template"]);
  assert.deepEqual(await sdk.listProfiles({ platform: "Windows" }), ["template"]);
  assert.equal((await sdk.randomProfile()).id, "template");
  assert.ok((await sdk.createProfile("template")).id);
  assert.ok((await sdk.createProfile()).id);
  assert.equal(sdk.runtime.chromiumVersion, LOCAL_VERSION);
  assert.equal(sdk.runtime.greaseBrand, LOCAL_METADATA.installed_grease_brand);
  assert.equal(sdk.runtime.greaseVersion, LOCAL_METADATA.installed_grease_version);
  assert.deepEqual(sdk.runtime.tls, LOCAL_METADATA.installed_tls);
  for (const launcher of [sdk, new Browser(sdk.runtime)]) {
    const session = await launcher.launch(new Profile(fingerprint()), { screenMode: "profile" });
    const saved = JSON.parse(readFileSync(join(session.userDataDir, "fingerprint.json"), "utf8"));
    assert.match(saved.navigator.user_agent, /Chrome\/151\.0\.0\.0/);
    assert.equal(saved.client_hints.brand_full_version, LOCAL_VERSION);
    assert.equal(saved.client_hints.grease_brand, LOCAL_METADATA.installed_grease_brand);
    assert.deepEqual(saved.tls, LOCAL_METADATA.installed_tls);
    await session.stop();
  }
  const session = await sdk.session(new Profile(fingerprint()), { screenMode: "profile" });
  assert.equal(io.cdpConnections.length, 1);
  await session.close();
  assert.equal(io.spawns.length, 3);
  assert.deepEqual(io.installerRequests, []);
  assert.deepEqual(snapshot(local.root), before);
});

test("autoInstall false preserves geo checks, UDP probes and session CDP after readiness", async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  const io = mockIO(t);
  const session = await local.sdk.session(new Profile(fingerprint(true)), LAUNCH_OPTIONS);
  assert.equal(io.geoRequests, 1);
  assert.equal(io.udpProbes, 1);
  assert.equal(io.spawns.length, 1);
  assert.equal(io.cdpConnections.length, 1);
  assert.equal(session.session.geo.timezone, "Europe/Berlin");
  assert.deepEqual(io.installerRequests, []);
  await session.close();
});

test("autoInstall false detects a recovery marker after a prior check and after restart", async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  const io = mockIO(t);
  await local.sdk.listProfiles();
  writeFileSync(join(local.root, ".runtime-update-recovery"), "unfinished");
  const before = snapshot(local.root);
  await assertBlocked(local.sdk, io);
  const restarted = new ShardX({ cacheDir: local.root, autoInstall: false });
  await assertBlocked(restarted, io);
  assert.deepEqual(snapshot(local.root), before);
});

test("autoInstall false rechecks readiness before spawning after asynchronous preflight", async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  const io = mockIO(t);
  io.onGeo = () => writeFileSync(join(local.root, ".runtime-update-recovery"), "unfinished");
  await assert.rejects(
    local.sdk.launch(new Profile(fingerprint(true)), LAUNCH_OPTIONS),
    { code: "RUNTIME_NOT_INSTALLED" },
  );
  assert.equal(io.geoRequests, 1);
  assert.deepEqual(io.spawns, []);
  assert.deepEqual(io.installerRequests, []);
});

const firstOperations = [
  ["listProfiles", (sdk) => sdk.listProfiles()],
  ["randomProfile", (sdk) => sdk.randomProfile()],
  ["createProfile with a template", (sdk) => sdk.createProfile("template")],
  ["createProfile without a template", (sdk) => sdk.createProfile()],
  ["ShardX.launch", async (sdk) => {
    await (await sdk.launch(new Profile(fingerprint()), { screenMode: "profile" })).stop();
  }],
  ["Browser.launch", async (sdk) => {
    await (await new Browser(sdk.runtime).launch(new Profile(fingerprint()), { screenMode: "profile" })).stop();
  }],
  ["session", async (sdk) => {
    await (await sdk.session(new Profile(fingerprint()), { screenMode: "profile" })).close();
  }],
];

for (const autoInstall of [undefined, true]) {
  for (const [name, operate] of firstOperations) {
    test("autoInstall " + String(autoInstall) + " installs on first " + name, async (t) => {
      const { sdk } = fixture(t, { autoInstall });
      const io = mockIO(t);
      const expectedRequests = allowSyntheticInstall(sdk, io);
      await operate(sdk);
      assert.deepEqual(await sdk.listProfiles(), ["template"]);
      for (const operation of [() => sdk.randomProfile(), () => sdk.createProfile()]) await operation();
      for (const launcher of [sdk, new Browser(sdk.runtime)]) {
        const session = await launcher.launch(new Profile(fingerprint()), { screenMode: "profile" });
        await session.stop();
      }
      const session = await sdk.session(new Profile(fingerprint()), { screenMode: "profile" });
      await session.close();
      assert.deepEqual(io.installerRequests, expectedRequests);
    });
  }
}

test("explicit install works with autoInstall false and mocked synthetic archives", async (t) => {
  const { sdk } = fixture(t);
  const io = mockIO(t);
  const expectedRequests = allowSyntheticInstall(sdk, io);
  await sdk.runtime.install();
  assert.deepEqual(io.installerRequests, expectedRequests);
  assert.deepEqual(await sdk.listProfiles(), ["template"]);
  assert.equal(sdk.runtime.chromiumVersion, "152.0.7977.65");
  assert.deepEqual(io.installerRequests, expectedRequests);
  await sdk.runtime.install({ force: true });
  assert.deepEqual(io.installerRequests, [...expectedRequests, ...expectedRequests]);
  io.installerRequests.length = 0;
  rmSync(sdk.runtime.binaryPath);
  await assertBlocked(sdk, io);
});

for (const force of [false, true]) {
  test(`autoInstall false keeps a ready local cache after a failed ${force ? "forced" : "normal"} explicit fingerprint update`, async (t) => {
    const local = fixture(t);
    prepareLocal(local);
    const before = snapshot(local.root);
    const io = mockIO(t);
    allowSyntheticInstall(local.sdk, io);
    const fetchHandler = io.fetchHandler;
    const invalidArchive = makeZip({ "shardx-fingerprints/template.json": "null" });
    io.fetchHandler = (url) => url === PUB_BASE + "/ShardX-Fingerprints.zip"
      ? new Response(invalidArchive, { headers: { "content-length": String(invalidArchive.length) } })
      : fetchHandler(url);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => { warnings.push(String(message)); };
    try {
      if (force) await assert.rejects(local.sdk.runtime.install({ force }), /invalid JSON profile: template.json/);
      else {
        await local.sdk.runtime.install();
        assert.match(warnings.join("\n"), /invalid JSON profile: template.json/);
      }
      assert.deepEqual(snapshot(local.root), before);
      local.sdk.runtime.install = async () => { assert.fail("ordinary operations must not install"); };
      io.installerRequests.length = 0;
      assert.deepEqual(await local.sdk.listProfiles(), ["template"]);
      assert.ok((await local.sdk.createProfile("template")).id);
      assert.equal(local.sdk.runtime.chromiumVersion, LOCAL_VERSION);
      const restarted = new ShardX({ cacheDir: local.root, autoInstall: false });
      assert.deepEqual(await restarted.listProfiles(), ["template"]);
      assert.equal(restarted.runtime.chromiumVersion, LOCAL_VERSION);
      assert.deepEqual(io.installerRequests, []);
      assert.deepEqual(snapshot(local.root), before);
    } finally {
      console.warn = originalWarn;
    }
  });
}

test("local readiness does not mark a later explicit install as already checked", async (t) => {
  const local = fixture(t);
  prepareLocal(local);
  const io = mockIO(t);
  await local.sdk.listProfiles();
  const expectedRequests = allowSyntheticInstall(local.sdk, io);
  await local.sdk.runtime.install();
  assert.deepEqual(io.installerRequests, expectedRequests);
});
