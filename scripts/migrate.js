'use strict'

require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

const migrate = async () => {
  const client = await pool.connect()
  console.log('Running migrations...')

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        firebase_uid      TEXT UNIQUE NOT NULL,
        email             TEXT UNIQUE NOT NULL,
        name              TEXT NOT NULL,
        photo_url         TEXT,
        bio               TEXT,
        instagram_handle  TEXT,
        youtube_handle    TEXT,
        fcm_token         TEXT,
        platform          TEXT,
        follower_range    TEXT,
        primary_platform  TEXT,
        niches            JSONB DEFAULT '[]',
        is_pro            BOOLEAN DEFAULT FALSE,
        subscription_tier TEXT DEFAULT 'free',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('✅ users table created')

    await client.query(`
      CREATE TABLE IF NOT EXISTS content_history (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
        trend_title       TEXT,
        platform          TEXT,
        niche             TEXT,
        hook              TEXT,
        caption           TEXT,
        hashtags          JSONB DEFAULT '[]',
        best_time_to_post TEXT,
        content_format    TEXT,
        thumbnail_text    TEXT,
        cta               TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('✅ content_history table created')

    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_trends (
        id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
        trend_id  TEXT NOT NULL,
        saved_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, trend_id)
      )
    `)
    console.log('✅ saved_trends table created')

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        event      TEXT NOT NULL,
        platform   TEXT,
        niche      TEXT,
        metadata   JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('✅ analytics table created')

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_history_user_id
        ON content_history(user_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_history_created_at
        ON content_history(created_at DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_saved_trends_user_id
        ON saved_trends(user_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_user_id
        ON analytics(user_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_event
        ON analytics(event)
    `)
    console.log('✅ Indexes created')

    console.log('\n🚀 All migrations complete!')

  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()