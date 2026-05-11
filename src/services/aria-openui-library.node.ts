/**
 * aria-openui-library.node.ts
 *
 * Server-side (Node.js) version of the ARIA component library.
 * Renderers are set to `null` — only used to generate the system prompt.
 *
 * Usage in ariaBrain.service.ts or agent.controller.ts:
 *
 *   import { ariaLibraryNode } from './aria-openui-library.node';
 *   const OPENUI_SYSTEM_PROMPT = ariaLibraryNode.prompt();
 *
 * Then prepend OPENUI_SYSTEM_PROMPT to ARIA_SOUL (see ARIA_SOUL patch below).
 */

import { z } from "zod";
import { defineComponent, createLibrary } from "@openuidev/react-lang";
// ↑ The /node sub-export has no React dep — safe in Fastify/Node context.

// ─── Component specs (props only, renderer = null) ────────────────────────────

const TrendCard = defineComponent({
  name: "TrendCard",
  description:
    "Displays a single trending topic/keyword with heat score, direction, and insight.",
  props: z.object({
    title: z.string().describe("Trend name or keyword"),
    subtitle: z
      .string()
      .optional()
      .describe('Brief context e.g. "Spotted on Instagram Reels"'),
    direction: z.enum(["rising", "falling", "stable"]),
    changeLabel: z.string().describe('e.g. "+34% this week"'),
    score: z.number().min(0).max(100).optional().describe("Heat score 0-100"),
    platform: z.string().optional(),
    niche: z.string().optional(),
    insight: z.string().optional().describe("Actionable tip for the creator"),
  }),
  component: () => null, // Server-side: no renderer
});

const TrendGrid = defineComponent({
  name: "TrendGrid",
  description:
    'Ranked list of up to 10 trends. Use for "what\'s trending" overviews.',
  props: z.object({
    header: z.string().optional(),
    trends: z
      .array(
        z.object({
          title: z.string(),
          subtitle: z.string().optional(),
          direction: z.enum(["rising", "falling", "stable"]),
          badge: z
            .string()
            .optional()
            .describe('Short label e.g. "HOT", "Saturated"'),
        }),
      )
      .min(1)
      .max(10),
  }),
  component: () => null, // Server-side: no renderer
});

const SongCard = defineComponent({
  name: "SongCard",
  description:
    "Trending song with artist, mood, lifecycle stage, and content advice.",
  props: z.object({
    title: z.string(),
    artist: z.string(),
    genre: z.string().optional(),
    mood: z.string().optional(),
    lifecycle: z.enum(["Rising", "Peak", "Declining", "Evergreen"]).optional(),
    usageScore: z.number().optional().describe("0-100"),
    insight: z.string().optional(),
  }),
  component: () => null, // Server-side: no renderer
});

const ContentIdea = defineComponent({
  name: "ContentIdea",
  description:
    "Single content idea with hook, format, optional script, viral potential.",
  props: z.object({
    hook: z.string(),
    format: z.string().optional().describe('e.g. "30s Reel", "Carousel"'),
    script: z.string().optional().describe("2-4 line snippet"),
    niche: z.string().optional(),
    viralPotential: z.enum(["High", "Medium", "Low"]).optional(),
    estimatedReach: z.string().optional(),
    cta: z.string().optional(),
  }),
  component: () => null, // Server-side: no renderer
});

const IdeaBatch = defineComponent({
  name: "IdeaBatch",
  description:
    "Multiple content ideas in one card — use when user asks for 3+ ideas.",
  props: z.object({
    header: z.string().optional(),
    ideas: z
      .array(
        z.object({
          hook: z.string(),
          format: z.string().optional(),
          tip: z.string().optional(),
        }),
      )
      .min(2)
      .max(10),
  }),
  component: () => null, // Server-side: no renderer
});

const AnalyticsSnapshot = defineComponent({
  name: "AnalyticsSnapshot",
  description:
    "Key metric grid — use for profile stats, engagement summaries, performance data.",
  props: z.object({
    title: z.string().optional(),
    metrics: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          change: z.string().optional(),
        }),
      )
      .min(2)
      .max(8),
    summary: z.string().optional(),
  }),
  component: () => null, // Server-side: no renderer
});

const RateCard = defineComponent({
  name: "RateCard",
  description: "Brand deal rate card with deliverable types and INR pricing.",
  props: z.object({
    creatorName: z.string().optional(),
    niche: z.string().optional(),
    tier: z.string().optional(),
    followers: z.string().optional(),
    engagementRate: z.string().optional(),
    deliverables: z
      .array(
        z.object({
          type: z.string(),
          rate: z.string(),
          notes: z.string().optional(),
        }),
      )
      .min(1)
      .max(8),
    note: z.string().optional(),
  }),
  component: () => null, // Server-side: no renderer
});

const GrowthRoadmap = defineComponent({
  name: "GrowthRoadmap",
  description: "Step-by-step growth plan with phases and milestones.",
  props: z.object({
    title: z.string().optional(),
    phases: z
      .array(
        z.object({
          label: z.string(),
          timeframe: z.string().optional(),
          description: z.string(),
          milestone: z.string().optional(),
          done: z.boolean().optional(),
        }),
      )
      .min(2)
      .max(6),
  }),
  component: () => null, // Server-side: no renderer
});

const QuickActions = defineComponent({
  name: "QuickActions",
  description:
    "Follow-up action chips. ALWAYS add after complex or multi-topic responses.",
  props: z.object({
    label: z.string().optional(),
    actions: z
      .array(
        z.object({
          label: z.string(),
          emoji: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .min(1)
      .max(5),
  }),
  component: () => null, // Server-side: no renderer
});

const InfoAlert = defineComponent({
  name: "InfoAlert",
  description: "Callout for tips, warnings, or confirmations.",
  props: z.object({
    variant: z.enum(["tip", "warning", "success", "info"]),
    title: z.string(),
    body: z.string(),
  }),
  component: () => null, // Server-side: no renderer
});

// ─── Export ───────────────────────────────────────────────────────────────────
export const ariaLibraryNode = createLibrary({
  root: "IdeaBatch",
  components: [
    TrendCard,
    TrendGrid,
    SongCard,
    ContentIdea,
    IdeaBatch,
    AnalyticsSnapshot,
    RateCard,
    GrowthRoadmap,
    QuickActions,
    InfoAlert,
  ],
});
