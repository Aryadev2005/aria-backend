"use strict";

import "dotenv/config";
import { Queue, QueueEvents } from "bullmq";
import { connectDB, prisma as db, disconnectDB } from "../src/config/database.ts";
import {
  connectRedis,
  getRedisClient,
  getWorkerRedisClient,
} from "../src/config/redis.ts";
import { startSongWorker } from "../src/workers/song.worker.ts";
import { stopAllWorkers } from "../src/workers/index.ts";
import { logger } from "../src/utils/logger.ts";

function getRedisConn() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379"),
    maxRetriesPerRequest: null,
  };
}

const songQueue = new Queue("song-refresh", { connection: getRedisConn() });

const waitForJob = async (
  queueName: string,
  queueConnection: any,
  job: any,
  timeoutMs: number = 120000,
) => {
  const events = new QueueEvents(queueName, { connection: queueConnection });
  await events.waitUntilReady();
  try {
    const result = await job.waitUntilFinished(events, timeoutMs);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    await events.close().catch(() => {});
  }
};

const getSongCounts = async () => {
  const r = await db.$queryRawUnsafe(
    "SELECT COUNT(*)::int AS c FROM live_songs WHERE fetched_at > NOW() - INTERVAL '20 minutes'",
  ) as any[];
  return r[0]?.c || 0;
};

const main = async () => {
  try {
    console.log("\n=== Song Worker Smoke Test ===\n");

    console.log("1) Connecting to DB + Redis...");
    await connectDB();
    await connectRedis();
    logger.info("Connected");

    console.log("2) Starting song worker...");
    const worker = await startSongWorker();
    if (!worker) {
      throw new Error("Song worker is disabled");
    }
    console.log("   ✓ Song worker started");

    console.log("3) Enqueuing song job...");
    const job = await songQueue.add(
      "manual-song-test",
      {},
      {
        removeOnComplete: 5,
        removeOnFail: 5,
      },
    );
    console.log(`   ✓ Job enqueued: ${job.id}`);

    console.log("4) Waiting for job completion...");
    const queueConnection = getRedisClient();
    const result = await waitForJob(
      "song-refresh",
      queueConnection,
      job,
      120000,
    );

    console.log("\n=== Results ===");
    if (result.ok) {
      console.log("Status: ✓ PASS");
      console.log("\nJob Output:");
      console.log(`  Success: ${result.result.success}`);
      console.log(`  Songs Inserted: ${result.result.songsInserted}`);
      if (result.result.diagnostics) {
        console.log("\n  Data Source Diagnostics:");
        Object.entries(result.result.diagnostics.sources).forEach(
          ([source, status]) => {
            console.log(`    ${source}: ${status}`);
          },
        );
      }
    } else {
      console.log("Status: ✗ FAIL");
      console.log("Error:", result.error);
    }

    const songCount = await getSongCounts();
    console.log(`\nRecent song records in DB: ${songCount}`);

    // Query to see what sources were inserted
    if (songCount > 0) {
      const sources = await db.$queryRawUnsafe(
        "SELECT source, COUNT(*)::int as count FROM live_songs WHERE fetched_at > NOW() - INTERVAL '20 minutes' GROUP BY source ORDER BY count DESC",
      ) as any[];
      console.log("\nSongs by source:");
      sources.forEach((row) => {
        console.log(`  ${row.source}: ${row.count}`);
      });
    }

    process.exitCode = result.ok ? 0 : 1;
  } catch (err: any) {
    console.error("Test failed:", err.message);
    process.exitCode = 1;
  } finally {
    await stopAllWorkers().catch(() => {});
    await songQueue.close().catch(() => {});
    await disconnectDB().catch(() => {});
    const redis = getRedisClient();
    const workerRedis = getWorkerRedisClient();
    if (redis) await redis.quit().catch(() => {});
    if (workerRedis) await workerRedis.quit().catch(() => {});
    process.exit(process.exitCode);
  }
};

main();
