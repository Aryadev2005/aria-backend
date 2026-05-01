export interface TrackArgs {
  id: string;
}

export interface RecommendationsArgs {
  seed_tracks?: string[];
  seed_artists?: string[];
  seed_genres?: string[];
  limit?: number;
}

export interface GenreSeedsResponse {
  genres: string[];
}
