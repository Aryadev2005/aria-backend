import "dotenv/config";
import { startDiscoveryWorker } from "../src/workers/discovery.worker";
import { Queue } from "bullmq";

async function main() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  const connection = { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
  
  const worker = await startDiscoveryWorker();
  
  const queue = new Queue("discovery-queue", { connection });
  console.log("Adding job to queue...");
  await queue.add("discovery-global", {});
  
  console.log("Job added, waiting for worker to process...");
  
  // Wait 60 seconds for the worker to do some work (Reddit + YouTube should finish quickly)
  await new Promise(resolve => setTimeout(resolve, 60000));
  
  console.log("Stopping worker...");
  await worker?.close();
  await queue.close();
  
  console.log("Done.");
  process.exit(0);
}

main().catch(console.error);
