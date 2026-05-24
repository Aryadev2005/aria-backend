// src/config/geo.config.ts
// Global country list for trend scraping
// Covers top creator economy markets worldwide

export interface GeoTarget {
  code: string;    // ISO 3166-1 alpha-2
  name: string;
  hl:   string;    // language hint for Google Trends
  tz:   number;    // UTC offset in minutes (negative = behind UTC)
  tier: 'A' | 'B'; // A = every cycle, B = every other cycle
}

export const GEO_TARGETS: GeoTarget[] = [
  // Tier A — highest creator density markets
  { code: 'IN', name: 'India',          hl: 'en-IN', tz: -330, tier: 'A' },
  { code: 'US', name: 'United States',  hl: 'en-US', tz: 300,  tier: 'A' },
  { code: 'GB', name: 'United Kingdom', hl: 'en-GB', tz: 0,    tier: 'A' },
  { code: 'BR', name: 'Brazil',         hl: 'pt-BR', tz: 180,  tier: 'A' },
  { code: 'ID', name: 'Indonesia',      hl: 'id',    tz: -420, tier: 'A' },
  { code: 'PH', name: 'Philippines',    hl: 'en-PH', tz: -480, tier: 'A' },
  { code: 'NG', name: 'Nigeria',        hl: 'en-NG', tz: -60,  tier: 'A' },
  { code: 'PK', name: 'Pakistan',       hl: 'en-PK', tz: -300, tier: 'A' },
  // Tier B — secondary markets, alternate cycles
  { code: 'AU', name: 'Australia',      hl: 'en-AU', tz: -600, tier: 'B' },
  { code: 'CA', name: 'Canada',         hl: 'en-CA', tz: 300,  tier: 'B' },
  { code: 'MX', name: 'Mexico',         hl: 'es-MX', tz: 360,  tier: 'B' },
  { code: 'KR', name: 'South Korea',    hl: 'ko',    tz: -540, tier: 'B' },
  { code: 'DE', name: 'Germany',        hl: 'de',    tz: -60,  tier: 'B' },
  { code: 'FR', name: 'France',         hl: 'fr',    tz: -60,  tier: 'B' },
  { code: 'JP', name: 'Japan',          hl: 'ja',    tz: -540, tier: 'B' },
  { code: 'ZA', name: 'South Africa',   hl: 'en-ZA', tz: -120, tier: 'B' },
  { code: 'EG', name: 'Egypt',          hl: 'ar',    tz: -120, tier: 'B' },
  { code: 'TH', name: 'Thailand',       hl: 'th',    tz: -420, tier: 'B' },
  { code: 'VN', name: 'Vietnam',        hl: 'vi',    tz: -420, tier: 'B' },
  { code: 'TR', name: 'Turkey',         hl: 'tr',    tz: -180, tier: 'B' },
];

export const TIER_A_GEOS = GEO_TARGETS.filter(g => g.tier === 'A');
export const ALL_GEOS = GEO_TARGETS;
