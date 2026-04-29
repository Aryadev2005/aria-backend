"use strict";

require("dotenv").config();

const { QueueEvents } = require("bullmq");
const { connectDB, getDB, disconnectDB } = require("../src/config/database");
const {
  connectRedis,
  getRedisClient,
  getWorkerRedisClient,
} = require("../src/config/redis");
const { songQueue, cleanupQueues } = require("../src/config/queue");
const { startSongWorker } = require("../src/workers/song.worker");
const { stopAllWorkers } = require("../src/workers");
const { logger } = require("../src/utils/logger");

const waitForJob = async (
  queueName,
  queueConnection,
  job,
  timeoutMs = 120000,
) => {
  const events = new QueueEvents(queueName, { connection: queueConnection });
  await events.waitUntilReady();
  try {
    const result = await job.waitUntilFinished(events, timeoutMs);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    await events.close().catch(() => {});
  }
};

const getSongCounts = async () => {
  const sql = getDB();
  const r = await sql.unsafe(
    "SELECT COUNT(*)::int AS c FROM live_songs WHERE fetched_at > NOW() - INTERVAL '20 minutes'",
  );
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
      const sql = getDB();
      const sources = await sql.unsafe(
        "SELECT source, COUNT(*)::int as count FROM live_songs WHERE fetched_at > NOW() - INTERVAL '20 minutes' GROUP BY source ORDER BY count DESC",
      );
      console.log("\nSongs by source:");
      sources.forEach((row) => {
        console.log(`  ${row.source}: ${row.count}`);
      });
    }

    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error("Test failed:", err.message);
    process.exitCode = 1;
  } finally {
    await stopAllWorkers().catch(() => {});
    await cleanupQueues().catch(() => {});
    await disconnectDB().catch(() => {});
    const redis = getRedisClient();
    const workerRedis = getWorkerRedisClient();
    if (redis) await redis.quit().catch(() => {});
    if (workerRedis) await workerRedis.quit().catch(() => {});
    process.exit(process.exitCode);
  }
};

main();
