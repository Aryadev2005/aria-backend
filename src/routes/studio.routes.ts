import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/studio.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";
import { streamYouTubeScript } from "../controllers/youtube_studio.controller";
import { prisma } from "../config/database";
// At the top, add the import:
import {
  streamScript,
  regenerateSection,
} from "../controllers/studio.controller";

export default async function studioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // AI-powered script endpoints
  app.post(
    "/script/structure",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["idea"],
          properties: {
            idea: { type: "string" },
            platform: { type: "string" },
            niche: { type: "string" },
            format: { type: "string" },
            mood: { type: "string" },
            collaboration: { type: "string" },
            angle: { type: "string" },
          },
        },
      },
    },
    ctrl.getScriptStructure as any,
  );

  app.post(
    "/script/advise",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["sectionLabel", "creatorContent"],
          properties: {
            sectionLabel: { type: "string" },
            creatorContent: { type: "string" },
            sectionType: { type: "string" },
            idea: { type: "string" },
            mood: { type: "string" },
          },
        },
      },
    },
    ctrl.adviseSection as any,
  );

  // AI-powered BGM match endpoint
  app.post(
    "/bgm/match",
    {
      preHandler: [
        authenticateFirebase,
        requireCredits("song_recommendations"),
      ],
      schema: {
        body: {
          type: "object",
          required: ["idea"],
          properties: {
            idea: { type: "string" },
            mood: { type: "string" },
            format: { type: "string" },
            duration: { type: "string" },
          },
        },
      },
    },
    ctrl.matchBGM as any,
  );

  // AI-powered shot list endpoint
  app.post(
    "/shots",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["idea"],
          properties: {
            idea: { type: "string" },
            format: { type: "string" },
            sections: { type: "array" },
          },
        },
      },
    },
    ctrl.getShotList as any,
  );

  // AI-powered editing help endpoint
  app.post(
    "/editing/help",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["problem", "tool"],
          properties: {
            problem: { type: "string" },
            tool: { type: "string" },
          },
        },
      },
    },
    ctrl.getEditingHelp as any,
  );

  // AI-powered video analysis endpoints
  app.post(
    "/analyse/url",
    {
      preHandler: [authenticateFirebase, requireCredits("video_analysis")],
      schema: {
        body: {
          type: "object",
          required: ["videoUrl"],
          properties: {
            videoUrl: { type: "string" },
            mood: { type: "string" },
          },
        },
      },
    },
    ctrl.analyseVideoUrl as any,
  );

  app.post(
    "/analyse/upload",
    {
      preHandler: [authenticateFirebase, requireCredits("video_analysis")],
    },
    ctrl.analyseVideoUpload as any,
  );

  // ── Session & History ──────────────────────────────────────────────────────
  app.post("/session/save", auth, ctrl.saveSession as any);

  app.get("/history", auth, ctrl.getScriptHistory as any);

  app.patch("/pin/:scriptId", auth, ctrl.togglePin as any);

  // ── Learning endpoint ──────────────────────────────────────────────────────
  app.post(
    "/learn",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["generatedSections", "editedSections", "intentLabel"],
          properties: {
            generatedSections: { type: "array" },
            editedSections: { type: "array" },
            intentLabel: {
              type: "string",
              enum: [
                "tightened_language",
                "changed_tone",
                "voice_was_off",
                "facts_were_wrong",
                "restructured",
                "other",
              ],
            },
            sessionId: { type: "string" },
          },
        },
      },
    },
    ctrl.learnFromEdit as any,
  );

  // POST /api/v1/studio/deep-analysis/stream
  app.post(
    "/deep-analysis/stream",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["topic"],
          properties: {
            topic: { type: "string", minLength: 2, maxLength: 300 },
            platform: { type: "string" },
            niche: { type: "string" },
            contentType: { type: "string" },
            angle: { type: "string" },
          },
        },
      },
    },
    streamScript as any,
  );

  // POST /api/v1/studio/script/stream  — Two-pass: research → script via SSE
  app.post(
    "/script/stream",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["idea"],
          properties: {
            idea: { type: "string", minLength: 2, maxLength: 400 },
            platform: { type: "string" },
            niche: { type: "string" },
            format: {
              type: "string",
              enum: ["reel", "post", "carousel", "video", "story", "thread"],
            },
            mood: { type: "string" },
            angle: { type: "string" },
            userQuery: { type: "string", maxLength: 500 },
            duration: { type: "string", maxLength: 50 },
          },
        },
      },
    },
    streamScript as any,
  );

  // POST /api/v1/studio/script/regenerate-section — Regenerate a single section
  app.post(
    "/script/regenerate-section",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: [
            "sectionId",
            "userInstructions",
            "idea",
            "sectionLabel",
            "sectionType",
            "allSections",
          ],
          properties: {
            sectionId: { type: "string" },
            sectionLabel: { type: "string" },
            sectionType: { type: "string" },
            currentContent: { type: "string" },
            userInstructions: { type: "string", minLength: 2, maxLength: 500 },
            idea: { type: "string" },
            format: { type: "string" },
            mood: { type: "string" },
            angle: { type: "string" },
            researchBrief: { type: "object" },
            allSections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  type: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    regenerateSection as any,
  );

  // POST /api/v1/studio/youtube/stream — Long-form YouTube script pipeline
  app.post(
    "/youtube/stream",
    {
      preHandler: [authenticateFirebase, requireCredits("script_writing")],
      schema: {
        body: {
          type: "object",
          required: ["idea"],
          properties: {
            idea:     { type: "string", minLength: 2, maxLength: 400 },
            niche:    { type: "string" },
            duration: { type: "string", maxLength: 20 },
            mood:     { type: "string" },
            angle:    { type: "string" },
            userQuery:{ type: "string", maxLength: 500 },
          },
        },
      },
    },
    streamYouTubeScript as any,
  );

  // POST /api/v1/studio/hook/log — Log creator's hook archetype choice
  app.post(
    "/hook/log",
    { preHandler: [authenticateFirebase] },
    async (req: any, reply: any) => {
      const user = req.user as any;
      const { archetype, niche, platform, wasAuto = false } = req.body as any;

      if (!archetype || !niche || !platform) {
        return reply.status(400).send({ error: "archetype, niche, platform required" });
      }

      try {
        await (prisma as any).hook_learnings.create({
          data: {
            user_id: user.id,
            niche,
            platform,
            archetype,
            was_auto: wasAuto,
          },
        });
        return reply.send({ success: true });
      } catch (err) {
        console.warn({ err }, "Hook learning log failed");
        return reply.send({ success: false });
      }
    },
  );
}
