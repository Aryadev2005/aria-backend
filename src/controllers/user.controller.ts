import { FastifyRequest, FastifyReply } from 'fastify'
import { cache, CacheKeys, TTL } from '../config/redis'
import { prisma } from '../config/database'
import { success, errors } from '../utils/response'
import { logger } from '../utils/logger'

/**
 * Get current user profile from cache or DB
 */
export const getProfile = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = req.user as any
    const cached = await cache.get(CacheKeys.user(user.id))
    if (cached) return success(reply, cached)

    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        id: true, email: true, name: true, photo_url: true, bio: true,
        follower_range: true, primary_platform: true, niches: true,
        instagram_handle: true, youtube_handle: true,
        is_pro: true, subscription_tier: true, created_at: true
      }
    })
    
    if (!dbUser) return errors.notFound(reply, 'User')

    await cache.set(CacheKeys.user(dbUser.id), dbUser, TTL.USER)
    return success(reply, dbUser)
  } catch (err) {
    logger.error({ err }, 'Get profile failed')
    return errors.internal(reply)
  }
}

export interface UpdateProfileBody {
  name?: string;
  instagramHandle?: string;
  youtubeHandle?: string;
  bio?: string;
  fcmToken?: string;
}

/**
 * Update user profile details
 */
export const updateProfile = async (req: FastifyRequest<{ Body: UpdateProfileBody }>, reply: FastifyReply) => {
  try {
    const user = req.user as any
    const { name, instagramHandle, youtubeHandle, bio, fcmToken } = req.body

    const updated = await (prisma.users as any).update({
      where: { id: user.id },
      data: {
        ...(name !== undefined && { name }),
        ...(instagramHandle !== undefined && { instagram_handle: instagramHandle }),
        ...(youtubeHandle !== undefined && { youtube_handle: youtubeHandle }),
        ...(bio !== undefined && { bio }),
        ...(fcmToken !== undefined && { fcm_token: fcmToken }),
        updated_at: new Date()
      },
      select: {
        id: true, email: true, name: true, photo_url: true, bio: true,
        follower_range: true, primary_platform: true, niches: true,
        instagram_handle: true, youtube_handle: true, is_pro: true
      }
    })

    await cache.del(CacheKeys.user(user.id))
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Update profile failed')
    return errors.internal(reply)
  }
}

export interface OnboardingBody {
  followerRange: string;
  primaryPlatform: string;
  niches: string[];
}

/**
 * Mark onboarding as complete and save initial preferences
 */
export const completeOnboarding = async (req: FastifyRequest<{ Body: Partial<OnboardingBody> }>, reply: FastifyReply) => {
  try {
    const user = req.user as any
    const { followerRange, primaryPlatform, niches } = req.body

    const updated = await (prisma.users as any).update({
      where: { id: user.id },
      data: {
        ...(followerRange !== undefined && { follower_range: followerRange }),
        ...(primaryPlatform !== undefined && { primary_platform: primaryPlatform }),
        ...(niches !== undefined && { niches: niches }),
        updated_at: new Date()
      },
      select: {
        id: true, email: true, name: true, follower_range: true,
        primary_platform: true, niches: true, is_pro: true
      }
    })

    await cache.del(CacheKeys.user(user.id))
    logger.info({ userId: user.id }, 'Onboarding updated')
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Onboarding failed')
    return errors.internal(reply)
  }
}

/**
 * Get performance statistics for the user
 */
export const getStats = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = req.user as any
    const cacheKey = CacheKeys.userStats(user.id)
    const cached = await cache.get(cacheKey)
    if (cached) return success(reply, cached)

    // Mock stats — replace with real Instagram API data later
    const stats = {
      followers:     24500,
      following:     892,
      posts:         147,
      engagement:    4.8,
      avgLikes:      1180,
      avgComments:   42,
      avgSaves:      89,
      reach:         45000,
      impressions:   78000,
      profileVisits: 3400,
      growth:        '+2.4% this week',
      bestDay:       'Wednesday',
      bestTime:      '7:00 PM IST',
    }

    await cache.set(cacheKey, stats, 300)
    return success(reply, stats)
  } catch (err) {
    logger.error({ err }, 'Get stats failed')
    return errors.internal(reply)
  }
}

export interface SubscriptionBody {
  tier: string;
  receiptData?: string;
  platform: string;
}

/**
 * Update user subscription status
 */
export const updateSubscription = async (req: FastifyRequest<{ Body: SubscriptionBody }>, reply: FastifyReply) => {
  try {
    const user = req.user as any
    const { tier, platform } = req.body

    const updated = await (prisma.users as any).update({
      where: { id: user.id },
      data: {
        subscription_tier: tier,
        is_pro: tier !== 'free',
        subscription_store: platform === 'ios' ? 'APP_STORE' : 'PLAY_STORE',
        updated_at: new Date()
      },
      select: {
        id: true, subscription_tier: true, is_pro: true, subscription_store: true
      }
    })

    await cache.del(CacheKeys.user(user.id))
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Subscription update failed')
    return errors.internal(reply)
  }
}
