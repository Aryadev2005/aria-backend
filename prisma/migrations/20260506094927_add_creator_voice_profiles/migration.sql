/*
  Warnings:

  - You are about to drop the column `embedding` on the `trend_embeddings` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[title,source]` on the table `live_trends` will be added. If there are existing duplicate values, this will fail.
  - Made the column `confidence` on table `creator_voice_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `built_at` on table `creator_voice_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `next_rebuild_at` on table `creator_voice_profiles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `geo` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `interest_score` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `breakout` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `trend_date` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `scraped_at` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `expires_at` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `raw_data` on table `discovery_google_trends_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `saves` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `clicks` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `engagement_rate` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `pin_type` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `scraped_at` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `expires_at` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `raw_data` on table `discovery_pinterest_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `creator_followers` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `views` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `likes` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `comments` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `shares` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `saves` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `engagement_rate` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `duration` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `scraped_at` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `expires_at` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.
  - Made the column `raw_data` on table `discovery_tiktok_raw` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "creator_voice_profiles" DROP CONSTRAINT "creator_voice_profiles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "graph_edges" DROP CONSTRAINT "graph_edges_source_id_fkey";

-- DropForeignKey
ALTER TABLE "graph_edges" DROP CONSTRAINT "graph_edges_target_id_fkey";

-- DropForeignKey
ALTER TABLE "trend_embeddings" DROP CONSTRAINT "trend_embeddings_trend_id_fkey";

-- DropIndex
DROP INDEX "idx_gtrends_geo";

-- DropIndex
DROP INDEX "idx_pinterest_raw_hashtags";

-- DropIndex
DROP INDEX "idx_tiktok_raw_hashtags";

-- DropIndex
DROP INDEX "idx_tiktok_raw_sound";

-- DropIndex
DROP INDEX "idx_trend_embeddings_vector";

-- AlterTable
ALTER TABLE "creator_voice_profiles" ALTER COLUMN "confidence" SET NOT NULL,
ALTER COLUMN "built_at" SET NOT NULL,
ALTER COLUMN "next_rebuild_at" SET NOT NULL,
ALTER COLUMN "next_rebuild_at" SET DEFAULT NOW() + INTERVAL '7 days';

-- AlterTable
ALTER TABLE "discovery_google_trends_raw" ALTER COLUMN "geo" SET NOT NULL,
ALTER COLUMN "interest_score" SET NOT NULL,
ALTER COLUMN "breakout" SET NOT NULL,
ALTER COLUMN "trend_date" SET NOT NULL,
ALTER COLUMN "scraped_at" SET NOT NULL,
ALTER COLUMN "expires_at" SET NOT NULL,
ALTER COLUMN "expires_at" DROP DEFAULT,
ALTER COLUMN "raw_data" SET NOT NULL;

-- AlterTable
ALTER TABLE "discovery_pinterest_raw" ALTER COLUMN "saves" SET NOT NULL,
ALTER COLUMN "clicks" SET NOT NULL,
ALTER COLUMN "engagement_rate" SET NOT NULL,
ALTER COLUMN "pin_type" SET NOT NULL,
ALTER COLUMN "scraped_at" SET NOT NULL,
ALTER COLUMN "expires_at" SET NOT NULL,
ALTER COLUMN "expires_at" DROP DEFAULT,
ALTER COLUMN "raw_data" SET NOT NULL;

-- AlterTable
ALTER TABLE "discovery_tiktok_raw" ALTER COLUMN "creator_followers" SET NOT NULL,
ALTER COLUMN "views" SET NOT NULL,
ALTER COLUMN "likes" SET NOT NULL,
ALTER COLUMN "comments" SET NOT NULL,
ALTER COLUMN "shares" SET NOT NULL,
ALTER COLUMN "saves" SET NOT NULL,
ALTER COLUMN "engagement_rate" SET NOT NULL,
ALTER COLUMN "duration" SET NOT NULL,
ALTER COLUMN "scraped_at" SET NOT NULL,
ALTER COLUMN "expires_at" SET NOT NULL,
ALTER COLUMN "expires_at" DROP DEFAULT,
ALTER COLUMN "raw_data" SET NOT NULL;

-- AlterTable
ALTER TABLE "live_songs" ADD COLUMN     "expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "growth" TEXT DEFAULT 'stable',
ADD COLUMN     "lifecycle" TEXT DEFAULT 'RISING',
ADD COLUMN     "mood_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "niche_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "peak_rank" INTEGER,
ADD COLUMN     "rank_history" JSONB DEFAULT '[]',
ADD COLUMN     "signal" TEXT DEFAULT 'postNow';

-- AlterTable
ALTER TABLE "trend_embeddings" DROP COLUMN "embedding";

-- CreateTable
CREATE TABLE "song_hot_window" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cache_key" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "song_hot_window_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "song_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "song_id" UUID NOT NULL,
    "embed_text" TEXT NOT NULL,
    "language" TEXT,
    "niche_tags" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "song_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "song_trajectories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "song_title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'unknown',
    "lifecycle" TEXT NOT NULL DEFAULT 'RISING',
    "rank_history" JSONB NOT NULL DEFAULT '[]',
    "peak_rank" INTEGER,
    "peak_at" TIMESTAMPTZ(6),
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DECIMAL(4,2) NOT NULL DEFAULT 0.5,
    "niche_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "song_trajectories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_reddit_raw" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "upvote_ratio" DECIMAL(4,2) NOT NULL DEFAULT 0.0,
    "num_comments" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT,
    "author" TEXT,
    "flair" TEXT,
    "age_hours" DECIMAL(6,2) NOT NULL DEFAULT 0.0,
    "velocity" INTEGER NOT NULL DEFAULT 0,
    "is_breakout" BOOLEAN NOT NULL DEFAULT false,
    "feed" TEXT,
    "scraped_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "raw_data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "discovery_reddit_raw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "song_hot_window_cache_key_key" ON "song_hot_window"("cache_key");

-- CreateIndex
CREATE INDEX "idx_song_hot_window_key" ON "song_hot_window"("cache_key");

-- CreateIndex
CREATE INDEX "idx_song_hot_window_expires" ON "song_hot_window"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "song_embeddings_song_id_key" ON "song_embeddings"("song_id");

-- CreateIndex
CREATE INDEX "idx_song_embeddings_lang" ON "song_embeddings"("language");

-- CreateIndex
CREATE INDEX "idx_song_embeddings_updated" ON "song_embeddings"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_song_traj_lang_lifecycle" ON "song_trajectories"("language", "lifecycle");

-- CreateIndex
CREATE INDEX "idx_song_traj_updated" ON "song_trajectories"("updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "song_trajectories_song_title_language_key" ON "song_trajectories"("song_title", "language");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_reddit_raw_post_id_key" ON "discovery_reddit_raw"("post_id");

-- CreateIndex
CREATE INDEX "discovery_reddit_raw_velocity_idx" ON "discovery_reddit_raw"("velocity" DESC);

-- CreateIndex
CREATE INDEX "discovery_reddit_raw_scraped_at_idx" ON "discovery_reddit_raw"("scraped_at" DESC);

-- CreateIndex
CREATE INDEX "discovery_reddit_raw_expires_at_idx" ON "discovery_reddit_raw"("expires_at");

-- CreateIndex
CREATE INDEX "discovery_reddit_raw_subreddit_idx" ON "discovery_reddit_raw"("subreddit");

-- CreateIndex
CREATE INDEX "idx_live_songs_lang_lifecycle" ON "live_songs"("language", "lifecycle");

-- CreateIndex
CREATE INDEX "idx_live_songs_expires" ON "live_songs"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "live_trends_title_source_key" ON "live_trends"("title", "source");

-- AddForeignKey
ALTER TABLE "trend_embeddings" ADD CONSTRAINT "trend_embeddings_trend_id_fkey" FOREIGN KEY ("trend_id") REFERENCES "live_trends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_voice_profiles" ADD CONSTRAINT "creator_voice_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_voice_profiles_rebuild" RENAME TO "creator_voice_profiles_next_rebuild_at_idx";

-- RenameIndex
ALTER INDEX "idx_voice_profiles_user" RENAME TO "creator_voice_profiles_user_id_idx";

-- RenameIndex
ALTER INDEX "idx_gtrends_breakout" RENAME TO "discovery_google_trends_raw_breakout_idx";

-- RenameIndex
ALTER INDEX "idx_gtrends_expires" RENAME TO "discovery_google_trends_raw_expires_at_idx";

-- RenameIndex
ALTER INDEX "idx_gtrends_interest" RENAME TO "discovery_google_trends_raw_interest_score_idx";

-- RenameIndex
ALTER INDEX "idx_gtrends_scraped" RENAME TO "discovery_google_trends_raw_scraped_at_idx";

-- RenameIndex
ALTER INDEX "uq_google_trends_keyword_geo_date" RENAME TO "discovery_google_trends_raw_keyword_geo_trend_date_key";

-- RenameIndex
ALTER INDEX "idx_pinterest_raw_engagement" RENAME TO "discovery_pinterest_raw_engagement_rate_idx";

-- RenameIndex
ALTER INDEX "idx_pinterest_raw_expires" RENAME TO "discovery_pinterest_raw_expires_at_idx";

-- RenameIndex
ALTER INDEX "idx_pinterest_raw_saves" RENAME TO "discovery_pinterest_raw_saves_idx";

-- RenameIndex
ALTER INDEX "idx_pinterest_raw_scraped" RENAME TO "discovery_pinterest_raw_scraped_at_idx";

-- RenameIndex
ALTER INDEX "idx_tiktok_raw_engagement" RENAME TO "discovery_tiktok_raw_engagement_rate_idx";

-- RenameIndex
ALTER INDEX "idx_tiktok_raw_expires" RENAME TO "discovery_tiktok_raw_expires_at_idx";

-- RenameIndex
ALTER INDEX "idx_tiktok_raw_scraped" RENAME TO "discovery_tiktok_raw_scraped_at_idx";

-- RenameIndex
ALTER INDEX "idx_tiktok_raw_views" RENAME TO "discovery_tiktok_raw_views_idx";

-- RenameIndex
ALTER INDEX "uq_graph_edges" RENAME TO "graph_edges_source_id_target_id_edge_type_key";

-- RenameIndex
ALTER INDEX "uq_graph_nodes_type_label" RENAME TO "graph_nodes_node_type_label_key";

-- RenameIndex
ALTER INDEX "uq_trend_embeddings_trend" RENAME TO "trend_embeddings_trend_id_key";

-- RenameIndex
ALTER INDEX "uq_trend_trajectories_title_niche" RENAME TO "trend_trajectories_trend_title_niche_key";
