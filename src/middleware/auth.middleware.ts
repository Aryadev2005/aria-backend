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
        // ── Identity ──────────────────────────────────────────────────────
        id: true, firebase_uid: true, email: true, name: true, photo_url: true,
        instagram_handle: true, youtube_handle: true,
        // ── Subscription / permissions ────────────────────────────────────
        is_pro: true, subscription_tier: true,
        subscription_product_id: true, subscription_expires_at: true,
        subscription_store: true,
        // ── Creator profile (needed by ARIA prompt + tools) ───────────────
        primary_platform: true, platform: true, niches: true,
        follower_range: true, engagement_rate: true, health_score: true,
        archetype: true, archetype_label: true, archetype_confidence: true,
        growth_stage: true, tone_profile: true, creator_intent: true,
        aria_confirmed_niche: true, onboarding_step: true,
        // ── Deep analysis data (critical for profile analysis responses) ──
        scraped_summary: true, scraped_at: true,
        aria_last_analysis: true, aria_analyzed_at: true,
        // ── Timestamps ────────────────────────────────────────────────────
        created_at: true, updated_at: true,
      }
    }) as User | null

    if (!user) {
      const emailNorm = (firebaseUser.email as string)?.trim().toLowerCase()
      user = await prisma.users.create({
        data: {
          firebase_uid: firebaseUser.uid,
          email: emailNorm,
          name:
            (firebaseUser.name as string)?.trim() ||
            emailNorm.split('@')[0] ||
            'Creator',
          photo_url: firebaseUser.picture || null
        },
        select: {
          id: true, firebase_uid: true, email: true, name: true, photo_url: true,
          instagram_handle: true, youtube_handle: true,
          is_pro: true, subscription_tier: true,
          subscription_product_id: true, subscription_expires_at: true,
          subscription_store: true,
          primary_platform: true, platform: true, niches: true,
          follower_range: true, engagement_rate: true, health_score: true,
          archetype: true, archetype_label: true, archetype_confidence: true,
          growth_stage: true, tone_profile: true, creator_intent: true,
          aria_confirmed_niche: true, onboarding_step: true,
          scraped_summary: true, scraped_at: true,
          aria_last_analysis: true, aria_analyzed_at: true,
          created_at: true, updated_at: true,
        }
      }) as User
      logger.info({ userId: user.id }, 'New user created')
    }

    req.user = user
    // 60s TTL — short enough that profile analysis updates appear quickly,
    // long enough to avoid hammering the DB on every streaming token request.
    await cache.set(cacheKey, user, 60)

  } catch (err: any) {
    logger.error({ 
      err: err.message, 
      stack: err.stack,
      token_preview: req.headers.authorization?.slice(0, 20) 
    }, 'Auth middleware error');
    
    // Distinguish between expired and actually invalid for better frontend debugging
    const isExpired = err.message?.toLowerCase().includes('expired');
    return errors.unauthorized(
      reply, 
      isExpired ? 'Token expired' : 'Invalid or expired token'
    );
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
