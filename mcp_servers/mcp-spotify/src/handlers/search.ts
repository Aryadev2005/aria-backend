import { SpotifyApi } from '../utils/api.js';
import { SearchArgs } from '../types/search.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class SearchHandler {
  constructor(private api: SpotifyApi) {}

  async search(args: SearchArgs) {
    const { query, type, limit = 20 } = args;

    if (limit < 1 || limit > 50) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Limit must be between 1 and 50'
      );
    }

    const params = {
      q: encodeURIComponent(query),
      type,
      limit
    };

    return this.api.makeRequest(`/search${this.api.buildQueryString(params)}`);
  }
} 