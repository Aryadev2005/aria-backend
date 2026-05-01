import { SpotifyApi } from '../utils/api.js';
import {
  TrackArgs,
  RecommendationsArgs,
} from '../types/tracks.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class TracksHandler {
  constructor(private api: SpotifyApi) {}

  private extractTrackId(id: string): string {
    return id.startsWith('spotify:track:') ? id.split(':')[2] : id;
  }

  async getTrack(args: TrackArgs) {
    const trackId = this.extractTrackId(args.id);
    return this.api.makeRequest(`/tracks/${trackId}`);
  }

  async getRecommendations(args: RecommendationsArgs) {
    const { 
      seed_tracks = [], 
      seed_artists = [], 
      seed_genres = [], 
      limit = 20 
    } = args;

    if (seed_tracks.length + seed_artists.length + seed_genres.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one seed (tracks, artists, or genres) must be provided'
      );
    }

    if (limit < 1 || limit > 100) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Limit must be between 1 and 100'
      );
    }

    const trackIds = seed_tracks.map(this.extractTrackId);
    const artistIds = seed_artists.map(id => 
      id.startsWith('spotify:artist:') ? id.split(':')[2] : id
    );

    const params = {
      seed_tracks: trackIds.length ? trackIds.join(',') : undefined,
      seed_artists: artistIds.length ? artistIds.join(',') : undefined,
      seed_genres: seed_genres.length ? seed_genres.join(',') : undefined,
      limit
    };

    return this.api.makeRequest(`/recommendations${this.api.buildQueryString(params)}`);
  }

  async getAvailableGenres() {
    return this.api.makeRequest('/recommendations/available-genre-seeds');
  }
}
