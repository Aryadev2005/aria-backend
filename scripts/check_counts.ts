import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const redditCount = await (prisma as any).$queryRaw`SELECT COUNT(*) FROM discovery_reddit_raw`;
  const liveTrendsCount = await (prisma as any).$queryRaw`SELECT COUNT(*) FROM live_trends WHERE source = 'reddit'`;
  
  console.log("Reddit Raw Count:", redditCount);
  console.log("Live Trends Reddit Count:", liveTrendsCount);
}

main().catch(console.error).finally(() => prisma.$disconnect());
