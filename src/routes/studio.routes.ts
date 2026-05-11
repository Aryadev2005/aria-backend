import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/studio.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";
// At the top, add the import:
import { streamDeepAnalysis } from "../controllers/deepAnalysis.controller";

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
    streamDeepAnalysis as any,
  );
}
