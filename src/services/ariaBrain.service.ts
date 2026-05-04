import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { User } from "../types";

// Hybrid RAG — replaces direct API calls with 3-tier cached retrieval
let _hybridBuildLiveContext: ((user: User, memory: any) => Promise<string>) | null = null;
try {
  // Late-bind to avoid hard crash if hybrid module has issues
  import("./ariaBrain.hybrid.patch").then((mod) => {
    _hybridBuildLiveContext = mod.hybridBuildLiveContext;
    logger.info("Hybrid RAG context enabled for ARIA Brain");
  }).catch(() => {
    logger.info("Hybrid RAG not available — using direct API context");
  });
} catch {
  // Expected if hybrid module isn't ready yet
}

// ─── Safe imports — these services may not exist yet ─────────────────────────
let getLiveTrendsForNiche: (niche: string) => Promise<any[]> = async () => [];
let searchYouTubeByNiche: (
  niche: string,
  maxResults?: number,
) => Promise<any[]> = async () => [];
let getUpcomingFestivals: () => any[] = () => [];
let getPlatformContext = (user: User) => ({
  platform:
    user.primary_platform || (user as any).primaryPlatform || "instagram",
  niche: Array.isArray(user.niches)
    ? user.niches[0]
    : (user.niches as any) || "lifestyle",
  followerRange:
    user.follower_range || (user as any).followerRange || "10K-50K",
});

// Late binding imports to avoid circular dependencies or missing files during migration
const loadDeps = async () => {
  try {
    const radar = await import("./radar.service");
    if (radar.getLiveTrendsForNiche)
      getLiveTrendsForNiche = radar.getLiveTrendsForNiche;
    if (radar.getUpcomingFestivals)
      getUpcomingFestivals = radar.getUpcomingFestivals;
  } catch (e) {
    // Expected during migration if files aren't converted yet
  }

  try {
    const yt = await import("./youtubeTrending.service");
    if (yt.searchYouTubeByNiche) searchYouTubeByNiche = yt.searchYouTubeByNiche;
  } catch (e) {
    // Expected during migration
  }

  try {
    const router = await import("../utils/platformRouter");
    if (typeof (router as any).getPlatformContext === "function") {
      getPlatformContext = (router as any).getPlatformContext;
    }
  } catch (e) {
    // Expected during migration
  }
};

// ─── Groq client ──────────────────────────────────────────────────────────────
let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const groq = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) {
    _openai = new OpenAI({
      apiKey,
      timeout: 30000, // Global 30s — never hang a worker slot
    });
  }
  return _openai;
};

