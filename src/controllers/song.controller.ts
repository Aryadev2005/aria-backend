import { FastifyRequest, FastifyReply } from "fastify";
import * as groqService from "../services/ai/groq.service";
import { cache, CacheKeys, TTL } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

export interface GetSongsQuery {
  niche: string;
  lifecycle?: string;
  signal?: string;
  limit?: number;
}

/**
 * Get trending songs filtered by niche and status
 */
export const getSongs = async (
  req: FastifyRequest<{ Querystring: GetSongsQuery }>,
  reply: FastifyReply,
) => {
  const { niche, lifecycle = "all", signal = "all", limit = 10 } = req.query;

  try {
    const cacheKey = CacheKeys.songs(niche);
    let songs: any[] | null = await cache.get(cacheKey);

    if (!songs) {
      const result: any = await groqService.generateSongInsights({
        niche,
        platform: "instagram",
      });
      songs = result.songs || result;
      if (songs) {
        await cache.set(cacheKey, songs, TTL.SONG);
      }
    }

    if (!songs) return success(reply, []);

    let filtered = [...songs];
    if (lifecycle !== "all")
      filtered = filtered.filter((s) => s.lifecycle === lifecycle);
    if (signal !== "all")
      filtered = filtered.filter((s) => s.signal === signal);

    return success(reply, filtered.slice(0, limit));
  } catch (err) {
    logger.error({ err }, "Get songs failed");
    return errors.serviceDown(reply, "Song intelligence");
  }
};

/**
 * Get top 10 trending songs for a niche
 */
export const getTop10 = async (
  req: FastifyRequest<{ Querystring: { niche: string } }>,
  reply: FastifyReply,
) => {
  const { niche } = req.query;

  try {
    const cacheKey = CacheKeys.songs(niche);
    let songs: any[] | null = await cache.get(cacheKey);

    if (!songs) {
      const result: any = await groqService.generateSongInsights({
        niche,
        platform: "instagram",
      });
      songs = result.songs || result;
      if (songs) {
        await cache.set(cacheKey, songs, TTL.SONG);
      }
    }

    return success(reply, (songs || []).slice(0, 10));
  } catch (err) {
    logger.error({ err }, "Get top10 songs failed");
    return errors.serviceDown(reply, "Song intelligence");
  }
};

/**
 * Get single song details by ID
 */
export const getSongById = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const cached = await cache.get(CacheKeys.songById(req.params.id));
    if (cached) return success(reply, cached);
    return errors.notFound(reply, "Song");
  } catch (err) {
    return errors.internal(reply);
  }
};

/**
 * Predict upcoming trending songs
 */
export const predictTrendingSongs = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    const result: any = await groqService.generateSongInsights({
      niche: user.niches?.[0] || "fashion",
      platform: user.primary_platform || "instagram",
    });

    const songs = result.songs || result;
    const predictions = (songs || [])
      .filter((s: any) => s.lifecycle === "early")
      .sort((a: any, b: any) => (b.rank || 0) - (a.rank || 0));

    return success(reply, predictions);
  } catch (err) {
    logger.error({ err }, "Song prediction failed");
    return errors.serviceDown(reply, "Song predictor");
  }
};
