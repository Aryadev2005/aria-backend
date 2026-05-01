import { getMcpTools } from "../src/agent/mcp_tools";

const run = async () => {
  try {
    const tools = await getMcpTools();
    const names = tools.map((t: any) => t?.name).filter(Boolean);
    const byServer: Record<string, number> = {};

    for (const name of names) {
      const prefix = name.split(".")[0] || "unknown";
      byServer[prefix] = (byServer[prefix] || 0) + 1;
    }

    console.log("MCP tool discovery OK");
    console.log(`Total tools: ${names.length}`);
    console.log("By server:");
    for (const [server, count] of Object.entries(byServer)) {
      console.log(`- ${server}: ${count}`);
    }
  } catch (err: any) {
    console.error("MCP tool discovery failed");
    console.error(err?.message || err);
    process.exitCode = 1;
  }
};

run();
