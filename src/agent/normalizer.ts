// src/agent/normalizer.ts
// All raw API responses pass through here before reaching the LLM.
// Goal: strip everything the AI doesn't need, keep only signal.
// This is the token efficiency layer.

// ── YouTube Video ─────────────────────────────────────────────────────────────
export const normalizeYouTubeVideo = (raw: any) => {
  if (!raw?.items?.[0]) return { error: 'video_not_found' }
  const v = raw.items[0]
  const s = v.statistics || {}
  const sn = v.snippet || {}
  const cd = v.contentDetails || {}

  const views    = parseInt(s.viewCount    || '0')
  const likes    = parseInt(s.likeCount    || '0')
  const comments = parseInt(s.commentCount || '0')
  const engRate  = views > 0 ? +((likes + comments) / views * 100).toFixed(2) : 0

  return {
    id:           v.id,
    title:        sn.title,
    channel:      sn.channelTitle,
    publishedAt:  sn.publishedAt?.slice(0, 10),
    duration:     _parseDuration(cd.duration),
    durationSecs: _durationToSecs(cd.duration),
    tags:         (sn.tags || []).slice(0, 10),
    description:  (sn.description || '').slice(0, 300),
    thumbnail:    sn.thumbnails?.high?.url,
    views,
    likes,
    comments,
    engRate,
    // Derived signals
    likeRatio:    views > 0 ? +((likes / views) * 100).toFixed(2) : 0,
    commentRatio: views > 0 ? +((comments / views) * 100).toFixed(3) : 0,
    isShort:      _durationToSecs(cd.duration) <= 60,
  }
}

// ── YouTube Channel ───────────────────────────────────────────────────────────
export const normalizeYouTubeChannel = (raw: any) => {
  if (!raw?.items?.[0]) return { error: 'channel_not_found' }
  const c  = raw.items[0]
  const s  = c.statistics || {}
  const sn = c.snippet || {}

  const subCount = parseInt(s.subscriberCount || '0')
  const viewCount = parseInt(s.viewCount || '0')
  const videoCount = parseInt(s.videoCount || '0')

  return {
    id:          c.id,
    name:        sn.title,
    description: (sn.description || '').slice(0, 200),
    country:     sn.country,
    subscribers: subCount,
    totalViews:  viewCount,
    videoCount:  videoCount,
    avgViewsPerVideo: videoCount > 0
      ? Math.round(viewCount / videoCount)
      : 0,
  }
}

// ── YouTube Search Results ────────────────────────────────────────────────────
export const normalizeYouTubeSearch = (raw: any) => {
  if (!raw?.items) return { results: [] }
  return {
    totalResults: raw.pageInfo?.totalResults,
    results: (raw.items as any[]).slice(0, 8).map(item => ({
      videoId:   item.id?.videoId,
      title:     item.snippet?.title,
      channel:   item.snippet?.channelTitle,
      published: item.snippet?.publishedAt?.slice(0, 10),
      thumbnail: item.snippet?.thumbnails?.medium?.url,
    })).filter(r => r.videoId),
  }
}

// ── Spotify Charts ────────────────────────────────────────────────────────────
export const normalizeSpotifyTracks = (rawTracks: any[]) => {
  if (!Array.isArray(rawTracks)) return { tracks: [] }
  return {
    tracks: rawTracks.slice(0, 20).map((t, i) => {
      const meta = t.trackMetadata || t
      const chartData = t.chartEntryData || {}
      return {
        rank:     chartData.currentRank || i + 1,
        title:    meta.trackName || meta.title,
        artist:   (meta.artists || []).map((a: any) => a.name || a).join(', '),
        streams:  chartData.rankingMetric?.value || 0,
        peakRank: chartData.peakRank || chartData.currentRank || i + 1,
        trend:    chartData.rankingMetric?.type || 'stable',
      }
    }).filter(t => t.title),
  }
}

// ── JioSaavn / Indian Music Charts ───────────────────────────────────────────
export const normalizeJioSaavnSongs = (rawSongs: any[]) => {
  if (!Array.isArray(rawSongs)) return { songs: [] }
  return {
    songs: rawSongs.slice(0, 15).map((s, i) => ({
      rank:     i + 1,
      title:    s.title || s.name,
      artist:   s.primaryArtists || s.artists?.map?.((a: any) => a.name)?.join(', ') || 'Unknown',
      language: s.language,
      duration: s.duration ? Math.round(s.duration / 1000) : null,
      playCount: s.playCount || null,
    })).filter(s => s.title),
  }
}

