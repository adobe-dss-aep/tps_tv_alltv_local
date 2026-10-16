export async function load(url, context, nextLoad) {
  if (!url.endsWith("/mcp-remote/dist/chunk-CGVEK4Z7.js")) {
    return nextLoad(url, context);
  }
  const loaded = await nextLoad(url, context);
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const anchor = "async function openBrowser(url2) {";
  if (source.split(anchor).length !== 2) throw new Error("Cannot intercept the test browser.");
  return {
    format: "module",
    source: source.replace(anchor, `${anchor}
  if (process.send) {
    process.send({ type: "browser", url: url2 });
  } else {
    await fetch(process.env.ALLTV_TEST_BROWSER_EVENTS_URL, {
      method: "POST", body: JSON.stringify({ type: "browser", url: url2 })
    });
  }
  return true;
`),
    shortCircuit: true
  };
}
