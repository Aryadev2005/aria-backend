import { getMcpTools } from "./mcp_tools";
import { logger } from "../utils/logger";

const main = async () => {
  try {
    const tools = await getMcpTools();
    const names = tools.map((t: any) => t.name).filter(Boolean);
    logger.info(
      { toolCount: names.length, tools: names },
      "MCP tool discovery OK",
    );
    process.exit(0);
  } catch (err: any) {
    logger.error({ err: err?.message || err }, "MCP tool discovery failed");
    process.exit(1);
  }
};

main();