// ── Google Trends ─────────────────────────────────────────────────────────────
export const normalizeGoogleTrends = (rawTrends: any) => {
  if (!rawTrends) return { topics: [] }

  const items = Array.isArray(rawTrends)
    ? rawTrends
    : (rawTrends.default?.trendingSearchesDays?.[0]?.trendingSearches || [])

  return {
    topics: (items as any[]).slice(0, 15).map(t => ({
      title:         t.title?.query || t.title || t,
      traffic:       t.formattedTraffic || t.search_volume || 'N/A',
      relatedTopics: (t.relatedTopics || []).slice(0, 3).map((r: any) => r.topic?.title || r),
      articles:      (t.articles || []).slice(0, 1).map((a: any) => a.title),
    })),
  }
}

// ── pytrends Interest Data ────────────────────────────────────────────────────
export const normalizePytrends = (rawData: any) => {
  if (!rawData) return { keywords: [] }

  return {
    keywords: Object.entries(rawData).map(([keyword, series]) => {
      const values = Array.isArray(series) ? (series as any[]).map(p => p.value || p) : []
      const avg    = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0
      const recent = values.slice(-3)
      const trend  = recent.length >= 2
        ? (recent[recent.length - 1] > recent[0] ? 'rising' : 'falling')
        : 'stable'
      return {
        keyword,
        avgInterest: avg,
        peakInterest: Math.max(...values, 0),
        trend,
        lastValue: values[values.length - 1] || 0,
      }
    }),
  }
}

// ── Instagram (Graph API — own content only) ──────────────────────────────────
export const normalizeInstagramMedia = (rawMedia: any) => {
  if (!rawMedia?.data) return { posts: [] }
  return {
    posts: (rawMedia.data as any[]).slice(0, 20).map(post => ({
      id:           post.id,
      type:         post.media_type,
      timestamp:    post.timestamp?.slice(0, 10),
      caption:      (post.caption || '').slice(0, 150),
      likes:        post.like_count || 0,
      comments:     post.comments_count || 0,
      reach:        post.reach || null,
      saves:        post.saved || null,
      impressions:  post.impressions || null,
      engRate:      post.reach
        ? +(((post.like_count + post.comments_count) / post.reach) * 100).toFixed(2)
        : null,
      permalink:    post.permalink,
    })),
  }
}

// ── Instagram Account Insights ────────────────────────────────────────────────
export const normalizeInstagramInsights = (rawInsights: any) => {
  if (!rawInsights?.data) return {}
  const metrics: any = {}
  rawInsights.data.forEach((d: any) => {
    metrics[d.name] = d.values?.[0]?.value ?? d.value
  })
  return {
    reach:            metrics.reach,
    impressions:      metrics.impressions,
    profileViews:     metrics.profile_views,
    followerCount:    metrics.follower_count,
    websiteClicks:    metrics.website_clicks,
    emailContacts:    metrics.email_contacts,
  }
}

// ── Live DB Trends (your existing live_trends table) ─────────────────────────
export const normalizeDBTrends = (rows: any[]) => {
  if (!rows?.length) return { trends: [] }
  return {
    trends: rows.map(r => ({
      title:       r.title,
      badge:       r.badge,
      velocity:    r.velocity,
      searchVolume: r.search_volume,
      niche:       r.niche_tags,
      recommendation: r.recommendation,
    })),
  }
}

// ── User Profile (personal data from your DB) ─────────────────────────────────
export const normalizeUserProfile = (user: any) => {
  if (!user) return {}
  return {
    archetype:      user.archetype,
    archetypeLabel: user.archetype_label,
    niche:          user.niches?.[0] || 'general',
    allNiches:      user.niches,
    platform:       user.primary_platform,
    followerRange:  user.follower_range,
    engagementRate: user.engagement_rate,
    healthScore:    user.health_score,
    growthStage:    user.growth_stage,
    toneProfile:    user.tone_profile,
    hasInstagram:   !!user.has_instagram_connected,
    instagramHandle: user.instagram_handle || null,
    // Memory learnings (from aria_memory table)
    memory:         user.memory || {},
  }
}

// ── Live Songs (your existing live_songs table) ───────────────────────────────
export const normalizeDBSongs = (rows: any[]) => {
  if (!rows?.length) return { songs: [] }
  return {
    songs: rows.map(r => ({
      title:      r.title,
      artist:     r.artist,
      rank:       r.chart_position,
      language:   r.language,
      streams:    r.streams_today?.toString(), // BigInt to string
      source:     r.source,
    })),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const _parseDuration = (iso: string) => {
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return '—'
  const h = parseInt(m[1] || '0'), min = parseInt(m[2] || '0'), s = parseInt(m[3] || '0')
  return h > 0
    ? `${h}:${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${min}:${String(s).padStart(2,'0')}`
}

const _durationToSecs = (iso: string) => {
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return (parseInt(m[1]||'0')*3600) + (parseInt(m[2]||'0')*60) + parseInt(m[3]||'0')
}
