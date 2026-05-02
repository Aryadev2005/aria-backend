import { FastifyInstance } from "fastify";
import * as userController from "../controllers/user.controller";
import type {
  UpdateProfileBody,
  OnboardingBody,
  SubscriptionBody,
} from "../controllers/user.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
export default async function userRoutes(app: FastifyInstance) {
  app.get(
    "/profile",
    {
      preHandler: [authenticateFirebase],
    },
    userController.getProfile,
  );

  app.get('/me', { preHandler: [authenticateFirebase] }, async (req, reply) => {
    const user = (req as any).user;
    try {
      const dbUser = await (prisma.users as any).findUnique({
        where: { id: user.id },
        select: {
          id: true, email: true, name: true, photo_url: true, phone: true,
          follower_range: true, primary_platform: true, niches: true,
          instagram_handle: true, youtube_handle: true,
          is_pro: true, subscription_tier: true,
          archetype: true, archetype_label: true, aria_last_analysis: true,
          onboarding_step: true, growth_stage: true, health_score: true,
          engagement_rate: true, aria_analyzed_at: true,
        }
      });
      if (!dbUser) return errors.notFound(reply, 'User');
      return success(reply, dbUser);
    } catch (err) {
      return errors.internal(reply);
    }
  });

  app.put<{ Body: UpdateProfileBody }>(
    "/profile",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2, maxLength: 100 },
            instagramHandle: { type: "string" },
            youtubeHandle: { type: "string" },
            bio: { type: "string", maxLength: 500 },
            fcmToken: { type: "string" },
          },
        },
      },
    },
    userController.updateProfile,
  );

  app.put<{ Body: OnboardingBody }>(
    "/onboarding",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["followerRange"],
          properties: {
            followerRange: { type: "string" },
            primaryPlatform: { type: "string" },
            niches: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
            },
          },
        },
      },
    },
    userController.completeOnboarding,
  );

  app.get(
    "/stats",
    {
      preHandler: [authenticateFirebase],
    },
    userController.getStats,
  );

  app.put<{ Body: SubscriptionBody }>(
    "/subscription",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["tier"],
          properties: {
            tier: { type: "string", enum: ["free", "pro", "brand", "agency"] },
            receiptData: { type: "string" },
            platform: { type: "string", enum: ["ios", "android"] },
          },
        },
      },
    },
    userController.updateSubscription,
  );

  // PUT /api/v1/users/confirm-niche
  app.put('/confirm-niche', { preHandler: [authenticateFirebase] }, async (req, reply) => {
    const user = (req as any).user;
    await (prisma.users as any).update({
      where: { id: user.id },
      data: { onboarding_step: 'confirmed' },
    });
    return success(reply, { confirmed: true });
  });
}
