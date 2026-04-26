'use strict'

const claudeService = require('../services/ai/claude.service')
const { cache, CacheKeys, TTL } = require('../config/redis')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const getSongs = async (req, reply) => {
  const { niche, lifecycle, signal, limit } = req.query

  try {
    const cacheKey = CacheKeys.songs(niche)
    let songs = await cache.get(cacheKey)

    if (!songs) {
      songs = await claudeService.generateSongInsights({
        niche,
        platform: 'instagram',
      })
      await cache.set(cacheKey, songs, TTL.SONG)
    }

    if (lifecycle !== 'all') songs = songs.filter(s => s.lifecycle === lifecycle)
    if (signal !== 'all')    songs = songs.filter(s => s.signal === signal)

    return success(reply, songs.slice(0, limit))
  } catch (err) {
    logger.error({ err }, 'Get songs failed')
    return errors.serviceDown(reply, 'Song intelligence')
  }
}

const getTop10 = async (req, reply) => {
  const { niche } = req.query

  try {
    const cacheKey = CacheKeys.songs(niche)
    let songs = await cache.get(cacheKey)

    if (!songs) {
      songs = await claudeService.generateSongInsights({
        niche,
        platform: 'instagram',
      })
      await cache.set(cacheKey, songs, TTL.SONG)
    }

    return success(reply, songs.slice(0, 10))
  } catch (err) {
    logger.error({ err }, 'Get top10 songs failed')
    return errors.serviceDown(reply, 'Song intelligence')
  }
}

const getSongById = async (req, reply) => {
  try {
    const cached = await cache.get(CacheKeys.songById(req.params.id))
    if (cached) return success(reply, cached)
    return errors.notFound(reply, 'Song')
  } catch (err) {
    return errors.internal(reply)
  }
}

const predictTrendingSongs = async (req, reply) => {
  try {
    const user = req.user
    const songs = await claudeService.generateSongInsights({
      niche:    user.niches?.[0] || 'fashion',
      platform: user.primaryPlatform || 'instagram',
    })

    const predictions = songs
      .filter(s => s.lifecycle === 'early')
      .sort((a, b) => b.rank - a.rank)

    return success(reply, predictions)
  } catch (err) {
    logger.error({ err }, 'Song prediction failed')
    return errors.serviceDown(reply, 'Song predictor')
  }
}

module.exports = { getSongs, getTop10, getSongById, predictTrendingSongs }