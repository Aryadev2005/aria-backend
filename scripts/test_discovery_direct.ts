import { processJob } from "../src/workers/discovery.worker";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting discovery worker manually...");
  
  // Create a mock job object
  const mockJob = {
    id: "manual-test",
    updateProgress: async (progress: number) => {
      console.log(`Progress: ${progress}%`);
    }
  } as any;

  // We need to import the unexported processJob, but wait, processJob is not exported in discovery.worker.ts.
  // Instead of importing, I will just call startDiscoveryWorker and then add a job.
}
main();
