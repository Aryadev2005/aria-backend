import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

// ── GET /api/v1/notes ─────────────────────────────────────────────────────────
export const getNotes = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { source, search, limit = "50", offset = "0" } = req.query as any;

  try {
    const where: any = { user_id: user.id };
    if (source && source !== "all") where.source = source;
    if (search?.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: "insensitive" } },
        { content: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const notes = await (prisma as any).creator_notes.findMany({
      where,
      orderBy: [{ is_pinned: "desc" }, { updated_at: "desc" }],
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    return success(reply, { notes });
  } catch (err: any) {
    logger.error({ err: err.message }, "getNotes failed");
    return errors.internal(reply);
  }
};

// ── POST /api/v1/notes ────────────────────────────────────────────────────────
export const createNote = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { title, content, source = "manual", source_meta = {}, tags = [] } =
    req.body as any;

  if (!content?.trim() && !title?.trim()) {
    return errors.validation(reply, "title or content is required");
  }

  try {
    const note = await (prisma as any).creator_notes.create({
      data: {
        user_id: user.id,
        title: title?.trim() ?? "",
        content: content?.trim() ?? "",
        source,
        source_meta,
        tags,
        updated_at: new Date(),
      },
    });
    return success(reply, { note });
  } catch (err: any) {
    logger.error({ err: err.message }, "createNote failed");
    return errors.internal(reply);
  }
};

// ── PATCH /api/v1/notes/:id ───────────────────────────────────────────────────
export const updateNote = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { id } = req.params as any;
  const { title, content, tags, is_pinned } = req.body as any;

  try {
    const existing = await (prisma as any).creator_notes.findFirst({
      where: { id, user_id: user.id },
    });
    if (!existing) return errors.notFound(reply, "Note");

    const note = await (prisma as any).creator_notes.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(content !== undefined && { content: content.trim() }),
        ...(tags !== undefined && { tags }),
        ...(is_pinned !== undefined && { is_pinned }),
        updated_at: new Date(),
      },
    });
    return success(reply, { note });
  } catch (err: any) {
    logger.error({ err: err.message }, "updateNote failed");
    return errors.internal(reply);
  }
};

// ── DELETE /api/v1/notes/:id ──────────────────────────────────────────────────
export const deleteNote = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { id } = req.params as any;

  try {
    const deleted = await (prisma as any).creator_notes.deleteMany({
      where: { id, user_id: user.id },
    });
    if (deleted.count === 0) return errors.notFound(reply, "Note");
    return success(reply, { deleted: true });
  } catch (err: any) {
    logger.error({ err: err.message }, "deleteNote failed");
    return errors.internal(reply);
  }
};

// ── POST /api/v1/notes/:id/pin ────────────────────────────────────────────────
export const togglePin = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { id } = req.params as any;

  try {
    const existing = await (prisma as any).creator_notes.findFirst({
      where: { id, user_id: user.id },
    });
    if (!existing) return errors.notFound(reply, "Note");

    const note = await (prisma as any).creator_notes.update({
      where: { id },
      data: { is_pinned: !existing.is_pinned, updated_at: new Date() },
    });
    return success(reply, { note });
  } catch (err: any) {
    logger.error({ err: err.message }, "togglePin failed");
    return errors.internal(reply);
  }
};
