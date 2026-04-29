"use strict";

require("dotenv").config();

const { QueueEvents } = require("bullmq");
const { connectDB, getDB, disconnectDB } = require("../src/config/database");
const {
  connectRedis,
  getRedisClient,
  getWorkerRedisClient,
} = require("../src/config/redis");
const {
  trendQueue,
  songQueue,
  scrapeQueue,
  cleanupQueues,
} = require("../src/config/queue");
const { startAllWorkers, stopAllWorkers } = require("../src/workers");

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {
    userId: null,
    handle: null,
    platform: "instagram",
    timeoutMs: 180000,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--userId") out.userId = args[++i];
    else if (a === "--handle") out.handle = args[++i];
    else if (a === "--platform") out.platform = args[++i];
    else if (a === "--timeoutMs") out.timeoutMs = parseInt(args[++i], 10);
  }

  return out;
};

const waitForJob = async (queueName, queueConnection, job, timeoutMs) => {
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

const getRecentCounts = async () => {
  const sql = getDB();
  const trends = await sql.unsafe(
    "SELECT COUNT(*)::int AS c FROM live_trends WHERE fetched_at > NOW() - INTERVAL '20 minutes'",
  );
  const songs = await sql.unsafe(
    "SELECT COUNT(*)::int AS c FROM live_songs WHERE fetched_at > NOW() - INTERVAL '20 minutes'",
  );
  return {
    liveTrends: trends[0]?.c || 0,
    liveSongs: songs[0]?.c || 0,
  };
};

const main = async () => {
  const { userId, handle, platform, timeoutMs } = parseArgs();
  let scrapeRequested = false;

  try {
    console.log("1) Connecting DB + Redis...");
    await connectDB();
    await connectRedis();

    console.log("2) Starting workers...");
    await startAllWorkers();

    console.log("3) Enqueuing trend + song jobs...");
    const trendJob = await trendQueue.add(
      "manual-trend-test",
      {},
      {
        removeOnComplete: 5,
        removeOnFail: 5,
      },
    );

    const songJob = await songQueue.add(
      "manual-song-test",
      {},
      {
        removeOnComplete: 5,
        removeOnFail: 5,
      },
    );

    let scrapeJob = null;
    if (userId && handle) {
      scrapeRequested = true;
      console.log("4) Enqueuing scrape job...");
      scrapeJob = await scrapeQueue.add(
        "manual-scrape-test",
        {
          userId,
          handle,
          platform,
        },
        {
          attempts: 1,
          removeOnComplete: 5,
          removeOnFail: 5,
        },
      );
    }

    console.log("5) Waiting for completion...");
    const queueConnection = getRedisClient();
    const trendResult = await waitForJob(
      "trend-refresh",
      queueConnection,
      trendJob,
      timeoutMs,
    );
    const songResult = await waitForJob(
      "song-refresh",
      queueConnection,
      songJob,
      timeoutMs,
    );
    const scrapeResult = scrapeJob
      ? await waitForJob(
          "profile-scrape",
          queueConnection,
          scrapeJob,
          timeoutMs,
        )
      : null;

    const counts = await getRecentCounts();

    console.log("\n=== Worker Smoke Test Summary ===");
    console.log(
      "trend-refresh:",
      trendResult.ok ? "PASS" : `FAIL (${trendResult.error})`,
    );
    console.log(
      "song-refresh :",
      songResult.ok ? "PASS" : `FAIL (${songResult.error})`,
    );

    if (scrapeRequested) {
      console.log(
        "profile-scrape:",
        scrapeResult.ok ? "PASS" : `FAIL (${scrapeResult.error})`,
      );
    } else {
      console.log(
        "profile-scrape: SKIPPED (provide --userId and --handle to test)",
      );
    }

    console.log("recent rows   :", counts);

    const hasFailure =
      !trendResult.ok ||
      !songResult.ok ||
      (scrapeRequested && !scrapeResult.ok);
    process.exitCode = hasFailure ? 1 : 0;
  } catch (err) {
    console.error("Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    await stopAllWorkers().catch(() => {});
    await cleanupQueues().catch(() => {});
    await disconnectDB().catch(() => {});
    const redis = getRedisClient();
    const workerRedis = getWorkerRedisClient();
    if (redis) await redis.quit().catch(() => {});
    if (workerRedis) await workerRedis.quit().catch(() => {});
  }
};

main();
