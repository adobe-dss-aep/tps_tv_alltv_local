import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.env.RUNNER_TEMP;
if (!directory) throw new Error("Vendor installation checks are for disposable CI runners only.");
const installRoot = join(directory, "ALLTV vendor check");
const config = join(directory, "ALLTV vendor settings", "claude_desktop_config.json");
const windows = process.platform === "win32";
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "psmodulepath") delete env[key];
}
const child = spawn(windows ? "powershell.exe" : "/bin/bash", windows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "install-windows.ps1"),
    "-InstallRoot", installRoot, "-ConfigPath", config]
  : [join(root, "install-macos.command"), "--install-root", installRoot, "--config-path", config],
{ env, stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end("yes\n".repeat(10));
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
