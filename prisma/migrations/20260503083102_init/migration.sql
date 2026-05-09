-- CreateTable
CREATE TABLE "aria_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "preview" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aria_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aria_sessions_session_id_key" ON "aria_sessions"("session_id");

-- CreateIndex
CREATE INDEX "idx_aria_sessions_user" ON "aria_sessions"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_aria_sessions_sid" ON "aria_sessions"("session_id");

-- AddForeignKey
ALTER TABLE "aria_sessions" ADD CONSTRAINT "aria_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
