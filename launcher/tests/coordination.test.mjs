import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { coordinateBrowserRedirect } from "../coordination.mjs";
import { transformProxy, transformCallbackPage } from "../loader.mjs";

const url = () => new URL("https://example.invalid/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8145%2Foauth%2Fcallback");

function provider(events) {
  return {
    redirectUrl: "http://localhost:8145/oauth/callback",
    async redirectToAuthorization(value) {
      assert.equal(this.redirectUrl, value.searchParams.get("redirect_uri"));
      events.push("browser");
    }
  };
}

test("browser launch waits until ownership is established", async () => {
  const events = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const redirect = coordinateBrowserRedirect(provider(events), async () => {
    events.push("coordination");
    return pending;
  }, false, () => {});
  const result = redirect(url());
  assert.deepEqual(events, ["coordination"]);
  finish({ skipBrowserAuth: false });
  await result;
  assert.deepEqual(events, ["coordination", "browser"]);
});

test("a follower does not open a browser after receiving sibling tokens", async () => {
  const events = [];
  const redirect = coordinateBrowserRedirect(provider(events), async () => ({
    skipBrowserAuth: true
  }), false, (message) => events.push(message));
  await redirect(url());
  assert.equal(events.length, 1);
  assert.match(events[0], /suppressing/);
});

test("coordination errors propagate without opening a browser", async () => {
  const events = [];
  const redirect = coordinateBrowserRedirect(provider(events), async () => {
    throw new Error("callback port unavailable");
  }, false, () => {});
  await assert.rejects(redirect(url()), /callback port unavailable/);
  assert.deepEqual(events, []);
});

test("callback port changes fail explicitly rather than redirecting to the wrong listener", async () => {
  const events = [];
  const client = provider(events);
  const redirect = coordinateBrowserRedirect(client, async () => {
    client.redirectUrl = "http://localhost:8146/oauth/callback";
    return { skipBrowserAuth: false };
  }, false, () => {});
  await assert.rejects(redirect(url()), /callback port changed/);
  assert.deepEqual(events, []);
});

test("device and client-credential grants keep their existing behavior", async () => {
  const events = [];
  const redirect = coordinateBrowserRedirect(provider(events), async () => {
    assert.fail("non-interactive grants must not acquire a callback port");
  }, true, () => {});
  await redirect(url());
  assert.deepEqual(events, ["browser"]);
});

test("an established owner can authorize again during token renewal", async () => {
  const events = [];
  const redirect = coordinateBrowserRedirect(provider(events), async () => ({
    skipBrowserAuth: false
  }), false, () => {});
  await redirect(url());
  await redirect(url());
  assert.deepEqual(events, ["browser", "browser"]);
});

test("the verified upstream bundle receives exactly one hook", async () => {
  const source = await readFile(new URL("../node_modules/mcp-remote/dist/proxy.js", import.meta.url), "utf8");
  const transformed = transformProxy(source);
  assert.equal(transformed.split("authProvider.redirectToAuthorization = coordinateBrowserRedirect(").length, 2);
  assert.match(transformed, /import \{ coordinateBrowserRedirect \}/);
  assert.throws(() => transformProxy(`${source}\n`), /Unsupported mcp-remote bundle/);
});

test("the completed page replaces only the successful callback response", async () => {
  const source = await readFile(new URL("../node_modules/mcp-remote/dist/chunk-CGVEK4Z7.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../pages/completed.html", import.meta.url), "utf8");
  const transformed = transformCallbackPage(source, html);
  assert.ok(transformed.includes(`res.type("html").send(${JSON.stringify(html)});`));
  assert.ok(transformed.includes('res.status(400).send("Error: No authorization code received")'));
  assert.ok(transformed.includes("options.events.emit(\"auth-code-received\", code, state)"));
  assert.throws(() => transformCallbackPage(`${source}\n`, html), /Unsupported mcp-remote callback bundle/);
});
