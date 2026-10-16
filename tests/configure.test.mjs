import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configure, mergeConfig } from "../tools/configure.mjs";

const manifest = JSON.parse(await readFile(new URL("../installer.json", import.meta.url), "utf8"));
const paths = { runtime: process.execPath, launcher: join(tmpdir(), "ALLTV with spaces", "launch.mjs") };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "alltv-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, configPath: join(directory, "claude_desktop_config.json"), ...paths };
}

test("creates an ALLTV entry with absolute runtime and launcher, fixed callback, and production endpoint", async t => {
  const options = await fixture(t);
  const result = await configure(options);
  assert.deepEqual(result, { changed: true, backup: null });
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  assert.deepEqual(config.mcpServers[manifest.serverName], {
    command: paths.runtime, args: [paths.launcher, manifest.endpoint, "8145"],
  });
  assert.deepEqual(await readdir(options.directory), ["claude_desktop_config.json"]);
});

test("preserves unrelated settings and MCP entries, saves exact original bytes, and is idempotent", async t => {
  const options = await fixture(t);
  const original = {
    theme: "dark",
    preferences: { localAgentMode: true },
    mcpServers: { calendar: { command: "calendar", env: { PRIVATE_VALUE: "fixture-only" } } },
  };
  const bytes = `\uFEFF${JSON.stringify(original)}\r\n`;
  await writeFile(options.configPath, bytes);
  const result = await configure(options);
  assert.equal(await readFile(result.backup, "utf8"), bytes);
  const configured = JSON.parse(await readFile(options.configPath, "utf8"));
  assert.deepEqual(configured.mcpServers.calendar, original.mcpServers.calendar);
  assert.equal(configured.theme, original.theme);
  assert.deepEqual(configured.preferences, original.preferences);
  assert.deepEqual(await configure(options), { changed: false, backup: null });
  assert.equal((await readdir(options.directory)).filter(name => name.includes("backup")).length, 1);
});

test("updates existing ALLTV in place, preserves its custom environment and leaves other endpoints alone", () => {
  const config = {
    mcpServers: {
      [manifest.serverName]: { command: "old-node", args: ["old"], env: { HTTPS_PROXY: "fixture-proxy" }, timeout: 120 },
      other: { command: "node", args: ["other", "https://example.invalid/mcp"] },
    },
  };
  const updated = mergeConfig(config, paths);
  assert.equal(updated.mcpServers[manifest.serverName].command, paths.runtime);
  assert.deepEqual(updated.mcpServers[manifest.serverName].env, { HTTPS_PROXY: "fixture-proxy" });
  assert.equal(updated.mcpServers[manifest.serverName].timeout, 120);
  assert.deepEqual(updated.mcpServers.other, config.mcpServers.other);
  assert.equal(config.mcpServers[manifest.serverName].command, "old-node");
});

test("migrates duplicate aliases for this exact ALLTV endpoint without keeping an eager launcher", () => {
  const config = { mcpServers: {
    oldAlltv: { command: "npx", args: ["mcp-remote", manifest.endpoint], env: { CUSTOM: "kept" } },
    directAlltv: { url: manifest.endpoint },
    other: { url: "https://example.invalid/mcp" },
  } };
  const result = mergeConfig(config, paths);
  assert.deepEqual(Object.keys(result.mcpServers).sort(), ["other", manifest.serverName].sort());
  assert.deepEqual(result.mcpServers[manifest.serverName].env, { CUSTOM: "kept" });
  assert.equal(result.mcpServers[manifest.serverName].url, undefined);
});

for (const invalid of ["{invalid", "null", "[]", '{"mcpServers":[]}', '{"mcpServers":false}']) {
  test(`rejects malformed configuration without changing it: ${invalid}`, async t => {
    const options = await fixture(t);
    await writeFile(options.configPath, invalid);
    await assert.rejects(configure(options), /configuration|objects/);
    assert.equal(await readFile(options.configPath, "utf8"), invalid);
    assert.deepEqual(await readdir(options.directory), ["claude_desktop_config.json"]);
  });
}

test("refuses a configuration lock and does not delete another installer's lock", async t => {
  const options = await fixture(t);
  const lock = `${options.configPath}.alltv-install.lock`;
  await writeFile(lock, "fixture-lock");
  await assert.rejects(configure(options), /Another setup/);
  assert.equal(await readFile(lock, "utf8"), "fixture-lock");
  assert.deepEqual(await readdir(options.directory), ["claude_desktop_config.json.alltv-install.lock"]);
});

test("rejects relative paths", async () => {
  assert.throws(() => mergeConfig({}, { ...paths, runtime: "node" }), /absolute/);
  await assert.rejects(configure({ ...paths, configPath: "relative.json" }), /absolute/);
});

test("rejects malformed existing ALLTV entries instead of silently replacing them", () => {
  for (const entry of [null, false, [], "invalid"]) {
    assert.throws(() => mergeConfig({ mcpServers: { [manifest.serverName]: entry } }, paths), /existing ALLTV entry/);
  }
});

test("a later installation gets a new backup while preserving the previous version for rollback", async t => {
  const options = await fixture(t);
  await configure(options);
  const first = await readFile(options.configPath, "utf8");
  const next = { ...options, launcher: join(tmpdir(), "new ALLTV version", "launch.mjs") };
  const result = await configure(next);
  assert.equal(await readFile(result.backup, "utf8"), first);
  assert.equal(JSON.parse(await readFile(options.configPath, "utf8")).mcpServers[manifest.serverName].args[0], next.launcher);
});

test("distribution manifest pins public vendor downloads and all four runtime checksums", () => {
  assert.equal(manifest.node.version, "24.22.0");
  assert.equal(manifest.repository, "adobe-dss-aep/tps_tv_alltv_local");
  assert.deepEqual(Object.keys(manifest.node.sha256).sort(), ["darwin-arm64", "darwin-x64", "win-arm64", "win-x64"]);
  for (const hash of Object.values(manifest.node.sha256)) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const download of [manifest.claude.windows.x64, manifest.claude.windows.arm64, manifest.claude.macos]) {
    assert.equal(new URL(download.url).origin, "https://downloads.claude.ai");
    assert.match(download.sha256, /^[a-f0-9]{64}$/i);
    assert.ok(!download.url.includes("latest"));
  }
});
