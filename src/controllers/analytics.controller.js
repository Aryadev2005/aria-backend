'use strict'

const { cache, CacheKeys, TTL } = require('../config/redis')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const getDashboard = async (req, reply) => {
  try {
    const cacheKey = CacheKeys.dashboard(req.user.id)
    const cached = await cache.get(cacheKey)
    if (cached) return success(reply, cached)

    const dashboard = {
      stats: {
        followers:   24500,
        engagement:  4.8,
        postsPerMonth: 12,
        reach:       45000,
        growth:      '+2.4%',
      },
      aiRecommendation: {
        text:        '"Quiet Luxury" Reels are getting 3.2x more engagement this week',
        bestTime:    'Today 7–9 PM IST',
        confidence:  92,
      },
      weeklyScore: {
        consistency: 'Good',
        trendAlignment: 'Medium',
        postingTime:  'Excellent',
        overall:      78,
      },
      contentMix: {
        reels:     60,
        carousels: 25,
        stories:   15,
      },
    }

    await cache.set(cacheKey, dashboard, TTL.DASHBOARD)
    return success(reply, dashboard)
  } catch (err) {
    logger.error({ err }, 'Dashboard failed')
    return errors.internal(reply)
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

module.exports = {
  getDashboard,
  getGrowthPrediction,
  getBestPostingTimes,
  getCompetitorInsights,
  getWeeklyReport,
}