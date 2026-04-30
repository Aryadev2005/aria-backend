import { FastifyRequest, FastifyReply } from 'fastify'
import { verifyFirebaseToken } from '../config/firebase'
import { cache } from '../config/redis'
import { prisma } from '../config/database'
import { errors } from '../utils/response'
import { logger } from '../utils/logger'
import { User } from '../types'

export const authenticateFirebase = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return errors.unauthorized(reply, 'Missing Bearer token')
    }

    const idToken = authHeader.slice(7)
    const cacheKey = `fb:${idToken.slice(-20)}`
    const cachedUser = await cache.get(cacheKey) as User | null

    if (cachedUser) {
      req.user = cachedUser
      return
    }

    const firebaseUser = await verifyFirebaseToken(idToken)

    let user = await prisma.users.findUnique({
      where: { firebase_uid: firebaseUser.uid },
      select: {
        id: true, firebase_uid: true, email: true, name: true, photo_url: true,
        follower_range: true, primary_platform: true, niches: true,
        is_pro: true, subscription_tier: true, created_at: true
      }
    }) as User | null

    if (!user) {
      user = await prisma.users.create({
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
      }) as User
      logger.info({ userId: user.id }, 'New user created')
    }

    req.user = user
    await cache.set(cacheKey, user, 300)

  } catch (err: any) {
    logger.error({ err }, 'Auth middleware error')
    return errors.unauthorized(reply, 'Invalid or expired token')
  }
}

export const requirePro = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user?.is_pro) {
    return errors.forbidden(reply,
      'This feature requires Pro subscription — ₹499/month')
  }
}

export const requireAgency = async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.user?.subscription_tier !== 'agency') {
    return errors.forbidden(reply, 'Agency subscription required')
  }
}

export const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) return
    await authenticateFirebase(req, reply)
  } catch (_) {}
}
