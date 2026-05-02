import { FastifyRequest, FastifyReply } from "fastify";
import { cache, CacheKeys, TTL } from "../config/redis";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { verifyFirebaseToken } from "../config/firebase";

interface FirebaseLoginBody {
  idToken: string;
  fcmToken?: string;
  platform?: string;
  name?: string; // passed during registration
  phone?: string; // passed during registration
}

/**
 * POST /api/v1/auth/firebase
 * Exchange Firebase ID token for a backend session.
 * Creates user in DB if new. Returns isNewUser flag so frontend knows
 * whether to redirect to onboarding or dashboard.
 */
export const firebaseLogin = async (
  req: FastifyRequest<{ Body: FirebaseLoginBody }>,
  reply: FastifyReply,
) => {
  try {
    const { idToken, fcmToken, platform, name, phone } = req.body;

    const firebaseUser = await verifyFirebaseToken(idToken);

    // Try to find existing user
    let user = await prisma.users.findUnique({
      where: { firebase_uid: firebaseUser.uid },
      select: {
        id: true,
        firebase_uid: true,
        email: true,
        name: true,
        photo_url: true,
        phone: true,
        follower_range: true,
        primary_platform: true,
        niches: true,
        is_pro: true,
        subscription_tier: true,
        created_at: true,
        instagram_handle: true,
        youtube_handle: true,
        onboarding_step: true,
        archetype: true,
        archetype_label: true,
        growth_stage: true,
        health_score: true,
        engagement_rate: true,
      },
    });

    const isNewUser = !user;

    const normalizedEmail = (firebaseUser.email as string)?.trim().toLowerCase();
    const normalizedPhone =
      typeof phone === "string" ? phone.replace(/\D/g, "") || null : null;

    if (!user) {
      // Create new user record (email normalized for uniqueness consistency)
      user = await prisma.users.create({
        data: {
          firebase_uid: firebaseUser.uid,
          email: normalizedEmail,
          name:
            (name?.trim() as string) ||
            (firebaseUser.name as string) ||
            normalizedEmail.split("@")[0],
          photo_url: firebaseUser.picture || null,
          phone: normalizedPhone,
          onboarding_step: "new",
        },
        select: {
          id: true,
          firebase_uid: true,
          email: true,
          name: true,
          photo_url: true,
          phone: true,
          follower_range: true,
          primary_platform: true,
          niches: true,
          is_pro: true,
          subscription_tier: true,
          created_at: true,
          instagram_handle: true,
          youtube_handle: true,
          onboarding_step: true,
          archetype: true,
          archetype_label: true,
          growth_stage: true,
          health_score: true,
          engagement_rate: true,
        },
      });
      logger.info({ userId: user.id, email: user.email }, "New user created");
    } else {
      const patch: Record<string, unknown> = {};
      const trimmedName = name?.trim();
      if (trimmedName && (!user.name || !String(user.name).trim()))
        patch.name = trimmedName;
      if (normalizedPhone && !user.phone) patch.phone = normalizedPhone;
      if (
        normalizedEmail &&
        user.email?.toLowerCase() !== normalizedEmail
      ) {
        patch.email = normalizedEmail;
      }
      if (Object.keys(patch).length > 0) {
        await prisma.users.update({
          where: { id: user.id },
          data: { ...patch, updated_at: new Date() },
        });
        if (patch.name) user.name = patch.name as string;
        if (patch.phone) user.phone = patch.phone as string;
        if (patch.email) user.email = patch.email as string;
      }
    }

    // Update FCM token for push notifications if provided
    if (fcmToken) {
      await prisma.users
        .update({
          where: { id: user.id },
          data: {
            fcm_token: fcmToken,
            platform: platform || null,
            updated_at: new Date(),
          },
        })
        .catch(() => {}); // Non-fatal
    }

    // Cache user for fast subsequent requests
    await cache.set(CacheKeys.user(user.id), user, TTL.USER);

    return success(reply, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        photoUrl: user.photo_url,
        phone: user.phone,
        followerRange: user.follower_range,
        primaryPlatform: user.primary_platform,
        niches: user.niches,
        isPro: user.is_pro,
        subscriptionTier: user.subscription_tier,
        instagramHandle: user.instagram_handle,
        youtubeHandle: user.youtube_handle,
        onboardingStep: user.onboarding_step,
        archetype: user.archetype,
        archetypeLabel: user.archetype_label,
        growthStage: user.growth_stage,
        healthScore: user.health_score,
        engagementRate: user.engagement_rate,
      },
      isNewUser,
    });
  } catch (err) {
    logger.error({ err }, "Firebase login failed");
    return errors.internal(reply);
  }
};

/**
 * POST /api/v1/auth/update-profile
 * Update user name and phone after registration step.
 * Called immediately after Firebase account creation.
 */
export const updateRegistrationProfile = async (
  req: FastifyRequest<{ Body: { name: string; phone: string } }>,
  reply: FastifyReply,
) => {
  const user = (req as any).user;
  const { name, phone } = req.body;

  try {
    if (!name?.trim()) return errors.badRequest(reply, "Name is required");

    const updated = await prisma.users.update({
      where: { id: user.id },
      data: {
        name: name.trim(),
        phone: phone?.replace(/\D/g, "") || null,
        updated_at: new Date(),
      },
      select: { id: true, name: true, phone: true },
    });

    await cache.del(CacheKeys.user(user.id));
    return success(reply, updated);
  } catch (err) {
    logger.error({ err }, "Profile update failed");
    return errors.internal(reply);
  }
};

/**
 * GET /api/v1/auth/check-email
 * Check if an email is already registered.
 * Used by SignIn page to block new users from sign-in flow.
 * Does NOT require auth.
 */
export const checkEmail = async (
  req: FastifyRequest<{ Querystring: { email: string } }>,
  reply: FastifyReply,
) => {
  const { email } = req.query;
  if (!email) return errors.badRequest(reply, "Email is required");

  try {
    const user = await prisma.users.findFirst({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });
    return success(reply, { exists: !!user });
  } catch (err) {
    logger.error({ err }, "Email check failed");
    return errors.internal(reply);
  }
};

/**
 * POST /api/v1/auth/logout
 */
export const logout = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const user = (req as any).user;
    if (user?.id) {
      await cache.del(CacheKeys.user(user.id));
      await prisma.users
        .update({
          where: { id: user.id },
          data: { fcm_token: null, updated_at: new Date() },
        })
        .catch(() => {});
    }
    return success(reply, { loggedOut: true });
  } catch (err) {
    logger.error({ err }, "Logout failed");
    return errors.internal(reply);
  }
};
