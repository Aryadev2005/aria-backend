import axios from 'axios';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SpotifyErrorResponse } from '../types/common.js';
import { AuthManager } from './auth.js';

export const BASE_URL = 'https://api.spotify.com/v1';

export class SpotifyApi {
  private authManager: AuthManager;

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
  }

  async makeRequest<T>(
    path: string, 
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', 
    data?: any
  ): Promise<T> {
    try {
      const token = await this.authManager.getAccessToken();
      const response = await axios({
        method,
        url: `${BASE_URL}${path}`,
        headers: {
          'Authorization': `Bearer ${token}`
        },
        data
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const spotifyError = error.response?.data as SpotifyErrorResponse;
        throw new McpError(
          ErrorCode.InternalError,
          `Spotify API error: ${spotifyError?.error?.message ?? error.message}`
        );
      }
      throw error;
    }
  }

  buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
    const urlParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        urlParams.set(key, value.toString());
      }
    });

    const queryString = urlParams.toString();
    return queryString ? `?${queryString}` : '';
  }
}
