import { register } from "node:module";
import { readFile } from "node:fs/promises";

try {
  const manifest = JSON.parse(await readFile(
    new URL("./node_modules/mcp-remote/package.json", import.meta.url), "utf8"
  ));
  if (manifest.version !== "0.14.3") {
    throw new Error("ALLTV requires mcp-remote 0.14.3. Run npm ci in the launcher directory.");
  }
  const port = Number(process.argv[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: node launch.mjs <MCP URL> <fixed callback port> [mcp-remote options]");
  }
  register("./loader.mjs", import.meta.url);
  await import("./node_modules/mcp-remote/dist/proxy.js");
} catch (error) {
  console.error(`ALLTV launcher failed: ${error.message}`);
  process.exitCode = 1;
}
