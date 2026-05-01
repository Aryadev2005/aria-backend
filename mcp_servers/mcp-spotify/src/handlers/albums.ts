import { SpotifyApi } from '../utils/api.js';
import {
  AlbumArgs,
  AlbumTracksArgs,
  MultipleAlbumsArgs,
  NewReleasesArgs,
} from '../types/albums.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class AlbumsHandler {
  constructor(private api: SpotifyApi) {}

  private extractAlbumId(id: string): string {
    return id.startsWith('spotify:album:') ? id.split(':')[2] : id;
  }

  async getAlbum(args: AlbumArgs) {
    const albumId = this.extractAlbumId(args.id);
    return this.api.makeRequest(`/albums/${albumId}`);
  }

  async getMultipleAlbums(args: MultipleAlbumsArgs) {
    if (args.ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one album ID must be provided'
      );
    }

    if (args.ids.length > 20) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Maximum of 20 album IDs allowed'
      );
    }

    const albumIds = args.ids.map(this.extractAlbumId);
    return this.api.makeRequest(`/albums?ids=${albumIds.join(',')}`);
  }

  async getAlbumTracks(args: AlbumTracksArgs) {
    const albumId = this.extractAlbumId(args.id);
    const { limit = 20, offset = 0 } = args;

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

    const params = { limit, offset };
    return this.api.makeRequest(
      `/albums/${albumId}/tracks${this.api.buildQueryString(params)}`
    );
  }

  async getNewReleases(args: NewReleasesArgs) {
    const { country, limit = 20, offset = 0 } = args;

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
      country,
      limit,
      offset
    };

    return this.api.makeRequest(
      `/browse/new-releases${this.api.buildQueryString(params)}`
    );
  }
}
