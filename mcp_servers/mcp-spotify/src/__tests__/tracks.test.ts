import { jest } from '@jest/globals';
import { TracksHandler } from '../handlers/tracks.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from '../utils/auth.js';

jest.mock('../utils/api');

describe('TracksHandler', () => {
  let handler: TracksHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    const mockAuthManager = {} as AuthManager;
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;
    handler = new TracksHandler(mockApi);
  });

  describe('getTrack', () => {
    it('should fetch a track by ID', async () => {
      const mockResponse = { id: '123', name: 'Test Track' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getTrack({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/tracks/123');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:track: prefixed IDs', async () => {
      const mockResponse = { id: '123', name: 'Test Track' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getTrack({ id: 'spotify:track:123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/tracks/123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getRecommendations', () => {
    it('should fetch recommendations with seed tracks', async () => {
      const mockResponse = { tracks: [] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?seed_tracks=123,456&limit=20');

      const result = await handler.getRecommendations({
        seed_tracks: ['123', '456'],
        limit: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations?seed_tracks=123,456&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch recommendations with seed artists', async () => {
      const mockResponse = { tracks: [] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?seed_artists=123,456&limit=20');

      const result = await handler.getRecommendations({
        seed_artists: ['123', '456'],
        limit: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations?seed_artists=123,456&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch recommendations with seed genres', async () => {
      const mockResponse = { tracks: [] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?seed_genres=rock,pop&limit=20');

      const result = await handler.getRecommendations({
        seed_genres: ['rock', 'pop'],
        limit: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations?seed_genres=rock,pop&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify: prefixed IDs in seed tracks', async () => {
      const mockResponse = { tracks: [] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?seed_tracks=123,456&limit=20');

      const result = await handler.getRecommendations({
        seed_tracks: ['spotify:track:123', 'spotify:track:456'],
        limit: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations?seed_tracks=123,456&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify: prefixed IDs in seed artists', async () => {
      const mockResponse = { tracks: [] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?seed_artists=123,456&limit=20');

      const result = await handler.getRecommendations({
        seed_artists: ['spotify:artist:123', 'spotify:artist:456'],
        limit: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations?seed_artists=123,456&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when no seeds provided', async () => {
      await expect(handler.getRecommendations({})).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'At least one seed (tracks, artists, or genres) must be provided')
      );
    });

    it('should throw error when limit is less than 1', async () => {
      await expect(handler.getRecommendations({ seed_tracks: ['123'], limit: 0 })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 100')
      );
    });

    it('should throw error when limit is greater than 100', async () => {
      await expect(handler.getRecommendations({ seed_tracks: ['123'], limit: 101 })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 100')
      );
    });
  });

  describe('getAvailableGenres', () => {
    it('should fetch available genre seeds', async () => {
      const mockResponse = { genres: ['rock', 'pop', 'jazz'] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getAvailableGenres();

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/recommendations/available-genre-seeds');
      expect(result).toEqual(mockResponse);
    });
  });
}); 