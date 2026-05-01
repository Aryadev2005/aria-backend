import { FastifyRequest, FastifyReply } from 'fastify'
import { cache, CacheKeys } from '../config/redis'
import { prisma } from '../config/database'
import { success, errors } from '../utils/response'
import { logger } from '../utils/logger'

/**
 * Handle Firebase login and update user session/FCM token
 */
export const firebaseLogin = async (req: FastifyRequest<{ Body: { idToken: string, fcmToken?: string, platform?: string } }>, reply: FastifyReply) => {
  try {
    const { idToken, fcmToken, platform } = req.body
    
    // Import verifyFirebaseToken here to avoid circular dependency
    const { verifyFirebaseToken } = require('../config/firebase')
    const firebaseUser = await verifyFirebaseToken(idToken)

    let user = await (prisma.users as any).findUnique({
      where: { firebase_uid: firebaseUser.uid },
      select: {
        id: true, firebase_uid: true, email: true, name: true, photo_url: true,
        follower_range: true, primary_platform: true, niches: true,
        is_pro: true, subscription_tier: true, created_at: true
      }
    })

    if (!user) {
      user = await (prisma.users as any).create({
        data: {
          firebase_uid: firebaseUser.uid,
          email: firebaseUser.email as string,
          name: firebaseUser.name as string,
          photo_url: firebaseUser.picture || null
        },
        select: {
          id: true, firebase_uid: true, email: true, name: true, photo_url: true,
          follower_range: true, primary_platform: true, niches: true,
          is_pro: true, subscription_tier: true, created_at: true
        }
      })
      logger.info({ userId: user.id }, 'New user created')
    }

    // Cache the user so future requests with this token are fast
    const cacheKey = `fb:${idToken.slice(-20)}`
    await cache.set(cacheKey, user, 300)

    // Update FCM token for push notifications
    if (fcmToken) {
      await (prisma.users as any).update({
        where: { id: user.id },
        data: {
          fcm_token: fcmToken,
          platform: platform,
          updated_at: new Date()
        }
      }).catch(() => {})
    }

    return success(reply, {
      user: {
        id:              user.id,
        email:           user.email,
        name:            user.name,
        photoUrl:        user.photo_url,
        followerRange:   user.follower_range,
        primaryPlatform: user.primary_platform,
        niches:          user.niches,
        isPro:           user.is_pro,
        subscriptionTier: user.subscription_tier,
      },
      isNewUser: !user.primary_platform,
    })
  } catch (err) {
    logger.error({ err }, 'Firebase login failed')
    return errors.internal(reply)
  }
}

/**
 * Handle user logout
 */
export const logout = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = req.user as any
    // Clear user cache
    await cache.del(CacheKeys.user(user.id))

    // Clear FCM token
    await (prisma.users as any).update({
      where: { id: user.id },
      data: { fcm_token: null }
    }).catch(() => {})

    return success(reply, { loggedOut: true })
  } catch (err) {
    logger.error({ err }, 'Logout failed')
    return errors.internal(reply)
  }
}

/**
 * Get current user profile
 */
export const getMe = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as any
  return success(reply, {
    id:              user.id,
    email:           user.email,
    name:            user.name,
    photoUrl:        user.photoUrl,
    followerRange:   user.followerRange,
    primaryPlatform: user.primaryPlatform,
    niches:          user.niches,
    isPro:           user.isPro,
    subscriptionTier: user.subscriptionTier,
    createdAt:       user.createdAt,
  })
}

/**
 * Delete user account
 */
export const deleteAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = req.user as any
    await (prisma.users as any).delete({
      where: { id: user.id }
    })
    await cache.del(CacheKeys.user(user.id))
    return success(reply, { deleted: true })
  } catch (err) {
    logger.error({ err }, 'Delete account failed')
    return errors.internal(reply)
  }
}
