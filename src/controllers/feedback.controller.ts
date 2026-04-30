import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

interface FeedbackBody {
  recommendationType: string;
  recommendationData: any;
  wasHelpful: boolean;
  resultNotes?: string;
}

/**
 * POST /api/v1/trends/feedback
 * Submit feedback on ARIA recommendations
 */
export const submitFeedback = async (
  req: FastifyRequest<{ Body: FeedbackBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { recommendationType, recommendationData, wasHelpful, resultNotes } =
    req.body;

  try {
    if (!recommendationType) {
      return errors.error(
        reply,
        "recommendationType is required",
        400,
        "VALIDATION_ERROR",
      );
    }

    await prisma.aria_feedback.create({
      data: {
        user_id: user.id,
        recommendation_type: recommendationType,
        recommendation_data: recommendationData || {},
        was_helpful: wasHelpful === true,
        result_notes: resultNotes || null,
        created_at: new Date(),
      },
    });

    logger.info(
      { userId: user.id, recommendationType, wasHelpful },
      "Feedback recorded",
    );

    return success(reply, {
      message: "Feedback received. ARIA is learning from you!",
      feedbackId: user.id,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Submit feedback failed");
    return errors.internal(reply);
  }
};

/**
 * Get recent feedback for a user
 */
export const getRecentFeedbackForUser = async (userId: string) => {
  try {
    const feedback = await prisma.aria_feedback.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 5,
      select: {
        recommendation_type: true,
        was_helpful: true,
        result_notes: true,
        created_at: true,
      },
    });

    return feedback.map((f) => ({
      type: f.recommendation_type,
      helpful: f.was_helpful,
      notes: f.result_notes,
      date: f.created_at,
    }));
  } catch (err) {
    logger.error({ err, userId }, "Get recent feedback failed");
    return [];
  }
};
