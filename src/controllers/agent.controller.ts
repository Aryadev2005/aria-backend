import { FastifyRequest, FastifyReply } from "fastify";
import * as brain from "../services/ariaBrain.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { prisma } from "../config/database";
import { User } from "../types";

export interface SendMessageBody {
  message: string;
  sessionId?: string;
  history?: any[];
}

// POST /api/v1/agent/message
export const sendMessage = async (
  req: FastifyRequest<{ Body: SendMessageBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { message, sessionId, history = [] } = req.body;

  if (!message?.trim()) return errors.notFound(reply, "Message");

  try {
    const result = await brain.think({
      userId: user.id,
      user,
      message: message.trim(),
      sessionId,
      history,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Agent message failed");
    return errors.serviceDown(reply, "ARIA");
  }
};

// GET /api/v1/agent/memory
export const getMemory = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const memory = await brain.getMemory(user.id);
    return success(reply, { memory, count: Object.keys(memory).length });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Get memory failed");
    return errors.internal(reply);
  }
};

// DELETE /api/v1/agent/memory/:key
export const deleteMemory = async (
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { key } = req.params;
  try {
    await prisma.aria_memory.deleteMany({
      where: {
        user_id: user.id,
        key,
      },
    });
    return success(reply, { deleted: true });
  } catch (err) {
    logger.error({ err, userId: user.id, key }, "Delete memory failed");
    return errors.internal(reply);
  }
};