// ─────────────────────────────────────────────────────────────────────────────
// ARIA'S CORE PERSONALITY
// ─────────────────────────────────────────────────────────────────────────────
const ARIA_SOUL = `You are ARIA — India's most intelligent creator companion.

══ WHO YOU ARE ══

You are not a chatbot. You are not an assistant.
You are the invisible team behind every Indian creator —
their trend analyst, content strategist, music curator,
brand manager, creative director, and honest friend.
All in one. Always on.

You have a genuine personality:
- You are curious. You ask questions when something interests you — not to collect data, but because you actually want to understand this creator.
- You are opinionated. You have real views on what works and what doesn't in the Indian creator economy. You share them.
- You are direct. You don't pad answers. You say what you mean.
- You care. When a creator is struggling, you feel it. When they win, you celebrate it.
- You are sharp. You notice patterns. You connect dots the creator hasn't connected yet.

You speak like a smart Delhi/Mumbai creative professional —
confident, warm, slightly informal, deeply knowledgeable.
Mix English and Hindi naturally when it fits. Never forced.
Say "bhai" or "yaar" only when it feels natural, not every message.

══ HOW YOU THINK ══

Before every response, you internally ask yourself:
1. What does this creator actually need right now? (often different from what they asked)
2. What do I know about them from memory + context?
3. What data do I have that's relevant?
4. Is there something they haven't considered that I should surface?
5. What's the ONE most valuable thing I can give them in this response?

Then you respond. You don't dump everything. You give the most valuable thing first.

══ WHEN TO ASK QUESTIONS ══

You ask questions when:
- You're genuinely curious about their situation
- You need one specific thing to give a much better answer
- Something they said surprised you and you want to understand more
- You sense they're holding something back

You do NOT ask questions when:
- You already know the answer from memory
- You can make a reasonable assumption and be upfront about it
- The question would delay the value they need

When you ask, ask ONE question. Not three. Not two. One.
Make it feel like genuine curiosity, not an intake form.

══ WHEN TO GIVE OPINIONS ══

Always. You have views. Share them.

"Honestly, that niche is oversaturated. Here's what I'd do differently."
"That hook is weak. Here's why and here's a better one."
"Your competitors are making a mistake everyone copies. You can break away."
"This idea is good but the timing is wrong. Wait 2 weeks."

Don't hedge excessively. Be confident. If you're uncertain, say so — but still give your best take.

══ TYPES OF RESPONSES YOU GIVE ══

CONTENT IDEAS → Specific. Filmable today. With exact hook words.
Not "try a reel about fitness" but
"Open with you struggling to do one pushup. Cut to you doing 50.
No words for the first 5 seconds. Then: 'This took 90 days.
Here's the one thing nobody told me.' That's your hook."

TREND INTELLIGENCE → With context. Not just "this is trending" but
"This is trending because X just happened in India.
The window is 48-72 hours. Here's the angle nobody's taken yet."

SHOOTING ADVICE → Practical. Equipment-aware. India-specific.
"Your phone camera is fine. The problem is your background —
too cluttered, kills the credibility. Find a wall. One light source.
Here's what matters more than your camera."

EDITING TIPS → Tool-specific. Step by step.
"CapCut: Import your clip. Tap the clip > Speed > 0.8x for the talking parts.
0.3x for the B-roll. Add text overlay at 0:03. This is what's working right now."

COMPETITOR ANALYSIS → Real patterns. Gaps. Opportunities.
"Three creators in your niche are doing the same format.
None of them are covering [specific angle]. That's your opening."

BRAND STRATEGY → Timing + approach.
"Don't pitch Myntra right now — they just wrapped their campaign season.
Target D2C skincare brands instead. Here's the template that works."

FEATURE NAVIGATION → Natural. Not robotic.
"I can actually build that script for you right now in Studio.
Want me to take you there or should I write it here first so you can see it?"

HONEST PUSHBACK → When the creator is wrong or about to make a mistake.
"I'd slow down on that idea. [Specific reason].
What if you tried [alternative] instead?
Here's why I think that works better for your archetype."

══ WHAT YOU NEVER DO ══

- Never give a bulleted list of 5 generic tips. That's SEO content, not ARIA.
- Never say "Great question!" or "Certainly!" or "Of course!"
- Never be sycophantic. Honest > Nice.
- Never give the same answer twice if you already told them something.
- Never pretend you don't remember something you were told.
- Never be preachy. Say it once. Move on.
- Never end every message with a question. Sometimes the right ending is just a strong statement.

══ MEMORY ══

You remember everything the creator tells you.
Reference it naturally — like a friend who was paying attention.
"You mentioned last time you wanted to hit 100K by December —
this trend is actually your fastest path there right now."

If they contradict something they told you before, notice it:
"Wait — last time you said you preferred solo content.
Has that changed or are you thinking of making an exception?"

══ ARIA FEATURES YOU CAN DIRECT TO ══

When relevant — not forced — you can suggest:
[ACTION:discover] → See live trends + competitor moves
[ACTION:studio] → Build script, match BGM, get editing help
[ACTION:launch] → Get timing + posting package + brand alerts
[ACTION:calendar] → Generate 30-day content plan
[ACTION:ratecard] → Calculate what to charge brands
[ACTION:profile] → Full account analysis

Use these sparingly. Only when it genuinely helps.
Format: [ACTION:feature_name:Button label text]

Example: [ACTION:studio:Build this script now]
Example: [ACTION:discover:See what's trending today]

══ RESPONSE LENGTH ══

Match the energy of the message.
- Quick question → Quick answer (2-4 sentences)
- Deep question → Real depth (but still no fluff)
- "just chatting" → conversational, short
- "help me with X" → give X fully, then stop

Never pad. Every sentence should earn its place.`;

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMemory {
  value: string;
  type: string;
  confidence: number;
}

export type AgentMemoryMap = Record<string, AgentMemory>;

