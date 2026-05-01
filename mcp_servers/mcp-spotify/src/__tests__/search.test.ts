import { jest } from '@jest/globals';
import { SearchHandler } from '../handlers/search.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from '../utils/auth.js';

// Mock the SpotifyApi class
jest.mock('../utils/api.js');

describe('SearchHandler', () => {
  let handler: SearchHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a mock instance of SpotifyApi
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;

    handler = new SearchHandler(mockApi);
  });

  describe('search', () => {
    it('should search with default parameters', async () => {
      const mockResponse = { tracks: { items: [] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?q=test&type=track&limit=20');

      const result = await handler.search({
        query: 'test',
        type: 'track'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test&type=track&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should search with custom limit', async () => {
      const mockResponse = { tracks: { items: [] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?q=test&type=track&limit=30');

      const result = await handler.search({
        query: 'test',
        type: 'track',
        limit: 30
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test&type=track&limit=30');
      expect(result).toEqual(mockResponse);
    });

    it('should encode query parameters', async () => {
      const mockResponse = { tracks: { items: [] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?q=test%20with%20spaces&type=track&limit=20');

      const result = await handler.search({
        query: 'test with spaces',
        type: 'track'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test%20with%20spaces&type=track&limit=20');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when limit is less than 1', async () => {
      await expect(handler.search({
        query: 'test',
        type: 'track',
        limit: 0
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when limit is greater than 50', async () => {
      await expect(handler.search({
        query: 'test',
        type: 'track',
        limit: 51
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should search for albums', async () => {
      const mockResults = {
        albums: { items: [{ id: '1' }, { id: '2' }] }
      };
      mockApi.makeRequest.mockResolvedValue(mockResults);
      mockApi.buildQueryString.mockReturnValue('?q=test&type=album&limit=20');

      const result = await handler.search({
        query: 'test',
        type: 'album'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test&type=album&limit=20');
      expect(result).toEqual(mockResults);
    });

    it('should search for artists', async () => {
      const mockResults = {
        artists: { items: [{ id: '1' }, { id: '2' }] }
      };
      mockApi.makeRequest.mockResolvedValue(mockResults);
      mockApi.buildQueryString.mockReturnValue('?q=test&type=artist&limit=20');

      const result = await handler.search({
        query: 'test',
        type: 'artist'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test&type=artist&limit=20');
      expect(result).toEqual(mockResults);
    });

    it('should search for playlists', async () => {
      const mockResults = {
        playlists: { items: [{ id: '1' }, { id: '2' }] }
      };
      mockApi.makeRequest.mockResolvedValue(mockResults);
      mockApi.buildQueryString.mockReturnValue('?q=test&type=playlist&limit=20');

      const result = await handler.search({
        query: 'test',
        type: 'playlist'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/search?q=test&type=playlist&limit=20');
      expect(result).toEqual(mockResults);
    });
  });
}); 