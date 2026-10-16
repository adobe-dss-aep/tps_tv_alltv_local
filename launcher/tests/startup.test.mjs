import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const offlineCatalog = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf8"));
const offlineToolNames = [...offlineCatalog.tools.map(tool => tool.name), "alltv_connect"];

async function waitUntil(check, description, logs = () => "") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.\n${logs()}`);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function fixture(t, getStatus, {
  toolCatalog = false, issueRefreshToken = false, toolName = "fixture_tool"
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "alltv-launcher-test-"));
  const children = [];
  const browsers = [];
  const codes = new Map();
  const tokens = new Set();
  const refreshTokens = new Set();
  let base;
  let exchanges = 0;
  let requests = 0;
  let calls = 0;
  let denyToken = false;
  let refreshes = 0;
  const server = http.createServer(async (req, res) => {
    try {
      requests++;
      const url = new URL(req.url, base);
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname.startsWith("/.well-known/")) {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        });
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (url.pathname === "/browser-event") {
        browsers.push(JSON.parse(raw));
        return json(200, {});
      }
      if (url.pathname === "/register") {
        return json(201, { ...JSON.parse(raw), client_id: "fixture-client" });
      }
      if (url.pathname === "/authorize") {
        const code = randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          redirect: url.searchParams.get("redirect_uri")
        });
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { location: callback.href });
        return res.end();
      }
      if (url.pathname === "/token") {
        if (denyToken) return json(400, { error: "access_denied" });
        const params = new URLSearchParams(raw);
        if (params.get("grant_type") === "refresh_token") {
          if (!refreshTokens.has(params.get("refresh_token"))) {
            return json(400, { error: "invalid_grant" });
          }
          refreshes++;
          const token = randomUUID();
          tokens.add(token);
          return json(200, {
            access_token: token, token_type: "Bearer", expires_in: 3600,
            refresh_token: params.get("refresh_token")
          });
        }
        const code = codes.get(params.get("code"));
        if (!code || code.redirect !== params.get("redirect_uri") ||
            code.challenge !== createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url")) {
          return json(400, { error: "invalid_grant" });
        }
        codes.delete(params.get("code"));
        exchanges++;
        const token = randomUUID();
        tokens.add(token);
        const refreshToken = issueRefreshToken ? randomUUID() : undefined;
        if (refreshToken) refreshTokens.add(refreshToken);
        return json(200, {
          access_token: token, token_type: "Bearer", expires_in: 3600,
          ...(refreshToken ? { refresh_token: refreshToken } : {})
        });
      }
      if (url.pathname !== "/mcp") return json(404, {});
      if (req.method === "GET") {
        if (tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
          return json(405, {});
        }
        if (getStatus === 401) {
          res.setHeader("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        }
        return json(getStatus, {});
      }
      if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        res.setHeader("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        return json(401, {});
      }
      if (req.method === "DELETE") return json(200, {});
      const message = JSON.parse(raw);
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === "tools/call") calls++;
      const result = message.method === "initialize" ? {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "alltv-auth-fixture", version: "1.0.0" }
      } : message.method === "tools/list" ? { tools: toolCatalog ? [{
        name: toolName, description: "A protected fixture tool",
        inputSchema: { type: "object", properties: {} }
      }] : [] } : message.method === "tools/call" ? {
        content: [{ type: "text", text: "protected fixture result" }]
      } : {};
      json(200, { jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
  const reservation = http.createServer();
  const callbackPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  t.after(async () => {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        const exited = once(entry.child, "exit");
        entry.child.kill();
        await exited;
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  function start(unpatched = false, lazy = false) {
    const entry = { logs: "", messages: [], child: null };
    const child = fork(new URL("./child.mjs", import.meta.url), [
      `${base}/mcp`, String(callbackPort), "--transport", "http-only"
    ], {
      silent: true,
      env: {
        ...process.env,
        MCP_REMOTE_CONFIG_DIR: directory,
        ALLTV_TEST_UNPATCHED: unpatched ? "1" : "0",
        ALLTV_TEST_LAZY: lazy ? "1" : "0",
        ALLTV_TEST_BROWSER_EVENTS_URL: `${base}/browser-event`
      }
    });
    entry.child = child;
    children.push(entry);
    child.on("message", (message) => {
      if (message.type === "browser") browsers.push({ ...message, entry });
    });
    child.stderr.on("data", (chunk) => { entry.logs += chunk; });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      let end;
      while ((end = output.indexOf("\n")) !== -1) {
        entry.messages.push(JSON.parse(output.slice(0, end)));
        output = output.slice(end + 1);
      }
    });
    return entry;
  }
  const logs = () => children.map((entry) => entry.logs).join("\n");
  async function completeBrowser(index) {
    const response = await fetch(browsers[index].url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /ALLTV sign-in complete/);
    assert.match(html, /You can close this tab and return to Claude\./);
    assert.doesNotMatch(html, /data:font|@font-face/);
    assert.doesNotMatch(html, /<button\b|<script\b|window\.close\(/);
  }
  async function initialize(entry, id) {
    entry.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-fixture", version: "1.0.0" }
      }
    })}\n`);
    await waitUntil(() => entry.messages.some((message) => message.id === id), "local initialization", logs);
    const response = entry.messages.find((message) => message.id === id);
    assert.equal(response.error, undefined, JSON.stringify(response));
    entry.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  async function request(entry, id, method, params = {}) {
    entry.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await waitUntil(() => entry.messages.some(message => message.id === id), method, logs);
    return entry.messages.find(message => message.id === id);
  }
  return {
    start, browsers, completeBrowser, initialize, request, logs, tokens, directory,
    get exchanges() { return exchanges; },
    get requests() { return requests; },
    get calls() { return calls; },
    get refreshes() { return refreshes; },
    set denyToken(value) { denyToken = value; }
  };
}

