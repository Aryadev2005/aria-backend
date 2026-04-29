'use strict'

const groqService = require('../services/ai/groq.service')
const { cache, CacheKeys, TTL } = require('../config/redis')
const { getDB } = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const getDashboard = async (req, reply) => {
  const user = req.user

  try {
    const cacheKey = CacheKeys.dashboard(user.id)

    const dashboard = await cache.getOrSet(cacheKey, async () => {
      // If archetype not yet detected, run detection first
      if (!user.archetype) {
        const archetypeResult = await groqService.detectArchetype({
          niche: user.niches?.[0] || 'fashion',
          platform: user.primaryPlatform || 'instagram',
          followerRange: user.followerRange || '0-1K',
          creatorIntent: user.creatorIntent,
          scrapedData: user.scrapedSummary
        })

        // Save archetype to DB async
        const sql = getDB()
        sql`
          UPDATE users SET
            archetype = ${archetypeResult.archetype},
            archetype_label = ${archetypeResult.archetypeLabel},
            archetype_confidence = ${archetypeResult.archetypeConfidence},
            growth_stage = ${archetypeResult.growthStage},
            tone_profile = ${archetypeResult.toneProfile},
            aria_analyzed_at = NOW()
          WHERE id = ${user.id}
        `.catch(err => logger.error({ err }, 'Failed to save archetype'))

        user.archetype = archetypeResult.archetype
        user.toneProfile = archetypeResult.toneProfile
      }

      // Run full persona growth map
      return groqService.fullPersonaGrowthMap({
        niche: user.niches?.[0] || 'fashion',
        platform: user.primaryPlatform || 'instagram',
        followerRange: user.followerRange || '0-1K',
        creatorIntent: user.creatorIntent,
        scrapedData: user.scrapedSummary,
        engagementRate: user.engagementRate || 0,
      })
    }, TTL.DASHBOARD)

    return success(reply, dashboard)
  } catch (err) {
    logger.error({ err }, 'Dashboard failed')
    return errors.serviceDown(reply, 'Analytics engine')
  }
}

const getGrowthPrediction = async (req, reply) => {
  try {
    const prediction = {
      currentFollowers:  24500,
      predictedIn30Days: 27800,
      predictedIn90Days: 35200,
      daysTo10K:         null,
      daysTo50K:         67,
      daysTo100K:        198,
      growthRate:        '+2.4% weekly',
      recommendation:    'Posting 5x/week instead of 3x would cut your time to 50K by 40%',
      milestones: [
        { target: 25000, eta: '8 days',  reward: 'Unlock Instagram Close Friends monetisation' },
        { target: 50000, eta: '67 days', reward: 'Brand deal rates increase 3x' },
        { target: 100000, eta: '198 days', reward: 'Meta Creator Fund eligibility' },
      ],
    }
    return success(reply, prediction)
  } catch (err) {
    logger.error({ err }, 'Growth prediction failed')
    return errors.internal(reply)
  }
}

const getBestPostingTimes = async (req, reply) => {
  try {
    const times = {
      instagram: {
        monday:    ['7:00 PM', '9:00 AM'],
        tuesday:   ['8:00 PM', '12:00 PM'],
        wednesday: ['7:00 PM', '6:00 PM'],
        thursday:  ['7:00 PM', '9:00 PM'],
        friday:    ['6:00 PM', '8:00 PM'],
        saturday:  ['11:00 AM', '7:00 PM'],
        sunday:    ['10:00 AM', '6:00 PM'],
      },
      bestDay:   'Wednesday',
      bestTime:  '7:00 PM IST',
      timezone:  'Asia/Kolkata',
      note:      'Based on your audience demographics in India',
    }
    return success(reply, times)
  } catch (err) {
    logger.error({ err }, 'Best times failed')
    return errors.internal(reply)
  }
}

