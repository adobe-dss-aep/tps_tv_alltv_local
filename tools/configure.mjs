import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const manifest = JSON.parse(await readFile(new URL("../installer.json", import.meta.url), "utf8"));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function mergeConfig(config, { runtime, launcher }) {
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
    throw new Error("Claude configuration and mcpServers must be JSON objects. No settings were changed.");
  }
  if (!isAbsolute(runtime) || !isAbsolute(launcher)) {
    throw new Error("The Node runtime and launcher paths must be absolute.");
  }
  const servers = { ...config.mcpServers };
  const aliases = Object.entries(servers).filter(([name, entry]) =>
    name === manifest.serverName || (object(entry) &&
      (entry.url === manifest.endpoint || entry.args?.includes?.(manifest.endpoint))));
  const previous = Object.hasOwn(servers, manifest.serverName)
    ? servers[manifest.serverName] : aliases.length ? aliases[0][1] : {};
  if (!object(previous)) throw new Error("The existing ALLTV entry must be a JSON object.");
  for (const [name] of aliases) delete servers[name];
  const { url, ...settings } = previous;
  servers[manifest.serverName] = {
    ...settings,
    command: runtime,
    args: [launcher, manifest.endpoint, manifest.callbackPort],
  };
  return { ...config, mcpServers: servers };
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function configure({ configPath, runtime, launcher }) {
  if (!isAbsolute(configPath)) throw new Error("The Claude configuration path must be absolute.");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.alltv-install.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Another setup may be editing Claude settings. Check ${lockPath} before retrying.`, { cause: error });
    }
    throw error;
  }
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await lock.writeFile(String(process.pid));
    const before = await readOptional(configPath);
    let config = {};
    if (before !== null) {
      try {
        config = JSON.parse(before.toString("utf8").replace(/^\uFEFF/, ""));
      } catch (error) {
        throw new Error("Claude configuration is not valid JSON. Repair it before installing; no settings were changed.", { cause: error });
      }
    }
    const updated = `${JSON.stringify(mergeConfig(config, { runtime, launcher }), null, 2)}\n`;
    if (before?.equals(Buffer.from(updated))) return { changed: false, backup: null };
    let backup = null;
    if (before !== null) {
      backup = `${configPath}.alltv-backup-${Date.now()}-${randomUUID()}.json`;
      await writeFile(backup, before, { flag: "wx", mode: 0o600 });
    }
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    const current = await readOptional(configPath);
    if ((before === null) !== (current === null) || (before && !before.equals(current))) {
      throw new Error("Claude settings changed during setup. Quit Claude and retry; the newer settings were not overwritten.");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, configPath);
        break;
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
    return { changed: true, backup };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--config" || args[2] !== "--runtime" || args[4] !== "--launcher") {
      throw new Error("Usage: configure.mjs --config <absolute path> --runtime <absolute node> --launcher <absolute launch.mjs>");
    }
    const result = await configure({ configPath: args[1], runtime: args[3], launcher: args[5] });
    console.log(result.changed ? "ALLTV entry configured." : "ALLTV entry already up to date.");
    if (result.backup) console.log(`Previous settings backed up: ${result.backup}`);
  } catch (error) {
    console.error(`ALLTV configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