test("unpatched launcher reproduces duplicate browsers when the GET probe is inconclusive", { timeout: 25_000 }, async (t) => {
  const remote = await fixture(t, 405);
  remote.start(true);
  await waitUntil(() => remote.browsers.length === 1, "first baseline browser", remote.logs);
  remote.start(true);
  await waitUntil(() => remote.browsers.length === 2, "duplicate baseline browser", remote.logs);
});

for (const status of [405, 401]) {
  test(`three overlapping launches open one browser (GET ${status}) and all connect`, { timeout: 30_000 }, async (t) => {
    const remote = await fixture(t, status);
    const owner = remote.start();
    await waitUntil(() => remote.browsers.length === 1, "owner browser", remote.logs);
    const follower = remote.start();
    const third = remote.start();
    await waitUntil(() => [follower, third].every((entry) => /Another instance is running/.test(entry.logs)), "both followers", remote.logs);
    assert.equal(remote.browsers.length, 1, remote.logs());
    await remote.completeBrowser(0);
    await waitUntil(() => [owner, follower, third].every((entry) => /Local STDIO server running/.test(entry.logs)), "all proxy connections", remote.logs);
    assert.equal(remote.browsers.length, 1, remote.logs());
    assert.equal(remote.exchanges, 1);
    await remote.initialize(owner, 1);
    await remote.initialize(follower, 2);
    await remote.initialize(third, 3);

    if (status === 405) {
      remote.tokens.clear();
      owner.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
      await waitUntil(() => remote.browsers.length === 2, "one renewal browser", remote.logs);
      await remote.completeBrowser(1);
      await waitUntil(() => owner.messages.some((message) => message.id === 4), "renewed tools response", remote.logs);
      const response = owner.messages.find((message) => message.id === 4);
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.deepEqual(response.result, { tools: [] });
      assert.equal(remote.browsers.length, 2);
      assert.equal(remote.exchanges, 2);
    }

  });
}

