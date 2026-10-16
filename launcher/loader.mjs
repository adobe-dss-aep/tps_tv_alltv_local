import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const upstreamHash = "db2c09216a1d394d425ecdebb6386b5c435ef8c51c08a8db19a15360f60c3b4a";
const proxyUrl = new URL("./node_modules/mcp-remote/dist/proxy.js", import.meta.url).href;
const helperUrl = new URL("./coordination.mjs", import.meta.url).href;
const callbackUrl = new URL("./node_modules/mcp-remote/dist/chunk-CGVEK4Z7.js", import.meta.url).href;
const callbackHash = "c2317039772cf79bdba4da9349bde030c7e7f83cef702321600f3cf2be755451";
const anchor = "  const signsInWithoutACallbackPort = useDeviceCode || useClientCredentials;\n";

export function transformProxy(source) {
  if (createHash("sha256").update(source).digest("hex") !== upstreamHash) {
    throw new Error("Unsupported mcp-remote bundle. ALLTV requires the verified 0.14.3 release.");
  }
  if (source.split(anchor).length !== 2) {
    throw new Error("Cannot locate the ALLTV authentication coordination hook.");
  }
  return source.replace(
    anchor,
    `${anchor}  authProvider.redirectToAuthorization = coordinateBrowserRedirect(authProvider, authInitializer, signsInWithoutACallbackPort, log);\n`
  ).replace(
    "#!/usr/bin/env node\n",
    `#!/usr/bin/env node\nimport { coordinateBrowserRedirect } from ${JSON.stringify(helperUrl)};\n`
  );
}

export async function load(url, context, nextLoad) {
  if (url !== proxyUrl && url !== callbackUrl) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const transformed = url === proxyUrl ? transformProxy(source) : transformCallbackPage(
    source, await readFile(new URL("./pages/completed.html", import.meta.url), "utf8"),
  );
  return { format: "module", source: transformed, shortCircuit: true };
}

export function transformCallbackPage(source, html) {
  if (createHash("sha256").update(source).digest("hex") !== callbackHash) {
    throw new Error("Unsupported mcp-remote callback bundle. ALLTV requires the verified 0.14.3 release.");
  }
  const page = /res\.send\(`\n\s+Authorization successful![\s\S]*?\n\s+`\);/g;
  if ([...source.matchAll(page)].length !== 1) {
    throw new Error("Cannot locate the ALLTV completed authorization page.");
  }
  return source.replace(page, () => `res.type("html").send(${JSON.stringify(html)});`);
}
