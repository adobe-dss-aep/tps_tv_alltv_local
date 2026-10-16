import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const [runtime, launcher] = process.argv.slice(2);
  if (!runtime || !launcher) throw new Error("Usage: verify.mjs <node executable> <launch.mjs>");
  const require = createRequire(resolve(dirname(launcher), "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const manifest = JSON.parse(await readFile(new URL("../installer.json", import.meta.url), "utf8"));
  const catalog = JSON.parse(await readFile(join(dirname(launcher), "catalog.json"), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "alltv-setup-check-"));
  const transport = new StdioClientTransport({
    command: runtime,
    args: [launcher, manifest.endpoint, manifest.callbackPort],
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: directory },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr.on("data", chunk => { diagnostics += chunk; });
  const client = new Client({ name: "alltv-installer-check", version: manifest.version });
  try {
    await client.connect(transport, { timeout: 15000 });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), [...catalog.tools.map(tool => tool.name), "alltv_connect"]);
    assert.ok(tools.some(tool => tool.name === "tps_tv_read_tpsc_user_summary"));
    assert.equal((await client.listResources()).resources.length, catalog.resources.length);
    await client.ping();
    assert.equal(diagnostics, "", "Launcher emitted startup errors");
    assert.deepEqual(await readdir(directory), [], "Discovery unexpectedly wrote authentication/cache files");
    console.log(`Verified ${tools.length - 1} ALLTV tools offline; no sign-in performed.`);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`ALLTV verification failed: ${error.message}`);
  process.exitCode = 1;
}