test("on-demand startup and discovery stay offline; first use authenticates and later discovery uses the cache",
  { timeout: 40_000 }, async (t) => {
    const remote = await fixture(t, 401, { toolCatalog: true });
    const entry = remote.start(false, true);
    await remote.initialize(entry, 1);
    assert.equal(remote.requests, 0);
    assert.equal(remote.browsers.length, 0);
    const initial = await remote.request(entry, 2, "tools/list");
    assert.deepEqual(initial.result.tools.map(tool => tool.name), offlineToolNames);
    const idleSibling = remote.start(false, true);
    await remote.initialize(idleSibling, 20);
    for (const [id, method] of [[3, "ping"], [4, "resources/list"], [5, "resources/templates/list"], [6, "prompts/list"]]) {
      const result = await remote.request(entry, id, method);
      assert.equal(result.error, undefined);
    }
    assert.equal(remote.requests, 0);
    const connected = remote.request(entry, 7, "tools/call", { name: "alltv_connect" });
    await waitUntil(() => remote.browsers.length === 1, "first-use browser", remote.logs);
    await remote.completeBrowser(0);
    assert.equal((await connected).error, undefined, remote.logs());
    assert.equal(remote.calls, 0);
    assert.equal(remote.exchanges, 1);
    const tools = await remote.request(entry, 8, "tools/list");
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ["fixture_tool", "alltv_connect"]);
    const before = remote.requests;
    const shared = await remote.request(idleSibling, 21, "tools/list");
    assert.deepEqual(shared.result.tools, tools.result.tools);
    assert.equal(remote.requests, before);
    await delay(300);
    await remote.request(entry, 9, "ping");
    await remote.request(entry, 10, "tools/list");
    assert.equal(remote.requests, before);
    assert.equal(remote.browsers.length, 1);
    const result = await remote.request(entry, 11, "tools/call", { name: "fixture_tool", arguments: {} });
    assert.equal(result.error, undefined, remote.logs());
    assert.equal(result.result.content[0].text, "protected fixture result");
    assert.equal(remote.exchanges, 1);
    assert.equal(remote.browsers.length, 1);

    remote.tokens.clear();
    const expiredRequests = remote.requests;
    await delay(300);
    await remote.request(entry, 12, "tools/list");
    await remote.request(entry, 13, "ping");
    assert.equal(remote.requests, expiredRequests);
    assert.equal(remote.browsers.length, 1);

    const restarted = remote.start(false, true);
    await remote.initialize(restarted, 14);
    const cached = await remote.request(restarted, 15, "tools/list");
    assert.deepEqual(cached.result.tools, tools.result.tools);
    assert.equal(remote.requests, expiredRequests);
    const renewed = remote.request(restarted, 16, "tools/call", { name: "fixture_tool", arguments: {} });
    await waitUntil(() => remote.browsers.length === 2, "demand-only renewal browser", remote.logs);
    await remote.completeBrowser(1);
    assert.equal((await renewed).error, undefined, remote.logs());
    assert.equal(remote.exchanges, 2);
    assert.equal(remote.calls, 2);
  });

test("a fresh host can invoke its initially advertised summary tool without rediscovery after sign-in",
  { timeout: 30_000 }, async (t) => {
    const name = "tps_tv_read_tpsc_user_summary";
    const remote = await fixture(t, 401, { toolCatalog: true, toolName: name });
    const entry = remote.start(false, true);
    await remote.initialize(entry, 1);
    const initial = await remote.request(entry, 2, "tools/list");
    const advertised = initial.result.tools.find(tool => tool.name === name);
    assert.ok(advertised, "summary tool must exist in the host's first tool snapshot");
    assert.equal(remote.requests, 0);
    assert.equal(remote.browsers.length, 0);
    const invoked = remote.request(entry, 3, "tools/call", { name: advertised.name, arguments: {} });
    await waitUntil(() => remote.browsers.length === 1, "first named-tool sign-in", remote.logs);
    await remote.completeBrowser(0);
    const result = await invoked;
    assert.equal(result.error, undefined, remote.logs());
    assert.equal(result.result.content[0].text, "protected fixture result");
    assert.equal(remote.calls, 1);
    assert.equal(remote.exchanges, 1);
    assert.equal(remote.browsers.length, 1);
  });

test("expired tokens refresh silently only on demand when a refresh token is available",
  { timeout: 30_000 }, async (t) => {
    const remote = await fixture(t, 401, { toolCatalog: true, issueRefreshToken: true });
    const entry = remote.start(false, true);
    await remote.initialize(entry, 1);
    const connected = remote.request(entry, 2, "tools/call", { name: "alltv_connect" });
    await waitUntil(() => remote.browsers.length === 1, "initial refresh-capable browser", remote.logs);
    await remote.completeBrowser(0);
    assert.equal((await connected).error, undefined, remote.logs());
    const files = await readdir(remote.directory, { recursive: true });
    const tokenFiles = files.filter(file => file.endsWith("_tokens.json"));
    assert.equal(tokenFiles.length, 1);
    const tokenFile = path.join(remote.directory, tokenFiles[0]);
    const saved = JSON.parse(await readFile(tokenFile, "utf8"));
    saved.expires_at = Date.now() - 1000;
    await writeFile(tokenFile, JSON.stringify(saved));
    remote.tokens.clear();
    const requests = remote.requests;
    await delay(300);
    await remote.request(entry, 3, "tools/list");
    await remote.request(entry, 4, "ping");
    assert.equal(remote.requests, requests);
    assert.equal(remote.refreshes, 0);
    const result = await remote.request(entry, 5, "tools/call", { name: "fixture_tool", arguments: {} });
    assert.equal(result.error, undefined, remote.logs());
    assert.equal(result.result.content[0].text, "protected fixture result");
    assert.equal(remote.refreshes, 1);
    assert.equal(remote.exchanges, 1);
    assert.equal(remote.browsers.length, 1);
  });