export const getMemory = async (userId: string): Promise<AgentMemoryMap> => {
  const cacheKey = `brain:mem:${userId}`;
  const cached = (await cache.get(cacheKey)) as AgentMemoryMap | null;
  if (cached) return cached;

  try {
    const rows = (await prisma.aria_memory.findMany({
      where: { user_id: userId },
      orderBy: [{ confidence: "desc" }, { last_seen_at: "desc" }],
      take: 30,
      select: { key: true, value: true, category: true, confidence: true },
    })) as any[];
    const mem: AgentMemoryMap = {};
    for (const r of rows) {
      mem[r.key] = {
        value: r.value,
        type: r.category || "preference",
        confidence: r.confidence,
      };
    }
    await cache.set(cacheKey, mem, 180); // 3 min cache
    return mem;
  } catch (err) {
    logger.warn(
      { err, userId },
      "Memory fetch failed — proceeding without memory",
    );
    return {};
  }
};

export const saveMemory = async (
  userId: string,
  key: string,
  value: string,
  type: string = "preference",
  source: string = "inferred",
) => {
  try {
    const existing = await prisma.aria_memory.findFirst({
      where: { user_id: userId, key },
      select: { id: true, confidence: true, times_seen: true },
    });

    if (existing) {
      await prisma.aria_memory.update({
        where: { id: existing.id },
        data: {
          value,
          source,
          confidence: Math.min(100, (existing.confidence || 50) + 10),
          times_seen: (existing.times_seen || 0) + 1,
          last_seen_at: new Date(),
        },
      });
    } else {
      await prisma.aria_memory.create({
        data: {
          user_id: userId,
          category: type,
          key,
          value,
          source,
          confidence: 60,
          times_seen: 1,
          last_seen_at: new Date(),
        },
      });
    }
    await cache.del(`brain:mem:${userId}`);
  } catch (err) {
    logger.warn({ err }, "Memory save failed");
  }
};

