import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startOnDemandProxy } from "../on-demand.mjs";

const offlineCatalog = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf8"));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "alltv-demand-protocol-"));
  const previous = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = directory;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const proxy = await startOnDemandProxy(["https://fixture.invalid/mcp", "8145"], {
    transport: a,
    worker: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./protocol-worker.mjs", import.meta.url))],
      env: { ALLTV_TEST_STATE_DIR: directory },
    },
  });
  const client = new Client({ name: "fixture-host", version: "1" }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, () => ({
    role: "assistant", model: "fixture-model", content: { type: "text", text: "sampled fixture result" },
  }));
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await proxy.close();
    if (previous === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return { client, directory };
}

test("the installed CLI entry point initializes and lists tools without contacting its endpoint", async t => {
  const directory = await mkdtemp(join(tmpdir(), "alltv-demand-cli-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../launch.mjs", import.meta.url)), "https://fixture.invalid/mcp", "8145"],
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: directory },
    stderr: "pipe",
  });
  let errors = "";
  transport.stderr.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "fixture-cli-host", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport, { timeout: 5000 });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [...offlineCatalog.tools.map(tool => tool.name), "alltv_connect"]);
  assert.equal(tools.length, 12);
  assert.ok(tools.some(tool => tool.name === "tps_tv_read_tpsc_user_summary"));
  assert.equal((await client.listResources()).resources.length, 5);
  await client.ping();
  assert.deepEqual(await readdir(directory), []);
  assert.equal(errors, "");
});

test("offline catalog carries production schemas, not caller identity or private content", () => {
  assert.equal(offlineCatalog.tools.length, 11);
  assert.equal(offlineCatalog.resources.length, 5);
  assert.doesNotMatch(JSON.stringify(offlineCatalog), /"access_token"|"secret_key"|"client_secret"/);
  assert.equal(offlineCatalog.tools.some(tool => tool.name === "create_internal_tv_project"), false);
  const summary = offlineCatalog.tools.find(tool => tool.name === "tps_tv_read_tpsc_user_summary_widget");
  assert.equal(summary.inputSchema.properties.data.properties.projects.maxItems, 1000);
  assert.equal(summary.inputSchema.properties.data.properties.requests.maxItems, 1000);
  assert.equal(summary._meta.ui.resourceUri, "ui://tps-tv/request-overview.html");
});

test("widget metadata, resources, prompts, sampling and progress survive on-demand forwarding", async t => {
  const { client, directory } = await fixture(t);
  await client.setLoggingLevel("warning");
  assert.deepEqual(await readdir(directory), []);
  let progress;
  const result = await client.callTool({
    name: "fixture_tool", arguments: { sample: true }, _meta: { fixture: "request metadata" },
  }, undefined, { onprogress: value => { progress = value; } });
  assert.equal(result.content[0].text, "sampled fixture result");
  assert.equal(result._meta.ui.resourceUri, "ui://fixture/page");
  assert.equal(result._meta.echoed.fixture, "request metadata");
  assert.equal(progress.progress, 1);
  const tools = await client.listTools();
  assert.equal(tools.tools[0]._meta.ui.resourceUri, "ui://fixture/page");
  assert.equal((await client.listResources()).resources[0].uri, "ui://fixture/page");
  assert.equal((await client.listResourceTemplates()).resourceTemplates[0].uriTemplate, "fixture://{id}");
  assert.equal((await client.listPrompts()).prompts[0].name, "fixture_prompt");
  const widget = await client.readResource({ uri: "ui://fixture/page" });
  assert.equal(widget.contents[0].text, "protected widget payload");
  const prompt = await client.getPrompt({ name: "fixture_prompt" });
  assert.equal(prompt.messages[0].content.text, "protected prompt payload");
  const completed = await client.complete({
    ref: { type: "ref/prompt", name: "fixture_prompt" },
    argument: { name: "name", value: "f" },
  });
  assert.deepEqual(completed.completion.values, ["fixture-value"]);
  const files = await readdir(join(directory, "alltv-discovery"));
  assert.equal(files.length, 1);
  const cache = await readFile(join(directory, "alltv-discovery", files[0]), "utf8");
  assert.doesNotMatch(cache, /protected (tool|widget|prompt) payload|sampled fixture result|request metadata/);
});

test("unsupported maintenance requests never connect; protected errors are not retried", async t => {
  const { client, directory } = await fixture(t);
  await assert.rejects(client.request({ method: "unknown/maintenance" }, ResultSchema), /not supported/);
  await assert.rejects(client.request({
    method: "tools/call", params: { name: "alltv_connect", arguments: { unexpected: true } },
  }, ResultSchema), /takes no arguments/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(client.callTool({ name: "fixture_tool", arguments: { fail: true } }),
    /Fixture tool rejected/);
  const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim()
    .split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.method === "tools/call").length, 1);
  await client.ping();
  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"),
    events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const result = await client.callTool({ name: "fixture_tool", arguments: {} });
  assert.equal(result.content[0].text, "protected tool payload");
});
