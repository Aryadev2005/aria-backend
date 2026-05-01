-- CreateTable
CREATE TABLE "analytics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "event" TEXT NOT NULL,
    "platform" TEXT,
    "niche" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aria_chat_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" JSONB,
    "tool_result" JSONB,
    "entry_screen" TEXT,
    "context_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aria_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aria_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "recommendation_type" TEXT NOT NULL,
    "recommendation_data" JSONB NOT NULL,
    "was_helpful" BOOLEAN,
    "result_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aria_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aria_memory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" INTEGER DEFAULT 50,
    "source" TEXT DEFAULT 'inferred',
    "times_seen" INTEGER DEFAULT 1,
    "last_seen_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aria_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aria_suggestions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "session_id" TEXT,
    "suggestion_type" TEXT NOT NULL,
    "suggestion_data" JSONB NOT NULL,
    "status" TEXT DEFAULT 'pending',
    "result_data" JSONB,
    "follow_up_sent" BOOLEAN DEFAULT false,
    "follow_up_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aria_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoint_blobs" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "blob" BYTEA,

    CONSTRAINT "checkpoint_blobs_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","channel","version")
);

-- CreateTable
CREATE TABLE "checkpoint_migrations" (
    "v" INTEGER NOT NULL,

    CONSTRAINT "checkpoint_migrations_pkey" PRIMARY KEY ("v")
);

-- CreateTable
CREATE TABLE "checkpoint_writes" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "checkpoint_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT,
    "blob" BYTEA NOT NULL,

    CONSTRAINT "checkpoint_writes_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id","task_id","idx")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "checkpoint_id" TEXT NOT NULL,
    "parent_checkpoint_id" TEXT,
    "type" TEXT,
    "checkpoint" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id")
);

-- CreateTable
CREATE TABLE "content_calendars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "month" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "calendar_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "trend_title" TEXT,
    "platform" TEXT,
    "niche" TEXT,
    "hook" TEXT,
    "caption" TEXT,
    "hashtags" JSONB DEFAULT '[]',
    "best_time_to_post" TEXT,
    "content_format" TEXT,
    "thumbnail_text" TEXT,
    "cta" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "idea" TEXT,
    "platform" TEXT,
    "niche" TEXT,
    "script_structure" JSONB,
    "bgm_suggestions" JSONB,
    "shot_list" JSONB,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "studio_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "package_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "launch_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_songs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "chart_position" INTEGER,
    "chart_change" INTEGER,
    "streams_today" BIGINT,
    "language" TEXT,
    "raw_data" JSONB,
    "fetched_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_songs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_trends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "search_volume" INTEGER,
    "velocity" DECIMAL(5,2),
    "niche_tags" TEXT[],
    "platform_tags" TEXT[],
    "raw_data" JSONB,
    "fetched_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "badge" TEXT,
    "recommendation" TEXT,

    CONSTRAINT "live_trends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radar_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "niche" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "intelligence_data" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) DEFAULT (now() + '06:00:00'::interval),

    CONSTRAINT "radar_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "rate_data" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_trends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "trend_id" TEXT NOT NULL,
    "saved_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_trends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "firebase_uid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "photo_url" TEXT,
    "bio" TEXT,
    "instagram_handle" TEXT,
    "youtube_handle" TEXT,
    "fcm_token" TEXT,
    "platform" TEXT,
    "follower_range" TEXT,
    "primary_platform" TEXT,
    "niches" JSONB DEFAULT '[]',
    "is_pro" BOOLEAN DEFAULT false,
    "subscription_tier" TEXT DEFAULT 'free',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "archetype" TEXT,
    "archetype_label" TEXT,
    "archetype_confidence" INTEGER,
    "growth_stage" TEXT DEFAULT 'DISCOVERY',
    "tone_profile" TEXT,
    "health_score" INTEGER,
    "onboarding_step" TEXT,
    "follower_count" INTEGER,
    "scraped_summary" JSONB,
    "scraped_at" TIMESTAMPTZ(6),
    "engagement_rate" DECIMAL(5,2),
    "creator_intent" TEXT DEFAULT 'grow_organically',
    "aria_last_analysis" JSONB,
    "aria_analyzed_at" TIMESTAMPTZ(6),
    "subscription_product_id" TEXT,
    "subscription_expires_at" TIMESTAMPTZ(6),
    "subscription_store" TEXT,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "deletion_confirmation_code" TEXT,
    "deletion_source" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_connections" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "platform_user_id" TEXT,
    "handle" TEXT,
    "encrypted_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[],
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_analytics_event" ON "analytics"("event");

