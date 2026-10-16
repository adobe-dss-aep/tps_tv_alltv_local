import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ListPromptsRequestSchema,
  ReadResourceRequestSchema, GetPromptRequestSchema, CompleteRequestSchema,
  McpError, ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const record = method => appendFile(join(process.env.ALLTV_TEST_STATE_DIR, "events.jsonl"),
  `${JSON.stringify({ method, pid: process.pid })}\n`);
const server = new Server({ name: "protocol-fixture", version: "1" }, {
  capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
});
server.oninitialized = () => record("initialized");
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await record("tools/list");
  return {
    tools: [{
      name: "fixture_tool", inputSchema: { type: "object", properties: {} },
      _meta: { ui: { resourceUri: "ui://fixture/page" } },
    }],
  };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "ui://fixture/page", name: "Fixture widget", mimeType: "text/html" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "Fixture template" }],
}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "fixture_prompt" }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await record("tools/call");
  if (request.params.arguments?.fail) throw new McpError(ErrorCode.InvalidParams, "Fixture tool rejected the request.");
  let text = "protected tool payload";
  if (request.params.arguments?.sample) {
    const result = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: "Summarize the fixture." } }],
      maxTokens: 32,
    });
    text = result.content.text;
  }
  if (request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta.progressToken, progress: 1, total: 1 },
    });
  }
  return {
    content: [{ type: "text", text }],
    _meta: { ui: { resourceUri: "ui://fixture/page" }, echoed: request.params._meta },
  };
});
server.setRequestHandler(ReadResourceRequestSchema, async request => ({
  contents: [{ uri: request.params.uri, mimeType: "text/html", text: "protected widget payload" }],
}));
server.setRequestHandler(GetPromptRequestSchema, async () => ({
  messages: [{ role: "user", content: { type: "text", text: "protected prompt payload" } }],
}));
server.setRequestHandler(CompleteRequestSchema, async () => ({
  completion: { values: ["fixture-value"], total: 1, hasMore: false },
}));
await server.connect(new StdioServerTransport());
