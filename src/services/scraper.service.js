'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const path = require('path')
const { getDB } = require('../config/database')
const { cache, CacheKeys } = require('../config/redis')
const { logger } = require('../utils/logger')

const execFileAsync = promisify(execFile)

/**
 * Compute engagement rate from posts
 * Formula: (avg_likes + avg_comments) / followers * 100
 */
const computeEngagementRate = (posts, followers) => {
  if (!posts || !posts.length || !followers) return 0

  const avgLikes = posts.reduce((sum, p) => sum + (p.likes || 0), 0) / posts.length
  const avgComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0) / posts.length

  return parseFloat(
    (((avgLikes + avgComments) / followers) * 100).toFixed(2)
  )
}

/**
 * Build the scrapedSummary object that ARIA expects
 * Contains aggregate statistics for archetype detection
 */
const buildScrapedSummary = (rawData) => {
  const posts = rawData.posts || []

  if (!posts.length) {
    return {
      totalPostsAnalyzed: 0,
      postTypeMix: 'No posts found',
      avgLikes: 0,
      avgComments: 0,
      postsPerWeek: 0,
      avgCaptionLength: 0,
      topHashtags: [],
      bestPostType: 'unknown',
      worstPostType: 'unknown',
      followerCount: rawData.followers || 0,
    }
  }

  const reels = posts.filter(p => p.type === 'reel' || p.type === 'video')
  const photos = posts.filter(p => p.type === 'photo')

  const totalLikes = posts.reduce((sum, p) => sum + (p.likes || 0), 0)
  const totalComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0)

  const avgLikes = Math.round(totalLikes / posts.length)
  const avgComments = Math.round(totalComments / posts.length)

  const reelPercentage = Math.round((reels.length / posts.length) * 100)
  const photoPercentage = Math.round((photos.length / posts.length) * 100)

  const avgCaptionLength = Math.round(
    posts.reduce((sum, p) => sum + (p.caption?.length || 0), 0) / posts.length
  )

  const bestPostType = reels.length >= photos.length ? 'reel' : 'photo'
  const worstPostType = reels.length >= photos.length ? 'photo' : 'reel'

  return {
    totalPostsAnalyzed: posts.length,
    postTypeMix: `${reelPercentage}% reels, ${photoPercentage}% photos`,
    avgLikes,
    avgComments,
    postsPerWeek: rawData.postsPerWeek || 0,
    avgCaptionLength,
    topHashtags: rawData.topHashtags?.slice(0, 10) || [],
    bestPostType,
    worstPostType,
    followerCount: rawData.followers || 0,
  }
}

/**
 * Scrape Instagram profile and save to database
 * Called by scrape.worker.js
 *
 * Returns: { followers, engagement_rate, scraped_summary }
 * Throws: Error if scraping fails (worker will log and continue)
 */
const scrapeAndSaveProfile = async (userId, handle, platform) => {
  try {
    // Validate inputs
    if (!userId || !handle) {
      throw new Error('userId and handle are required')
    }

    if (platform !== 'instagram' && platform !== 'youtube') {
      throw new Error(`Platform ${platform} not supported yet. Only instagram and youtube.`)
    }

    // Only Instagram supported for now
    if (platform !== 'instagram') {
      throw new Error(`${platform} scraping not implemented yet`)
    }

    logger.info({ userId, handle, platform }, 'Starting profile scrape')

    // Check if Python is available
    try {
      await execFileAsync('which', ['python3'])
    } catch {
      throw new Error(
        'Python 3 not found. Install Python 3 and instaloader: pip install instaloader'
      )
    }

    // Run Python scraper with a strict timeout
    const scriptPath = path.join(__dirname, '../..', 'scripts/scrape_instagram.py')
    
    let child;
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      child = execFile('python3', [scriptPath, handle], {
        timeout: 45000, // 45s timeout
        maxBuffer: 10 * 1024 * 1024,
        killSignal: 'SIGKILL', // Be aggressive with killing hung processes
      }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed) reject(new Error(`Scraper timed out after 45s for handle: ${handle}`))
          else reject(err)
          return
        }
        resolve({ stdout, stderr })
      })
    })

    if (stderr && !stdout) {
      throw new Error(stderr)
    }

    // Parse output
    let scrapedData
    try {
      scrapedData = JSON.parse(stdout)
    } catch (err) {
      logger.error({ err, stdout, stderr }, 'Failed to parse scraper output')
      throw new Error('Invalid scraper output')
    }

    // Check for errors in output
    if (scrapedData.error) {
      if (scrapedData.isPrivate) {
        throw new Error('Could not analyze this profile. Make sure it is public and try again.')
      }
      throw new Error(scrapedData.error)
    }

    // Compute summary and engagement
    const scrapedSummary = buildScrapedSummary(scrapedData)
    const engagementRate = computeEngagementRate(
      scrapedData.posts,
      scrapedData.followers
    )

    // Save to database
    const sql = getDB()
    await sql`
      UPDATE users SET
        scraped_summary = ${JSON.stringify(scrapedSummary)},
        scraped_at = NOW(),
        engagement_rate = ${engagementRate},
        instagram_handle = ${handle},
        aria_analyzed_at = NOW()
      WHERE id = ${userId}
    `

    // Invalidate user cache
    await cache.del(CacheKeys.dashboard(userId))

    logger.info(
      { userId, followers: scrapedData.followers, engagement_rate: engagementRate },
      'Profile scraped and saved'
    )

    return {
      followers: scrapedData.followers,
      engagement_rate: engagementRate,
      scraped_summary: scrapedSummary,
    }
  } catch (err) {
    logger.error({ err, userId, handle }, 'Profile scrape failed')
    throw err
  }
}

module.exports = { scrapeAndSaveProfile, buildScrapedSummary, computeEngagementRate }
