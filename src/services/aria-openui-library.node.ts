import { z } from "zod";

// ─── Minimal local stubs (replaces @openuidev/react-lang) ────────────────────

type ComponentDef = {
  name: string;
  description: string;
  props: z.ZodObject<any>;
  component: () => null;
};

function defineComponent(config: ComponentDef): ComponentDef {
  return config;
}

function describeZodShape(shape: Record<string, z.ZodTypeAny>): string {
  return Object.entries(shape)
    .map(([key, schema]) => {
      const isOptional = schema instanceof z.ZodOptional;
      return `  ${key}${isOptional ? "?" : ""}: ${describeZodType(schema)}`;
    })
    .join("\n");
}

function describeZodType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodOptional) return describeZodType((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return (schema as z.ZodEnum<any>).options.map((v: unknown) => `"${String(v)}"`).join(" | ");
  if (schema instanceof z.ZodArray) return `${describeZodType((schema as z.ZodArray<z.ZodTypeAny>).element)}[]`;
  if (schema instanceof z.ZodObject) return "object";
  return "any";
}

function createLibrary(config: { root: string; components: ComponentDef[] }) {
  return {
    prompt(): string {
      const componentDocs = config.components.map((c) => {
        const propsStr = describeZodShape(c.props.shape);
        return `### ${c.name}\n${c.description}\nProps:\n${propsStr}`;
      }).join("\n\n");

      return [
        "You can embed structured UI components in your responses using JSON code blocks.",
        'Format: ```component\n{"component":"ComponentName","props":{...}}\n```',
        "Only use a component when it genuinely improves clarity over plain text.",
        "",
        componentDocs,
      ].join("\n\n");
    },
  };
}

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

const ScriptCard = defineComponent({
  name: "ScriptCard",
  description: [
    "Full reel / short / video script with scene-by-scene breakdown.",
    'Use WHENEVER the user asks to "write a script", "give me a script", "script for X".',
    "NEVER use ContentIdea for scripts — always use ScriptCard.",
    "Each scene has: type (hook/build/value/cta/transition/reveal), timing, dialogue, visual direction, sfx, on-screen text.",
  ].join(" "),
  props: z.object({
    title: z.string(),
    format: z
      .string()
      .optional()
      .describe('"30s Reel", "60s Reel", "YouTube Short"'),
    totalDuration: z.string().optional().describe('"28–32 seconds"'),
    platform: z.string().optional(),
    niche: z.string().optional(),
    audio: z.string().optional().describe("Suggested song or audio style"),
    viralPotential: z.enum(["High", "Medium", "Low"]).optional(),
    scenes: z
      .array(
        z.object({
          type: z.enum([
            "hook",
            "build",
            "value",
            "cta",
            "transition",
            "reveal",
            "default",
          ]),
          scene: z.string().optional().describe('Label e.g. "Opening Hook"'),
          timing: z.string().optional().describe('"0–3s"'),
          dialogue: z.string().optional(),
          visual: z.string().optional().describe("Shot / camera direction"),
          sfx: z.string().optional().describe("Audio cue"),
          onScreenText: z
            .string()
            .optional()
            .describe("Text overlay on screen"),
        }),
      )
      .min(2)
      .max(14),
    ariaTip: z.string().optional(),
    captionHook: z.string().optional(),
    hashtags: z.array(z.string()).optional(),
  }),
  component: () => null,
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
    ScriptCard,
  ],
});