test("concurrent on-demand calls and launcher processes share a single browser sign-in",
  { timeout: 35_000 }, async (t) => {
    const remote = await fixture(t, 405, { toolCatalog: true });
    const entries = [remote.start(false, true), remote.start(false, true), remote.start(false, true)];
    await Promise.all(entries.map((entry, index) => remote.initialize(entry, index + 1)));
    assert.equal(remote.requests, 0);
    const pending = entries.flatMap(entry => [10, 11].map(id =>
      remote.request(entry, id, "tools/call", { name: "fixture_tool", arguments: {} })));
    await waitUntil(() => remote.browsers.length === 1, "shared demand-only browser", remote.logs);
    await waitUntil(() => entries.filter(entry => /Another instance is running/.test(entry.logs)).length === 2,
      "two waiting demand-only processes", remote.logs);
    await remote.completeBrowser(0);
    for (const result of await Promise.all(pending)) {
      assert.equal(result.error, undefined, remote.logs());
    }
    assert.equal(remote.calls, 6);
    assert.equal(remote.exchanges, 1);
    assert.equal(remote.browsers.length, 1);
  });

test("denied on-demand authentication reports failure and retries only on a later user request",
  { timeout: 30_000 }, async (t) => {
    const remote = await fixture(t, 401, { toolCatalog: true });
    remote.denyToken = true;
    const entry = remote.start(false, true);
    await remote.initialize(entry, 1);
    const denied = remote.request(entry, 2, "tools/call", { name: "alltv_connect" });
    await waitUntil(() => remote.browsers.length === 1, "denied sign-in browser", remote.logs);
    await remote.completeBrowser(0);
    assert.ok((await denied).error, remote.logs());
    assert.equal(remote.calls, 0);
    const requests = remote.requests;
    const tools = await remote.request(entry, 3, "tools/list");
    assert.deepEqual(tools.result.tools.map(tool => tool.name), offlineToolNames);
    await delay(300);
    assert.equal(remote.requests, requests);
    remote.denyToken = false;
    const retried = remote.request(entry, 4, "tools/call", { name: "alltv_connect" });
    await waitUntil(() => remote.browsers.length === 2, "explicit retry browser", remote.logs);
    await remote.completeBrowser(1);
    assert.equal((await retried).error, undefined, remote.logs());
    assert.equal(remote.exchanges, 1);
  });

test("cancelling the last pending use closes its authentication worker without a background retry",
  { timeout: 30_000 }, async (t) => {
    const remote = await fixture(t, 401, { toolCatalog: true });
    const entry = remote.start(false, true);
    await remote.initialize(entry, 1);
    entry.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alltv_connect" }
    })}\n`);
    await waitUntil(() => remote.browsers.length === 1, "cancelled authentication browser", remote.logs);
    entry.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 }
    })}\n`);
    const callback = new URL(new URL(remote.browsers[0].url).searchParams.get("redirect_uri"));
    const deadline = Date.now() + 6000;
    let callbackOpen = true;
    while (Date.now() < deadline && callbackOpen) {
      try {
        await fetch(callback.origin, { method: "HEAD" });
        await delay(50);
      } catch {
        callbackOpen = false;
      }
    }
    assert.equal(callbackOpen, false, "cancelled worker must close its callback listener");
    assert.equal(remote.exchanges, 0);
    const requests = remote.requests;
    const tools = await remote.request(entry, 3, "tools/list");
    assert.equal(tools.error, undefined);
    assert.deepEqual(tools.result.tools.map(tool => tool.name), offlineToolNames);
    await delay(300);
    assert.equal(remote.requests, requests);
    assert.equal(remote.browsers.length, 1);
  });
