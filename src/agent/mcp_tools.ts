import { readFile } from "fs/promises";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool as lcTool } from "@langchain/core/tools";
import { z } from "zod";

import { logger } from "../utils/logger";

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  enabled?: boolean;
  env?: Record<string, string>;
}

interface McpConfigFile {
  servers: McpServerConfig[];
}

interface McpServerRuntime {
  id: string;
  client: Client;
  transport: StdioClientTransport;
}

let cachedTools: any[] | null = null;
let runtimes: McpServerRuntime[] = [];

const configPath = path.resolve(process.cwd(), "config", "mcp.servers.json");

const loadConfig = async (): Promise<McpConfigFile> => {
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as McpConfigFile;
};

const buildSchema = (inputSchema: any) => {
  if (inputSchema?.type === "object" && inputSchema?.properties) {
    const required = new Set<string>(inputSchema.required || []);
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const key of Object.keys(inputSchema.properties)) {
      const base = z.any();
      shape[key] = required.has(key) ? base : base.optional();
    }

    return z.object(shape);
  }

  return z.any();
};

const startServer = async (server: McpServerConfig) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(server.env || {})) {
    if (typeof value === "string") env[key] = value;
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    cwd: server.cwd || process.cwd(),
    env,
  });

  const client = new Client({
    name: `trendai-${server.id}`,
    version: "1.0.0",
  });

  await client.connect(transport);

  return { id: server.id, client, transport } as McpServerRuntime;
};

const safeCallTool = async (
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
) => {
  const result = await client.callTool({ name: toolName, arguments: args });
  const content = Array.isArray(result?.content) ? result.content : [];

  const textChunks = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .filter(Boolean);

  if (textChunks.length > 0) return textChunks.join("\n");

  const jsonChunks = content
    .filter((c: any) => c.type === "json")
    .map((c: any) => JSON.stringify(c.json))
    .filter(Boolean);

  if (jsonChunks.length > 0) return jsonChunks.join("\n");

  return JSON.stringify(result ?? {});
};

const buildToolsForServer = async (runtime: McpServerRuntime) => {
  const list = await runtime.client.listTools();
  const tools = list.tools || [];

  return tools.map((toolDef: any) => {
    const schema = buildSchema(toolDef.inputSchema);
    const name = `${runtime.id}.${toolDef.name}`;
    const description = toolDef.description
      ? `${runtime.id}: ${toolDef.description}`
      : `${runtime.id} tool: ${toolDef.name}`;

    return lcTool(
      async (args: any) =>
        safeCallTool(runtime.client, toolDef.name, args || {}),
      { name, description, schema },
    );
  });
};

const registerCleanup = () => {
  const cleanup = () => {
    for (const runtime of runtimes) {
      try {
        if (typeof runtime.client.close === "function") {
          runtime.client.close();
        }
        if (typeof runtime.transport.close === "function") {
          runtime.transport.close();
        }
      } catch {
        // best effort
      }
    }
  };

  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
};

export const getMcpTools = async () => {
  if (cachedTools) return cachedTools;

  const config = await loadConfig();
  const enabled = (config.servers || []).filter((s) => s.enabled !== false);

  if (enabled.length === 0) {
    cachedTools = [];
    return cachedTools;
  }

  const tools: any[] = [];

  for (const server of enabled) {
    try {
      const runtime = await startServer(server);
      runtimes.push(runtime);
      const serverTools = await buildToolsForServer(runtime);
      tools.push(...serverTools);
      logger.info(
        { server: server.id, toolCount: serverTools.length },
        "MCP tools loaded",
      );
    } catch (err: any) {
      logger.warn(
        { server: server.id, err: err?.message || err },
        "MCP server failed to load",
      );
    }
  }

  registerCleanup();
  cachedTools = tools;
  return tools;
};
