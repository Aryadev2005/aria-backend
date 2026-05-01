import { FastifyInstance } from "fastify";
import * as userController from "../controllers/user.controller";
import type {
  UpdateProfileBody,
  OnboardingBody,
  SubscriptionBody,
} from "../controllers/user.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { prisma } from "../config/database";
import { success } from "../utils/response";
export default async function userRoutes(app: FastifyInstance) {
  app.get(
    "/profile",
    {
      preHandler: [authenticateFirebase],
    },
    userController.getProfile,
  );

  app.get(
    "/me",
    {
      preHandler: [authenticateFirebase],
    },
    async (req, reply) => {
      const user = (req as any).user;
      const full = await prisma.users.findUnique({ where: { id: user.id } });
      return success(reply, { user: full });
    }
  );

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
          required: ["followerRange", "primaryPlatform", "niches"],
          properties: {
            followerRange: { type: "string" },
            primaryPlatform: { type: "string" },
            niches: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
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
}
