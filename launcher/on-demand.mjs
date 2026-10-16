import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode, McpError, ResultSchema,
  ListToolsRequestSchema, ListToolsResultSchema,
  ListResourcesRequestSchema, ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema,
  ListPromptsRequestSchema, ListPromptsResultSchema,
  PingRequestSchema, SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const connectTool = {
  name: "alltv_connect",
  description: "Connect to Adobe ALLTV when its tools are needed, or refresh its available tools. " +
    "Sign-in opens in your default browser only if cached credentials cannot be used silently. " +
    "Normally call the desired ALLTV tool directly; it connects automatically. " +
    "Do not call this for startup, discovery, or background health checks.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const listMethods = [
  ["tools/list", "tools", ListToolsRequestSchema, ListToolsResultSchema],
  ["resources/list", "resources", ListResourcesRequestSchema, ListResourcesResultSchema],
  ["resources/templates/list", "resourceTemplates", ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema],
  ["prompts/list", "prompts", ListPromptsRequestSchema, ListPromptsResultSchema],
];
const emptyCatalog = () => ({ tools: [], resources: [], resourceTemplates: [], prompts: [] });
const requestTimeout = 5 * 60 * 1000;

function parseCatalog(saved) {
  if (saved.version !== 1) throw new Error("Unsupported discovery catalog version");
  const catalog = emptyCatalog();
  for (const [, field, , schema] of listMethods) {
    catalog[field] = schema.parse({ [field]: saved[field] })[field];
  }
  return catalog;
}

