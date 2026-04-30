import { FastifyRequest, FastifyReply } from 'fastify'
import { cache, CacheKeys } from '../config/redis'
import { prisma } from '../config/database'
import { success, errors } from '../utils/response'
import { logger } from '../utils/logger'

/**
 * Handle Firebase login and update user session/FCM token
 */
export const firebaseLogin = async (req: FastifyRequest<{ Body: { fcmToken?: string, platform?: string } }>, reply: FastifyReply) => {
  try {
    const { fcmToken, platform } = req.body
    const user = req.user as any

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
        photoUrl:        user.photoUrl,
        followerRange:   user.followerRange,
        primaryPlatform: user.primaryPlatform,
        niches:          user.niches,
        isPro:           user.isPro,
        subscriptionTier: user.subscriptionTier,
      },
      isNewUser: !user.primaryPlatform,
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
