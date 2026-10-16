import { readFile } from "node:fs/promises";
import { startOnDemandProxy } from "./on-demand.mjs";

try {
  const args = process.argv.slice(2);
  const port = Number(args[1]);
  if (!args[0] || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: node launch.mjs <MCP URL> <fixed callback port> [mcp-remote options]");
  }
  new URL(args[0]);
  if (args.some(arg => arg === "--keep-alive" || arg.startsWith("--ping-interval"))) {
    throw new Error("Background keep-alive is incompatible with on-demand authentication.");
  }
  const manifest = JSON.parse(await readFile(
    new URL("./node_modules/mcp-remote/package.json", import.meta.url), "utf8",
  ));
  if (manifest.version !== "0.14.3") {
    throw new Error("ALLTV requires mcp-remote 0.14.3. Run npm ci in the launcher directory.");
  }
  const proxy = await startOnDemandProxy(args);
  const stop = () => proxy.close().catch(error => {
    console.error(`ALLTV shutdown failed: ${error.message}`);
    process.exitCode = 1;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(`ALLTV launcher failed: ${error.message}`);
  process.exitCode = 1;
}