function waitForConnection(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function startOnDemandProxy(args, {
  transport = new StdioServerTransport(),
  worker = { command: process.execPath, args: [fileURLToPath(new URL("./upstream.mjs", import.meta.url)), ...args] },
} = {}) {
  const key = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const cacheFile = join(process.env.MCP_REMOTE_CONFIG_DIR || join(homedir(), ".mcp-auth"),
    "alltv-discovery", `${key}.json`);
  const bundledCatalog = parseCatalog(JSON.parse(await readFile(new URL("./catalog.json", import.meta.url), "utf8")));
  let catalog = bundledCatalog;
  async function refreshLocalCatalog() {
    try {
      catalog = parseCatalog(JSON.parse(await readFile(cacheFile, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`ALLTV discovery cache ignored: ${error.message}`);
      }
      catalog = bundledCatalog;
    }
  }
  await refreshLocalCatalog();

  const local = new Server({ name: "alltv-on-demand", version: "1.0.0" }, {
    capabilities: {
      tools: { listChanged: true }, resources: { listChanged: true },
      prompts: { listChanged: true }, logging: {}, completions: {},
    },
    instructions: "ALLTV authentication is deferred until a tool, resource read, or prompt is needed. " +
      "Tools are visible from offline metadata before sign-in; call the desired tool directly. " +
      "Discovery and health checks use local metadata only. Use alltv_connect only to explicitly reconnect or refresh.",
  });
  let session;
  let connecting;
  let closing;
  let active = 0;
  let stopped = false;
  let logLevel;

  async function saveCatalog(next) {
    await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, cacheFile);
          break;
        } catch (error) {
          // Windows may briefly prevent replacement while another launcher reads the cache.
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
              attempt >= 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    const previous = catalog;
    catalog = next;
    for (const field of ["tools", "resources", "prompts"]) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
        await local.notification({ method: `notifications/${field}/list_changed` });
      }
    }
  }

  async function readCatalog(client) {
    const next = emptyCatalog();
    const capabilities = client.getServerCapabilities() ?? {};
    for (const [method, field, , schema] of listMethods) {
      if (!capabilities[method.split("/")[0]]) continue;
      let cursor;
      const cursors = new Set();
      do {
        const page = await client.request({
          method, ...(cursor === undefined ? {} : { params: { cursor } }),
        }, schema);
        next[field].push(...page[field]);
        cursor = page.nextCursor;
        if (cursor !== undefined && cursors.has(cursor)) {
          throw new Error(`ALLTV returned a repeated ${method} cursor.`);
        }
        cursors.add(cursor);
      } while (cursor !== undefined);
    }
    if (next.tools.some(tool => tool.name === connectTool.name)) {
      throw new Error("The remote server uses the reserved alltv_connect tool name.");
    }
    await saveCatalog(next);
  }

  function createSession() {
    const capabilities = { ...local.getClientCapabilities() };
    delete capabilities.tasks;
    const client = new Client({ name: "alltv-on-demand", version: "1.0.0" }, { capabilities });
    const upstreamTransport = new StdioClientTransport({
      ...worker, env: { ...process.env, ...worker.env }, stderr: "inherit",
    });
    client.onerror = error => console.error(`ALLTV upstream error: ${error.message}`);
    client.fallbackRequestHandler = (request, extra) => local.request(request, ResultSchema, {
      signal: extra.signal, timeout: requestTimeout,
    });
    client.fallbackNotificationHandler = notification => {
      if (notification.method.endsWith("/list_changed")) return Promise.resolve();
      return local.notification(notification);
    };
    return { client, upstreamTransport };
  }

  async function disconnect() {
    const current = session;
    session = undefined;
    connecting = undefined;
    if (current) await current.client.close();
  }

  async function withRemote(operation, signal) {
    if (stopped) throw new McpError(ErrorCode.ConnectionClosed, "ALLTV launcher is shutting down.");
    active += 1;
    let failure;
    try {
      if (closing) await closing;
      if (stopped) throw new McpError(ErrorCode.ConnectionClosed, "ALLTV launcher is shutting down.");
      signal?.throwIfAborted();
      if (!session) {
        session = createSession();
        const current = session;
        connecting = (async () => {
          await current.client.connect(current.upstreamTransport, { timeout: requestTimeout });
          if (logLevel && current.client.getServerCapabilities()?.logging) {
            await current.client.setLoggingLevel(logLevel);
          }
          await readCatalog(current.client);
          return current;
        })();
      }
      const current = await waitForConnection(connecting, signal);
      return await operation(current.client);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      active -= 1;
      if (active === 0 && session) {
        closing = disconnect();
        try {
          await closing;
        } catch (error) {
          if (failure) throw new AggregateError([failure, error], "ALLTV request and cleanup failed.");
          throw error;
        } finally {
          closing = undefined;
        }
      }
    }
  }

  for (const [, field, schema] of listMethods) {
    local.setRequestHandler(schema, async () => {
      await refreshLocalCatalog();
      return { [field]: field === "tools" ? [...catalog.tools, connectTool] : catalog[field] };
    });
  }
  local.setRequestHandler(PingRequestSchema, () => ({}));
  local.setRequestHandler(SetLevelRequestSchema, async request => {
    logLevel = request.params.level;
    if (session?.client.getServerCapabilities()?.logging) {
      await session.client.setLoggingLevel(logLevel);
    }
    return {};
  });
  local.fallbackNotificationHandler = async notification => {
    if (session) await session.client.notification(notification);
  };
  local.fallbackRequestHandler = (request, extra) => {
    if (!["tools/call", "resources/read", "prompts/get", "completion/complete"].includes(request.method) ||
        request.params?.task) {
      throw new McpError(ErrorCode.MethodNotFound, "This operation is not supported by the on-demand launcher.");
    }
    if (request.method === "tools/call" && request.params?.name === connectTool.name) {
      const args = request.params.arguments;
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).length > 0)) {
        throw new McpError(ErrorCode.InvalidParams, "alltv_connect takes no arguments.");
      }
      return withRemote(async () => ({
        content: [{ type: "text", text: `ALLTV connected. ${catalog.tools.length} tools available. Call the desired tool directly.` }],
      }), extra.signal);
    }
    return withRemote(client => client.request(request, ResultSchema, {
      signal: extra.signal, timeout: requestTimeout,
      onprogress: request.params?._meta?.progressToken === undefined ? undefined : progress =>
        local.notification({
          method: "notifications/progress",
          params: { ...progress, progressToken: request.params._meta.progressToken },
        }),
    }), extra.signal);
  };

  async function close() {
    if (stopped) return;
    stopped = true;
    if (closing) await closing;
    await disconnect();
    await local.close();
  }
  local.onerror = error => console.error(`ALLTV local protocol error: ${error.message}`);
  local.onclose = () => close().catch(error => {
    console.error(`ALLTV cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
  await local.connect(transport);
  return { close };
}
