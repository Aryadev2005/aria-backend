// scripts/seed-graph.ts
// One-time graph seed CLI — populates base nodes + edges + triggers first embedding
// Safe to re-run (all upserts are idempotent)
// Usage: npx ts-node scripts/seed-graph.ts

import "dotenv/config";

async function main() {
  console.log("🌱 Seeding knowledge graph...\n");

  // Late imports so dotenv loads first
  const { prisma } = await import("../src/config/database");
  const { upsertNode, upsertEdge } = await import(
    "../src/services/graph/knowledge-graph.service"
  );

  // ── Niche Nodes ─────────────────────────────────────────────────────────
  const niches = [
    "fashion", "beauty", "fitness", "food", "tech", "gaming",
    "comedy", "travel", "cricket", "education", "lifestyle",
    "finance", "music", "dance", "bollywood", "motivation",
    "startup", "wellness", "books", "edits",
  ];

  console.log(`Creating ${niches.length} niche nodes...`);
  const nicheNodes: Record<string, any> = {};
  for (const niche of niches) {
    nicheNodes[niche] = await upsertNode("NICHE", niche, {
      category: "content",
      region: "IN",
    });
  }

  // ── Platform Nodes ──────────────────────────────────────────────────────
  const platforms = ["instagram", "youtube", "twitter", "linkedin", "threads"];

  console.log(`Creating ${platforms.length} platform nodes...`);
  const platformNodes: Record<string, any> = {};
  for (const platform of platforms) {
    platformNodes[platform] = await upsertNode("PLATFORM", platform, {
      type: "social_media",
    });
  }

  // ── Format Nodes ────────────────────────────────────────────────────────
  const formats = ["reel", "carousel", "short", "video", "story", "post", "thread"];

  console.log(`Creating ${formats.length} format nodes...`);
  for (const format of formats) {
    await upsertNode("FORMAT", format, { type: "content_format" });
  }

  // ── Archetype Nodes ─────────────────────────────────────────────────────
  const archetypes = [
    "EDUCATOR", "ENTERTAINER", "INFLUENCER",
    "BUILDER", "STORYTELLER", "EXPERT",
  ];

  console.log(`Creating ${archetypes.length} archetype nodes...`);
  for (const archetype of archetypes) {
    await upsertNode("ARCHETYPE", archetype.toLowerCase(), {
      label: archetype,
    });
  }

  // ── Cross-Pollination Edges (Niche × Niche) ────────────────────────────
  const crossPollinationPairs: [string, string, number][] = [
    ["fashion", "beauty", 0.85],
    ["fashion", "lifestyle", 0.75],
    ["beauty", "lifestyle", 0.70],
    ["beauty", "wellness", 0.65],
    ["fitness", "wellness", 0.80],
    ["fitness", "food", 0.55],
    ["food", "travel", 0.60],
    ["tech", "gaming", 0.70],
    ["tech", "startup", 0.75],
    ["tech", "finance", 0.50],
    ["startup", "finance", 0.65],
    ["startup", "motivation", 0.60],
    ["comedy", "bollywood", 0.55],
    ["comedy", "cricket", 0.40],
    ["music", "dance", 0.80],
    ["music", "bollywood", 0.75],
    ["education", "books", 0.70],
    ["education", "finance", 0.50],
    ["travel", "lifestyle", 0.65],
    ["motivation", "fitness", 0.55],
  ];

  console.log(`Creating ${crossPollinationPairs.length} cross-pollination edges...`);
  for (const [from, to, weight] of crossPollinationPairs) {
    if (nicheNodes[from] && nicheNodes[to]) {
      await upsertEdge(
        nicheNodes[from].id, nicheNodes[to].id,
        "CROSS_POLLINATES", weight,
        { bidirectional: true },
      );
      // Reverse edge for bidirectional
      await upsertEdge(
        nicheNodes[to].id, nicheNodes[from].id,
        "CROSS_POLLINATES", weight * 0.9, // slightly lower reverse weight
        { bidirectional: true },
      );
    }
  }

  // ── Platform Lag Edges ──────────────────────────────────────────────────
  // Instagram trends tend to lead YouTube by ~2 days
  const platformLags: [string, string, number, number][] = [
    ["instagram", "youtube", 2, 0.75],
    ["twitter", "instagram", 1, 0.65],
    ["twitter", "youtube", 3, 0.60],
  ];

  console.log(`Creating ${platformLags.length} platform lag edges...`);
  for (const [from, to, lagDays, confidence] of platformLags) {
    if (platformNodes[from] && platformNodes[to]) {
      await upsertEdge(
        platformNodes[from].id, platformNodes[to].id,
        "LAGS_BY", confidence,
        { lagDays },
      );
    }
  }

  // ── Niche → Platform TRENDS_ON edges ────────────────────────────────────
  // Which niches trend on which platforms
  const nichePlatformMap: Record<string, string[]> = {
    fashion:    ["instagram", "youtube"],
    beauty:     ["instagram", "youtube"],
    fitness:    ["instagram", "youtube"],
    food:       ["instagram", "youtube"],
    tech:       ["youtube", "twitter"],
    gaming:     ["youtube", "twitter"],
    comedy:     ["instagram", "youtube"],
    travel:     ["instagram", "youtube"],
    cricket:    ["twitter", "instagram", "youtube"],
    education:  ["youtube"],
    lifestyle:  ["instagram"],
    finance:    ["youtube", "twitter"],
    music:      ["instagram", "youtube"],
    dance:      ["instagram"],
    bollywood:  ["instagram", "twitter", "youtube"],
    motivation: ["instagram", "linkedin"],
    startup:    ["twitter", "linkedin"],
  };

  let trendsOnCount = 0;
  for (const [niche, plats] of Object.entries(nichePlatformMap)) {
    for (const platform of plats) {
      if (nicheNodes[niche] && platformNodes[platform]) {
        await upsertEdge(
          nicheNodes[niche].id, platformNodes[platform].id,
          "TRENDS_ON", 0.7,
        );
        trendsOnCount++;
      }
    }
  }
  console.log(`Created ${trendsOnCount} niche → platform edges`);

  // ── Summary ─────────────────────────────────────────────────────────────
  const nodeCount = await prisma.graph_nodes.count();
  const edgeCount = await prisma.graph_edges.count();

  console.log(`\n✅ Graph seeded successfully!`);
  console.log(`   Nodes: ${nodeCount}`);
  console.log(`   Edges: ${edgeCount}`);

  // ── Optional: trigger first embedding run ───────────────────────────────
  try {
    const { embedAllTrends } = await import(
      "../src/services/vector/embedding.service"
    );
    const trendCount = await prisma.live_trends.count({
      where: { expires_at: { gt: new Date() } },
    });

    if (trendCount > 0) {
      console.log(`\n🔄 Embedding ${trendCount} live trends...`);
      const embedded = await embedAllTrends();
      console.log(`✅ Embedded ${embedded} trends`);
    } else {
      console.log("\nℹ️  No live trends to embed yet. Run trend workers first.");
    }
  } catch (err: any) {
    console.log(`\n⚠️  Embedding skipped: ${err.message}`);
    console.log("   Run trend workers first, then re-run this script.");
  }

  await prisma.$disconnect();
  console.log("\n🎉 Done! Graph is ready.");
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
