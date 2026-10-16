import { register } from "node:module";

if (process.env.ALLTV_TEST_LAZY === "1") {
  const { fileURLToPath } = await import("node:url");
  const { startOnDemandProxy } = await import("../on-demand.mjs");
  const proxy = await startOnDemandProxy(process.argv.slice(2), {
    worker: {
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      env: { ALLTV_TEST_LAZY: "0" }
    }
  });
  const stop = () => proxy.close().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  if (process.env.ALLTV_TEST_UNPATCHED !== "1") register("../loader.mjs", import.meta.url);
  register("./browser-loader.mjs", import.meta.url);
  await import("../node_modules/mcp-remote/dist/proxy.js");
}
