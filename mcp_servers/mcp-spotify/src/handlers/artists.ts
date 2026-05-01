import { SpotifyApi } from '../utils/api.js';
import {
  ArtistArgs,
  ArtistTopTracksArgs,
  ArtistRelatedArtistsArgs,
  ArtistAlbumsArgs,
  MultipleArtistsArgs,
} from '../types/artists.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class ArtistsHandler {
  constructor(private api: SpotifyApi) {}

  private extractArtistId(id: string): string {
    return id.startsWith('spotify:artist:') ? id.split(':')[2] : id;
  }

  async getArtist(args: ArtistArgs) {
    const artistId = this.extractArtistId(args.id);
    return this.api.makeRequest(`/artists/${artistId}`);
  }

  async getMultipleArtists(args: MultipleArtistsArgs) {
    if (args.ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one artist ID must be provided'
      );
    }

    if (args.ids.length > 50) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Maximum of 50 artist IDs allowed'
      );
    }

    const artistIds = args.ids.map(this.extractArtistId);
    return this.api.makeRequest(`/artists?ids=${artistIds.join(',')}`);
  }

  async getArtistTopTracks(args: ArtistTopTracksArgs) {
    const artistId = this.extractArtistId(args.id);

    if (!args.market) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'market parameter is required for top tracks'
      );
    }

    return this.api.makeRequest(
      `/artists/${artistId}/top-tracks?market=${args.market}`
    );
  }

  async getArtistRelatedArtists(args: ArtistRelatedArtistsArgs) {
    const artistId = this.extractArtistId(args.id);
    return this.api.makeRequest(`/artists/${artistId}/related-artists`);
  }

  async getArtistAlbums(args: ArtistAlbumsArgs) {
    const artistId = this.extractArtistId(args.id);
    const { limit = 20, offset = 0, include_groups } = args;

    if (limit < 1 || limit > 50) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Limit must be between 1 and 50'
      );
    }

    if (offset < 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Offset must be non-negative'
      );
    }

    const params = {
      limit,
      offset,
      include_groups: include_groups?.join(',')
    };

    return this.api.makeRequest(
      `/artists/${artistId}/albums${this.api.buildQueryString(params)}`
    );
  }
}
