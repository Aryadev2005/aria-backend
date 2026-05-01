import { SpotifyApi } from '../utils/api.js';
import { AudiobookArgs, MultipleAudiobooksArgs, AudiobookChaptersArgs } from '../types/audiobooks.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class AudiobooksHandler {
  constructor(private api: SpotifyApi) {}

  private extractAudiobookId(id: string): string {
    return id.startsWith('spotify:audiobook:') ? id.split(':')[2] : id;
  }

  async getAudiobook(args: AudiobookArgs) {
    const audiobookId = this.extractAudiobookId(args.id);
    const { market } = args;

    const params = { market };
    return this.api.makeRequest(
      `/audiobooks/${audiobookId}${this.api.buildQueryString(params)}`
    );
  }

  async getMultipleAudiobooks(args: MultipleAudiobooksArgs) {
    const { ids, market } = args;

    if (ids.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'At least one audiobook ID must be provided'
      );
    }

    if (ids.length > 50) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Maximum of 50 audiobook IDs allowed'
      );
    }

    const audiobookIds = ids.map(this.extractAudiobookId);
    const params = { market };
    
    return this.api.makeRequest(
      `/audiobooks?ids=${audiobookIds.join(',')}${this.api.buildQueryString(params)}`
    );
  }

  async getAudiobookChapters(args: AudiobookChaptersArgs) {
    const audiobookId = this.extractAudiobookId(args.id);
    const { market, limit, offset } = args;

    const params = {
      market,
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset })
    };

    return this.api.makeRequest(
      `/audiobooks/${audiobookId}/chapters${this.api.buildQueryString(params)}`
    );
  }
}
