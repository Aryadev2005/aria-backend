-- CreateTable creator_voice_profiles
CREATE TABLE IF NOT EXISTS "creator_voice_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "voice_data" JSONB NOT NULL DEFAULT '{}',
    "posts_analysed" INTEGER NOT NULL DEFAULT 0,
    "confidence" DECIMAL(4,2) DEFAULT 0.5,
    "built_at" TIMESTAMPTZ DEFAULT NOW(),
    "next_rebuild_at" TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',

    CONSTRAINT "creator_voice_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "creator_voice_profiles_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "creator_voice_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

-- CreateIndex
CREATE INDEX "idx_voice_profiles_user" ON "creator_voice_profiles"("user_id");

-- CreateIndex
CREATE INDEX "idx_voice_profiles_rebuild" ON "creator_voice_profiles"("next_rebuild_at");
