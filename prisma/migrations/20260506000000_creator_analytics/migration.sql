-- CreateTable: stores the full ARIA analytics report per user
CREATE TABLE "creator_analytics" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"               UUID NOT NULL,
  "platform"              TEXT NOT NULL DEFAULT 'instagram',
  "handle"                TEXT NOT NULL,

  -- Raw numbers
  "followers"             INTEGER NOT NULL DEFAULT 0,
  "following"             INTEGER NOT NULL DEFAULT 0,
  "total_posts"           INTEGER NOT NULL DEFAULT 0,
  "avg_likes"             DECIMAL(10,2) NOT NULL DEFAULT 0,
  "avg_comments"          DECIMAL(10,2) NOT NULL DEFAULT 0,
  "avg_views"             DECIMAL(10,2) NOT NULL DEFAULT 0,
  "engagement_rate"       DECIMAL(5,2) NOT NULL DEFAULT 0,
  "posts_per_week"        DECIMAL(5,2) NOT NULL DEFAULT 0,
  "reel_count"            INTEGER NOT NULL DEFAULT 0,
  "photo_count"           INTEGER NOT NULL DEFAULT 0,
  "carousel_count"        INTEGER NOT NULL DEFAULT 0,

  -- Computed scores (0–100)
  "health_score"          INTEGER NOT NULL DEFAULT 0,
  "engagement_score"      INTEGER NOT NULL DEFAULT 0,
  "consistency_score"     INTEGER NOT NULL DEFAULT 0,
  "growth_score"          INTEGER NOT NULL DEFAULT 0,
  "monetisation_score"    INTEGER NOT NULL DEFAULT 0,

  -- Rich JSON blobs
  "top_posts"             JSONB NOT NULL DEFAULT '[]',
  "top_hashtags"          JSONB NOT NULL DEFAULT '[]',
  "format_breakdown"      JSONB NOT NULL DEFAULT '{}',
  "best_posting_times"    JSONB NOT NULL DEFAULT '[]',
  "niche_benchmarks"      JSONB NOT NULL DEFAULT '{}',
  "growth_projection"     JSONB NOT NULL DEFAULT '{}',
  "monetisation"          JSONB NOT NULL DEFAULT '{}',

  -- ARIA narrative (the killer differentiator)
  "aria_diagnosis"        TEXT,
  "aria_top_insights"     JSONB NOT NULL DEFAULT '[]',
  "aria_action_items"     JSONB NOT NULL DEFAULT '[]',
  "aria_content_gaps"     JSONB NOT NULL DEFAULT '[]',

  -- Meta
  "scraped_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "analysis_version"      INTEGER NOT NULL DEFAULT 1,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "creator_analytics_pkey" PRIMARY KEY ("id")
);

-- One active analytics row per user per platform
CREATE UNIQUE INDEX "creator_analytics_user_platform_key"
  ON "creator_analytics"("user_id", "platform");

CREATE INDEX "idx_creator_analytics_user"
  ON "creator_analytics"("user_id");

ALTER TABLE "creator_analytics"
  ADD CONSTRAINT "creator_analytics_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
