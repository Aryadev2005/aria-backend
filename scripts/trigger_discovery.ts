import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  const queue = new Queue("discovery-queue", { 
    connection: { host: parsed.hostname, port: parseInt(parsed.port || "6379") } 
  });

  console.log("Adding manual job to discovery-queue...");
  const job = await queue.add("discovery-global", {});
  console.log("Job added:", job.id);
  
  await queue.close();
}

main().catch(console.error).finally(() => prisma.$disconnect());
