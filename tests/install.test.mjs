import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../installer.json", import.meta.url), "utf8"));
const supported = ["win32", "darwin"].includes(process.platform);

async function assertInside(root, file) {
  const local = relative(await realpath(root), await realpath(file));
  assert.ok(!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`),
    `Expected ${file} to be inside ${root}, got relative path ${local}`);
}

function install(installRoot, configPath) {
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(root, "install-windows.ps1"), "-InstallRoot", installRoot, "-ConfigPath", configPath, "-SkipClaudeInstall"]
    : [join(root, "install-macos.command"), "--install-root", installRoot, "--config-path", configPath, "--skip-claude-install"];
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Let Windows PowerShell build its own module path instead of inheriting PowerShell 7's modules.
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "psmodulepath") delete env[key];
      }
    }
    const child = spawn(command, args, { cwd: root, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("real isolated installation and update preserve settings and never authenticate", {
  skip: !supported,
  timeout: 360000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "alltv-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const installRoot = join(directory, "ALLTV private runtime with spaces");
  const configPath = join(directory, "Claude settings with spaces", "claude_desktop_config.json");
  await mkdir(dirname(configPath), { recursive: true });
  const original = {
    theme: "dark",
    mcpServers: {
      other: { command: "fixture-other", env: { PRIVATE_VALUE: "fixture-not-for-logs" } },
      oldAlltv: { command: "npx", args: ["mcp-remote", manifest.endpoint] },
    },
  };
  const originalBytes = `${JSON.stringify(original)}\n`;
  await writeFile(configPath, originalBytes);
  let previousEntry;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await install(installRoot, configPath);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Verified 11 ALLTV tools offline; no sign-in performed/);
    assert.match(result.stdout, /installed successfully/);
    assert.ok(!result.stdout.includes("fixture-not-for-logs"));
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.mcpServers.other, original.mcpServers.other);
    assert.equal(config.theme, "dark");
    assert.equal(config.mcpServers.oldAlltv, undefined);
    const entry = config.mcpServers[manifest.serverName];
    await assertInside(installRoot, entry.command);
    await assertInside(installRoot, entry.args[0]);
    assert.equal(entry.args[1], manifest.endpoint);
    assert.equal(entry.args[2], "8145");
    await readFile(entry.args[0]);
    if (previousEntry) {
      assert.equal(entry.command, previousEntry.command);
      assert.notEqual(entry.args[0], previousEntry.args[0]);
      await readFile(previousEntry.args[0]);
    }
    previousEntry = entry;
    const backups = (await readdir(dirname(configPath))).filter(name => name.includes(".alltv-backup-"));
    assert.equal(backups.length, attempt);
    if (attempt === 1) assert.equal(await readFile(join(dirname(configPath), backups[0]), "utf8"), originalBytes);
  }
  assert.equal((await readdir(join(installRoot, "runtimes"))).length, 1);
  assert.equal((await readdir(join(installRoot, "versions"))).length, 2);
  await writeFile(configPath, "{not valid JSON");
  const failed = await install(installRoot, configPath);
  assert.notEqual(failed.code, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /not valid JSON/);
  assert.ok(!failed.stdout.includes("installed successfully"));
  assert.equal(await readFile(configPath, "utf8"), "{not valid JSON");
  await readFile(previousEntry.args[0]);
});