-- CreateIndex
CREATE INDEX "idx_analytics_user_id" ON "analytics"("user_id");

-- CreateIndex
CREATE INDEX "idx_chat_sessions_created" ON "aria_chat_sessions"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_chat_sessions_user" ON "aria_chat_sessions"("user_id", "session_id");

-- CreateIndex
CREATE INDEX "idx_aria_feedback_user" ON "aria_feedback"("user_id");

-- CreateIndex
CREATE INDEX "idx_aria_memory_confidence" ON "aria_memory"("user_id", "confidence" DESC);

-- CreateIndex
CREATE INDEX "idx_aria_memory_user" ON "aria_memory"("user_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "aria_memory_user_id_category_key_key" ON "aria_memory"("user_id", "category", "key");

-- CreateIndex
CREATE INDEX "idx_suggestions_followup" ON "aria_suggestions"("follow_up_at") WHERE ((follow_up_sent = false) AND (status = 'pending'::text));

-- CreateIndex
CREATE INDEX "idx_suggestions_user" ON "aria_suggestions"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_calendars_user" ON "content_calendars"("user_id");

-- CreateIndex
CREATE INDEX "idx_calendars_user_month" ON "content_calendars"("user_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "content_calendars_user_id_month_year_key" ON "content_calendars"("user_id", "month", "year");

-- CreateIndex
CREATE INDEX "idx_content_history_created_at" ON "content_history"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_content_history_user_id" ON "content_history"("user_id");

-- CreateIndex
CREATE INDEX "idx_studio_sessions_user" ON "studio_sessions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_launch_packages_user" ON "launch_packages"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_live_trends_badge" ON "live_trends"("badge");

-- CreateIndex
CREATE INDEX "idx_live_trends_expires" ON "live_trends"("expires_at");

-- CreateIndex
CREATE INDEX "idx_live_trends_niche" ON "live_trends" USING GIN ("niche_tags");

-- CreateIndex
CREATE INDEX "idx_live_trends_platform" ON "live_trends" USING GIN ("platform_tags");

-- CreateIndex
CREATE INDEX "idx_radar_expires" ON "radar_snapshots"("expires_at");

-- CreateIndex
CREATE INDEX "idx_radar_niche_platform" ON "radar_snapshots"("niche", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_user_id_key" ON "rate_cards"("user_id");

-- CreateIndex
CREATE INDEX "idx_rate_cards_user" ON "rate_cards"("user_id");

-- CreateIndex
CREATE INDEX "idx_saved_trends_user_id" ON "saved_trends"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_trends_user_id_trend_id_key" ON "saved_trends"("user_id", "trend_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_archetype" ON "users"("archetype");

-- CreateIndex
CREATE INDEX "idx_users_firebase_uid" ON "users"("firebase_uid");

-- CreateIndex
CREATE INDEX "idx_users_deletion_code" ON "users"("deletion_confirmation_code") WHERE (deletion_confirmation_code IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_users_deletion_pending" ON "users"("deletion_requested_at") WHERE (deletion_requested_at IS NOT NULL AND deleted_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "account_connections_user_id_platform_key" ON "account_connections"("user_id", "platform");

-- AddForeignKey
ALTER TABLE "analytics" ADD CONSTRAINT "analytics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "aria_chat_sessions" ADD CONSTRAINT "aria_chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "aria_feedback" ADD CONSTRAINT "aria_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "aria_memory" ADD CONSTRAINT "aria_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "aria_suggestions" ADD CONSTRAINT "aria_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "content_calendars" ADD CONSTRAINT "content_calendars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "content_history" ADD CONSTRAINT "content_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "launch_packages" ADD CONSTRAINT "launch_packages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saved_trends" ADD CONSTRAINT "saved_trends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "account_connections" ADD CONSTRAINT "account_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
