// src/services/aria_sessions.service.ts
// CRUD operations for ARIA chat sessions.
// Messages live in aria_chat_sessions; this service manages the sessions index.

import { prisma } from "../config/database";
import { logger } from "../utils/logger";

const MAX_TITLE_LEN = 60;
const MAX_PREVIEW_LEN = 120;

/** Trim and clean text for preview/title */
const trim = (s: string, max: number) =>
  s.replace(/\s+/g, " ").trim().slice(0, max);

// ── Session CRUD ──────────────────────────────────────────────────────────────

export const createSession = async (userId: string, sessionId: string) => {
  return prisma.aria_sessions.create({
    data: { user_id: userId, session_id: sessionId },
  });
};

export const upsertSession = async (
  userId: string,
  sessionId: string,
  opts: { title?: string; preview?: string; incrMessages?: boolean } = {},
) => {
  const data: any = { updated_at: new Date() };
  if (opts.title) data.title = trim(opts.title, MAX_TITLE_LEN);
  if (opts.preview !== undefined) data.preview = trim(opts.preview, MAX_PREVIEW_LEN);

  return prisma.aria_sessions.upsert({
    where: { session_id: sessionId },
    create: {
      user_id: userId,
      session_id: sessionId,
      title: opts.title ? trim(opts.title, MAX_TITLE_LEN) : "New Chat",
      preview: opts.preview ? trim(opts.preview, MAX_PREVIEW_LEN) : null,
      message_count: opts.incrMessages ? 1 : 0,
    },
    update: {
      ...data,
      ...(opts.incrMessages && {
        message_count: { increment: 1 },
      }),
    },
  });
};

export const listSessions = async (userId: string, limit = 30) => {
  return prisma.aria_sessions.findMany({
    where: { user_id: userId },
    orderBy: { updated_at: "desc" },
    take: limit,
    select: {
      id: true,
      session_id: true,
      title: true,
      preview: true,
      message_count: true,
      created_at: true,
      updated_at: true,
    },
  });
};

export const getSession = async (userId: string, sessionId: string) => {
  return prisma.aria_sessions.findFirst({
    where: { user_id: userId, session_id: sessionId },
  });
};

export const deleteSession = async (userId: string, sessionId: string) => {
  // Delete messages first, then session metadata
  await prisma.aria_chat_sessions.deleteMany({
    where: { user_id: userId, session_id: sessionId },
  });
  return prisma.aria_sessions.deleteMany({
    where: { user_id: userId, session_id: sessionId },
  });
};

export const renameSession = async (
  userId: string,
  sessionId: string,
  title: string,
) => {
  return prisma.aria_sessions.updateMany({
    where: { user_id: userId, session_id: sessionId },
    data: { title: trim(title, MAX_TITLE_LEN), updated_at: new Date() },
  });
};

// ── Message persistence ───────────────────────────────────────────────────────

export const saveMessage = async (
  userId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  toolCalls?: any[],
) => {
  await prisma.aria_chat_sessions.create({
    data: {
      user_id: userId,
      session_id: sessionId,
      role,
      content,
      tool_calls: toolCalls ?? [],
    },
  });

  // Update session preview + message count
  const update: any = { incrMessages: true };
  if (role === "assistant") update.preview = content;

  await upsertSession(userId, sessionId, update).catch((err) =>
    logger.warn({ err }, "Failed to update session metadata"),
  );
};

export const getMessages = async (userId: string, sessionId: string) => {
  return prisma.aria_chat_sessions.findMany({
    where: { user_id: userId, session_id: sessionId },
    orderBy: { created_at: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      tool_calls: true,
      created_at: true,
    },
  });
};

/** Auto-generate a session title from the first user message */
export const autogenerateTitle = (firstUserMessage: string): string => {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  return cleaned.length <= MAX_TITLE_LEN
    ? cleaned
    : cleaned.slice(0, MAX_TITLE_LEN - 1) + "…";
};
