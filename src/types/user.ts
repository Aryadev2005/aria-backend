export interface User {
  id: string;
  firebase_uid: string;
  email: string;
  name: string;
  photo_url?: string | null;
  bio?: string | null;
  instagram_handle?: string | null;
  youtube_handle?: string | null;
  fcm_token?: string | null;
  platform?: string | null;
  follower_range?: string | null;
  primary_platform?: string | null;
  niches?: string[] | any; // Json in prisma
  is_pro?: boolean | null;
  subscription_tier?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  archetype?: string | null;
  archetype_label?: string | null;
  archetype_confidence?: number | null;
  growth_stage?: string | null;
  tone_profile?: string | null;
  health_score?: number | null;
  scraped_summary?: any;
  scraped_at?: Date | null;
  engagement_rate?: number | any; // Decimal in prisma
  creator_intent?: string | null;
  aria_last_analysis?: any;
  aria_analyzed_at?: Date | null;
  subscription_product_id?: string | null;
  subscription_expires_at?: Date | null;
  subscription_store?: string | null;
}
