// src/routes/song.routes.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Routes — all endpoints served from 3-tier architecture
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyInstance } from "fastify";
import * as songController from "../controllers/song.controller";
import {
  authenticateFirebase,
  requirePro,
} from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

export default async function songRoutes(app: FastifyInstance) {
  // ── GET /songs ─────────────────────────────────────────────────────────────
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string", default: "general" },
            language: { type: "string", default: "Hindi" },
            lifecycle: {
              type: "string",
              enum: [
                "RISING",
                "PEAKING",
                "DECLINING",
                "CYCLICAL",
                "DEAD",
                "all",
              ],
              default: "all",
            },
            signal: {
              type: "string",
              enum: ["postNow", "wait", "tooLate", "all"],
              default: "all",
            },
            limit: { type: "integer", minimum: 1, maximum: 120, default: 120 },
          },
        },
      },
    },
    songController.getSongs as any,
  );

  // ── GET /songs/top10 ───────────────────────────────────────────────────────
  app.get(
    "/top10",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string", default: "general" },
            language: { type: "string", default: "Hindi" },
          },
        },
      },
    },
    songController.getTop10 as any,
  );

  // ── GET /songs/predict — PRO only ─────────────────────────────────────────
  // app.get("/predict", {
  //   preHandler: [authenticateFirebase, requirePro],
  // }, songController.predictTrendingSongs as any);

  app.get(
    "/predict",
    {
      preHandler: [authenticateFirebase],
    },
    songController.predictTrendingSongs as any,
  );

  // ── GET /songs/by-mood — semantic search via embeddings ───────────────────
  app.get(
    "/by-mood",
    {
      preHandler: [
        authenticateFirebase,
        requireCredits("song_recommendations"),
      ],
      schema: {
        querystring: {
          type: "object",
          required: ["mood"],
          properties: {
            mood: { type: "string", minLength: 2 },
            niche: { type: "string", default: "general" },
            language: { type: "string", default: "Hindi" },
          },
        },
      },
    },
    songController.getSongsByMood as any,
  );

  // ── GET /songs/languages ───────────────────────────────────────────────────
  app.get("/languages", songController.getAvailableLanguages as any);

  // ── GET /songs/niches ───────────────────────────────────────────────────────
  app.get("/niches", songController.getAvailableNiches as any);

  // ── GET /songs/trajectory/:title ──────────────────────────────────────────
  app.get(
    "/trajectory/:title",
    {
      preHandler: [authenticateFirebase],
      schema: {
        params: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { language: { type: "string" } },
        },
      },
    },
    songController.getSongTrajectory as any,
  );

  // ── GET /songs/:id ─────────────────────────────────────────────────────────
  app.get(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    songController.getSongById as any,
  );

  // ── POST /songs/refresh — trigger scraping and refresh cache
  app.post(
    "/refresh",
    {
      preHandler: [authenticateFirebase],
    },
    songController.refreshSongs as any,
  );
}
