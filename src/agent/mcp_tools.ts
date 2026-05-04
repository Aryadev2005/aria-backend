import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool as lcTool } from "@langchain/core/tools";
import { z } from "zod";

import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

// ─── Config Types ───────────────────────────────────────────────────────────

/** stdio-based local MCP server */
export interface McpStdioServerConfig {
  id: string;
  type?: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  enabled?: boolean;
  env?: Record<string, string>;
}

/** HTTP/SSE-based remote MCP server (e.g. Apify, hosted services) */
export interface McpHttpServerConfig {
  id: string;
  type: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

interface McpConfigFile {
  servers: McpServerConfig[];
}

interface McpServerRuntime {
  id: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

// ─── State ──────────────────────────────────────────────────────────────────

let cachedTools: any[] | null = null;
let runtimes: McpServerRuntime[] = [];

// ─── Config Loading ──────────────────────────────────────────────────────────

/**
 * Resolve the config path relative to the project root (two levels up from
 * src/agent/), so it works regardless of where the process was started from.
 */
const resolveConfigPath = (): string => {
  // __filename works in both CJS (via tsx) and ESM
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(__filename), "..", "..");
  return path.join(projectRoot, "config", "mcp.servers.json");
};

const loadConfig = async (): Promise<McpConfigFile> => {
  const configPath = resolveConfigPath();
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as McpConfigFile;
};

// ─── Command Resolution ──────────────────────────────────────────────────────

/**
 * Resolve a bare command name (e.g. "node", "python") to its full absolute
 * path so that child processes can find it on any machine, even when PATH
 * is not fully inherited by the spawned subprocess.
 *
 * If the command already looks like an absolute path it is returned as-is.
 */
const resolveCommand = async (command: string): Promise<string> => {
  // Already an absolute path – normalise separators and return
  if (path.isAbsolute(command)) {
    return path.normalize(command);
  }

  // Special-case: the running Node binary is always accessible
  if (command === "node") {
    return process.execPath;
  }

  // Try `where` (Windows) / `which` (Unix) to locate the binary
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(which, [command]);
    // `where` may return multiple lines; take the first
    const resolved = stdout.trim().split(/\r?\n/)[0].trim();
    if (resolved) return resolved;
  } catch {
    // fall through – return original command and let spawn fail with a useful message
  }

  return command;
};

// ─── Schema Builder ──────────────────────────────────────────────────────────

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

// ─── Server Start ────────────────────────────────────────────────────────────

const startStdioServer = async (
  server: McpStdioServerConfig,
): Promise<McpServerRuntime> => {
  // Merge parent env so child can find system tools (git, curl, etc.)
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(server.env || {})) {
    if (typeof v === "string") env[k] = v;
  }

  const resolvedCommand = await resolveCommand(server.command);

  // Resolve cwd: if the config stores an absolute path that belongs to a
  // different machine layout, fall back to process.cwd() gracefully.
  let cwd = server.cwd ? path.normalize(server.cwd) : process.cwd();

  const transport = new StdioClientTransport({
    command: resolvedCommand,
    args: server.args || [],
    cwd,
    env,
  });

  const client = new Client({
    name: `trendai-${server.id}`,
    version: "1.0.0",
  });

  await client.connect(transport);

  return { id: server.id, client, transport };
};

const startHttpServer = async (
  server: McpHttpServerConfig,
): Promise<McpServerRuntime> => {
  const url = new URL(server.url);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: server.headers || {},
    },
  });

  const client = new Client({
    name: `trendai-${server.id}`,
    version: "1.0.0",
  });

  await client.connect(transport);

  return { id: server.id, client, transport };
};

// ─── Tool Calling ────────────────────────────────────────────────────────────

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

    // OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$
    // Replace dots (our server.tool separator) and any other illegal chars with _
    const rawName = `${runtime.id}_${toolDef.name}`;
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

    const description = toolDef.description
      ? `[${runtime.id}] ${toolDef.description}`
      : `${runtime.id} tool: ${toolDef.name}`;

    return lcTool(
      async (args: any) =>
        // Always call the MCP server with the ORIGINAL tool name, not the sanitized one
        safeCallTool(runtime.client, toolDef.name, args || {}),
      { name, description, schema },
    );
  });
};

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const registerCleanup = () => {
  const cleanup = () => {
    for (const runtime of runtimes) {
      try {
        if (typeof runtime.client.close === "function") {
          runtime.client.close();
        }
        if (typeof (runtime.transport as any).close === "function") {
          (runtime.transport as any).close();
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

// ─── Public API ───────────────────────────────────────────────────────────────

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
      let runtime: McpServerRuntime;

      if (server.type === "http") {
        runtime = await startHttpServer(server as McpHttpServerConfig);
      } else {
        runtime = await startStdioServer(server as McpStdioServerConfig);
      }

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

/** Force-clear the tool cache (useful after config changes) */
export const resetMcpToolCache = () => {
  cachedTools = null;
  runtimes = [];
};
