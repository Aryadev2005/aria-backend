import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS aria_sessions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id    TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL DEFAULT 'New Chat',
      preview       TEXT,
      message_count INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_aria_sessions_user ON aria_sessions(user_id, updated_at DESC)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_aria_sessions_sid ON aria_sessions(session_id)`);
  console.log('aria_sessions table created OK');
} finally {
  await prisma.$disconnect();
}