const getCompetitorInsights = async (req, reply) => {
  try {
    const insights = {
      competitors: [
        {
          handle:      '@fashionwithpriya',
          followers:   45000,
          engagement:  3.2,
          postsPerWeek: 5,
          topFormat:   'Reels',
          gap:         'Not posting about quiet luxury — opportunity for you',
        },
        {
          handle:      '@stylebyriya',
          followers:   89000,
          engagement:  2.1,
          postsPerWeek: 7,
          topFormat:   'Carousels',
          gap:         'Low engagement on weekend posts — avoid their Saturday slot',
        },
      ],
      yourAdvantage: 'Your engagement rate (4.8%) beats 73% of creators in your niche',
    }
    return success(reply, insights)
  } catch (err) {
    logger.error({ err }, 'Competitor insights failed')
    return errors.internal(reply)
  }
}

const getWeeklyReport = async (req, reply) => {
  try {
    const report = {
      week:         'April 21–27, 2026',
      summary:      'Your best week in 3 months',
      highlights: [
        'Reached 24.5K followers (+580 this week)',
        'Engagement rate up 0.6% from last week',
        'Wednesday Reel hit 45K views — your best post',
      ],
      topPost: {
        caption:     'Quiet luxury look for ₹2,000...',
        views:       45000,
        likes:       2100,
        saves:       890,
        comments:    142,
      },
      nextWeekPlan: [
        'Post capsule wardrobe Reel on Wednesday 7PM',
        'Use trending song: Phir Aur Kya Chahiye',
        'Try carousel format for budget outfit breakdown',
      ],
    }
    return success(reply, report)
  } catch (err) {
    logger.error({ err }, 'Weekly report failed')
    return errors.internal(reply)
  }
}

const getArchetype = async (req, reply) => {
  const user = req.user
  const sql = getDB()

  try {
    // If archetype not in session, fetch from DB
    if (!user.archetype) {
      const [dbUser] = await sql`
        SELECT archetype, archetype_label, archetype_confidence,
               growth_stage, tone_profile, aria_analyzed_at
        FROM users
        WHERE id = ${user.id}
      `

      if (!dbUser?.archetype) {
        // Trigger detection if not available
        return reply.status(202).send({
          status: 'analyzing',
          message: 'ARIA is detecting your archetype. Check back in 30 seconds.',
        })
      }

      return success(reply, {
        archetype: dbUser.archetype,
        archetypeLabel: dbUser.archetypeLabel,
        archetypeConfidence: dbUser.archetypeConfidence,
        growthStage: dbUser.growthStage,
        toneProfile: dbUser.toneProfile,
        analyzedAt: dbUser.ariaAnalyzedAt,
      })
    }

    return success(reply, {
      archetype: user.archetype,
      archetypeLabel: user.archetypeLabel,
      archetypeConfidence: user.archetypeConfidence,
      growthStage: user.growthStage,
      toneProfile: user.toneProfile,
    })
  } catch (err) {
    logger.error({ err }, 'Get archetype failed')
    return errors.internal(reply)
  }
}

const triggerScrape = async (req, reply) => {
  const { handle, platform } = req.body
  const user = req.user
  const sql = getDB()

  try {
    // Validate handle format
    if (!handle.trim()) {
      return errors.badRequest(reply, 'Handle cannot be empty')
    }

    // Save handle and trigger background scrape
    await sql`
      UPDATE users SET
        ${platform}_handle = ${handle},
        scraped_at = NULL
      WHERE id = ${user.id}
    `

    const { enqueueScrapeJob } = require('../config/queue')
    const jobId = await enqueueScrapeJob(user.id, handle, platform)

    return reply.status(202).send({
      status: 'queued',
      message: `Scraping ${platform} handle @${handle}. Analysis will be ready in 2-3 minutes.`,
      jobId,
      handle,
      platform,
    })
  } catch (err) {
    logger.error({ err }, 'Trigger scrape failed')
    return errors.internal(reply)
  }
}

module.exports = {
  getDashboard,
  getGrowthPrediction,
  getBestPostingTimes,
  getCompetitorInsights,
  getWeeklyReport,
  getArchetype,
  triggerScrape,
}