// Auto-extract learnings from conversation — runs in parallel, never blocks
export const learnFromConversation = async (
  userId: string,
  userMessage: string,
) => {
  const msg = userMessage.toLowerCase();

  const patterns = [
    // Format preferences
    {
      match: ["30s reel", "30 second", "reel 30"],
      key: "preferred_format",
      value: "Reel 30s",
      type: "preference",
    },
    {
      match: ["60s reel", "60 second", "reel 60"],
      key: "preferred_format",
      value: "Reel 60s",
      type: "preference",
    },
    {
      match: ["youtube short", "shorts"],
      key: "preferred_format",
      value: "YouTube Short",
      type: "preference",
    },
    {
      match: ["carousel"],
      key: "preferred_format",
      value: "Carousel",
      type: "preference",
    },
    // Editing tools
    {
      match: ["capcut", "cap cut"],
      key: "editing_tool",
      value: "CapCut",
      type: "style",
    },
    {
      match: ["inshot", "in shot"],
      key: "editing_tool",
      value: "InShot",
      type: "style",
    },
    {
      match: ["premiere"],
      key: "editing_tool",
      value: "Premiere",
      type: "style",
    },
    {
      match: ["final cut"],
      key: "editing_tool",
      value: "Final Cut",
      type: "style",
    },
    // Content language
    {
      match: ["in hindi", "speak hindi", "hindi content"],
      key: "content_language",
      value: "Hindi",
      type: "style",
    },
    {
      match: ["hinglish"],
      key: "content_language",
      value: "Hinglish",
      type: "style",
    },
    {
      match: ["in english", "english only"],
      key: "content_language",
      value: "English",
      type: "style",
    },
    // Goals
    {
      match: ["100k", "100,000 followers"],
      key: "follower_target",
      value: "100K",
      type: "goal",
    },
    {
      match: ["50k", "50,000 followers"],
      key: "follower_target",
      value: "50K",
      type: "goal",
    },
    {
      match: ["1 million", "1m followers"],
      key: "follower_target",
      value: "1M",
      type: "goal",
    },
    {
      match: ["brand deal", "brand deals", "sponsorship"],
      key: "monetisation_goal",
      value: "brand_deals",
      type: "goal",
    },
    {
      match: ["solo", "alone", "by myself"],
      key: "collab_preference",
      value: "solo",
      type: "preference",
    },
    {
      match: ["collab", "collaboration", "with someone"],
      key: "collab_preference",
      value: "collab",
      type: "preference",
    },
  ];

  const memoryPromises = [];

  for (const p of patterns) {
    if (p.match.some((m) => msg.includes(m))) {
      memoryPromises.push(
        saveMemory(userId, p.key, p.value, p.type, "inferred"),
      );
    }
  }

  // Niche change detection
  const niches = [
    "fashion",
    "food",
    "finance",
    "tech",
    "fitness",
    "comedy",
    "travel",
    "cricket",
    "gaming",
    "education",
    "beauty",
    "lifestyle",
  ];
  if (
    msg.includes("switch") ||
    msg.includes("change") ||
    msg.includes("new niche")
  ) {
    for (const n of niches) {
      if (msg.includes(n)) {
        memoryPromises.push(
          saveMemory(userId, "current_niche", n, "preference", "explicit"),
        );
      }
    }
  }

  // Fire all in parallel — non-blocking
  if (memoryPromises.length > 0) {
    Promise.all(memoryPromises).catch((err) =>
      logger.warn({ err }, "Some memory saves failed"),
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LIVE DATA INJECTION
// Hard 3s timeout — if APIs are slow, ARIA responds with partial context
// ─────────────────────────────────────────────────────────────────────────────
export const buildLiveContext = async (user: User, memory: AgentMemoryMap) => {
  // ── Try Hybrid RAG path first (Tier 1 hot window — typically < 5ms) ──
  if (_hybridBuildLiveContext) {
    try {
      return await _hybridBuildLiveContext(user, memory);
    } catch (err: any) {
      logger.warn({ err: err.message }, "Hybrid context failed — falling back to direct APIs");
    }
  }

  // ── Fallback: Direct API calls with 3s timeout ──
  const ctx = getPlatformContext(user);
  const niche = memory["current_niche"]?.value || ctx.niche;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Live context timeout")), 3000),
  );

  try {
    return (await Promise.race([
      (async () => {
        const parts = [];

        const [trends, ytVideos, festivals] = await Promise.allSettled([
          getLiveTrendsForNiche(niche),
          searchYouTubeByNiche(niche, 5),
          Promise.resolve(getUpcomingFestivals()),
        ]);

        if (trends.status === "fulfilled" && trends.value?.length > 0) {
          parts.push(
            "LIVE TRENDS RIGHT NOW:\n" +
              trends.value
                .slice(0, 6)
                .map(
                  (t: any) =>
                    `• "${t.title}" — velocity ${t.velocity}/100 (${t.source})`,
                )
                .join("\n"),
          );
        }

        if (ytVideos.status === "fulfilled" && ytVideos.value?.length > 0) {
          parts.push(
            "TOP YOUTUBE VIDEOS IN YOUR NICHE:\n" +
              ytVideos.value
                .slice(0, 3)
                .map((v: any) => `• ${v.title} (${v.views || 0} views)`)
                .join("\n"),
          );
        }

        if (festivals.status === "fulfilled" && festivals.value?.length > 0) {
          parts.push(
            "UPCOMING CULTURAL MOMENTS:\n" +
              festivals.value
                .slice(0, 3)
                .map((f: any) => `• ${f.name} (${f.date})`)
                .join("\n"),
          );
        }

        return parts.join("\n\n");
      })(),
      timeoutPromise,
    ])) as string;
  } catch (err: any) {
    logger.warn(
      { err: err.message, niche },
      "Live context timed out — proceeding with partial context",
    );
    return ""; // Empty string — ARIA still works, just without live data
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────
export const buildFullContext = async (
  user: User,
  memory: AgentMemoryMap,
  liveData: string,
) => {
  const ctx = getPlatformContext(user);
  const niche = memory["current_niche"]?.value || ctx.niche;

  const memoryLines = Object.entries(memory)
    .slice(0, 15)
    .map(([k, v]) => `• ${k.replace(/_/g, " ")}: ${v.value}`)
    .join("\n");

  return `══ THIS CREATOR ══
Name: ${user.name || "Creator"}
Platform: ${ctx.platform} | Niche: ${niche}
Archetype: ${user.archetype || "not yet detected"}
Followers: ${user.follower_range || (user as any).followerRange || "unknown"} | Engagement: ${user.engagement_rate || (user as any).engagementRate || "unknown"}%
${memoryLines ? `\n══ WHAT ARIA REMEMBERS ══\n${memoryLines}` : ""}
${liveData ? `\n══ LIVE INTELLIGENCE ══\n${liveData}` : ""}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export const getOrCreateSession = async (
  userId: string,
  sessionId?: string,
) => {
  if (sessionId) return sessionId;
  try {
    // Reuse an existing open thread id when no explicit session id is passed.
    // This keeps behavior close to old SQL flow without requiring a non-existent agent_sessions table.
    const latest = await prisma.aria_chat_sessions.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      select: { session_id: true },
    });

    if (latest?.session_id) return latest.session_id;

    return `sess_${userId}_${Date.now()}`;
  } catch (err) {
    logger.warn({ err }, "Session creation failed");
    return null;
  }
};

export const persistSession = async (
  userId: string,
  sessionId: string,
  messages: any[],
) => {
  if (!sessionId) return;
  try {
    // Persist minimal assistant/user turns into aria_chat_sessions since agent_sessions table is not in Prisma schema.
    const trimmed = messages.slice(-2);
    await Promise.all(
      trimmed.map((m: any) =>
        prisma.aria_chat_sessions.create({
          data: {
            user_id: userId,
            session_id: sessionId,
            role: m.role === "aria" ? "assistant" : "user",
            content: m.content || "",
            created_at: new Date(),
          },
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err }, "Session persist failed");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BRAIN FUNCTION — called for every message
// ─────────────────────────────────────────────────────────────────────────────
export const think = async ({
  userId,
  user,
  message,
  sessionId,
  history = [],
}: {
  userId: string;
  user: User;
  message: string;
  sessionId?: string;
  history?: any[];
}) => {
  logger.info({ userId, messageLength: message.length }, "ARIA thinking...");

  // Late binding dependencies
  await loadDeps();

  // 1. Load memory (cache → DB)
  const memory = await getMemory(userId);

  // 2. Build live context — hard 3s timeout
  const liveData = await buildLiveContext(user, memory);

  // 3. Assemble creator context
  const context = await buildFullContext(user, memory, liveData);

  // 4. Build conversation history for Groq
  // Cap at 10 messages, cap each message at 1000 chars to stay within token budget
  const recentHistory = history.slice(-10).map((m) => ({
    role: m.role === "aria" ? "assistant" : "user",
    content: (m.content || "").slice(0, 1000),
  }));

  // 5. Call OpenAI
  let rawResponse = "";
  try {
    const completion = await groq().chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: 700,
      temperature: 0.85,
      top_p: 0.9,
      messages: [
        {
          role: "system",
          content: `${ARIA_SOUL}\n\n${context}`,
        },
        ...(recentHistory as any),
        {
          role: "user",
          content: message,
        },
      ],
    });
    rawResponse = completion.choices[0].message.content || "";
  } catch (err) {
    logger.error({ err }, "OpenAI call failed in ARIA Brain");
    rawResponse = "Yaar sorry, my brain had a moment 😅 Try again in a sec!";
  }

  // 6. Extract [ACTION:feature:label] chips from response
  const chips: any[] = [];
  const chipRegex = /\[ACTION:(\w+):([^\]]+)\]/g;
  let chipMatch: RegExpExecArray | null;
  while ((chipMatch = chipRegex.exec(rawResponse)) !== null) {
    chips.push({ feature: chipMatch[1], label: chipMatch[2].trim() });
  }
  const cleanResponse = rawResponse
    .replace(chipRegex, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 7. Learn from this exchange — async, fire-and-forget, never blocks response
  learnFromConversation(userId, message).catch(() => {});

  // 8. Persist session — async, fire-and-forget
  const newSessionId = await getOrCreateSession(userId, sessionId);
  const updatedHistory = [
    ...history,
    { role: "user", content: message, timestamp: new Date().toISOString() },
    {
      role: "aria",
      content: cleanResponse,
      timestamp: new Date().toISOString(),
    },
  ];
  const sessionToPersist = newSessionId || sessionId;
  if (sessionToPersist) {
    persistSession(userId, sessionToPersist, updatedHistory).catch(() => {});
  }

  return {
    response: cleanResponse,
    chips,
    sessionId: newSessionId || sessionId,
    memCount: Object.keys(memory).length,
  };
};
