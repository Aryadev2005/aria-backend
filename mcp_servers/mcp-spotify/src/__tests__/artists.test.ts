import { jest } from '@jest/globals';
import { ArtistsHandler } from '../handlers/artists.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from '../utils/auth.js';

// Mock the SpotifyApi class
jest.mock('../utils/api.js');

describe('ArtistsHandler', () => {
  let handler: ArtistsHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a mock instance of SpotifyApi
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;

    handler = new ArtistsHandler(mockApi);
  });

  describe('getArtist', () => {
    it('should fetch an artist by ID', async () => {
      const mockResponse = { id: '123', name: 'Test Artist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtist({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:artist: prefixed IDs', async () => {
      const mockResponse = { id: '123', name: 'Test Artist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtist({ id: 'spotify:artist:123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getMultipleArtists', () => {
    it('should fetch multiple artists by IDs', async () => {
      const mockResponse = { artists: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getMultipleArtists({ ids: ['123', '456'] });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists?ids=123,456');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:artist: prefixed IDs', async () => {
      const mockResponse = { artists: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getMultipleArtists({
        ids: ['spotify:artist:123', 'spotify:artist:456']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists?ids=123,456');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when no IDs provided', async () => {
      await expect(handler.getMultipleArtists({ ids: [] })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'At least one artist ID must be provided')
      );
    });

    it('should throw error when too many IDs provided', async () => {
      const ids = Array(51).fill('123');
      await expect(handler.getMultipleArtists({ ids })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Maximum of 50 artist IDs allowed')
      );
    });
  });

  describe('getArtistTopTracks', () => {
    it('should fetch artist top tracks with market', async () => {
      const mockResponse = { tracks: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtistTopTracks({
        id: '123',
        market: 'US'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/top-tracks?market=US');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:artist: prefixed IDs', async () => {
      const mockResponse = { tracks: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtistTopTracks({
        id: 'spotify:artist:123',
        market: 'US'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/top-tracks?market=US');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when market is not provided', async () => {
      await expect(handler.getArtistTopTracks({ id: '123' })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'market parameter is required for top tracks')
      );
    });
  });

  describe('getArtistRelatedArtists', () => {
    it('should fetch artist related artists', async () => {
      const mockResponse = { artists: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtistRelatedArtists({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/related-artists');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:artist: prefixed IDs', async () => {
      const mockResponse = { artists: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getArtistRelatedArtists({
        id: 'spotify:artist:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/related-artists');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getArtistAlbums', () => {
    it('should fetch artist albums with default parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=20&offset=0');

      const result = await handler.getArtistAlbums({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/albums?limit=20&offset=0');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch artist albums with custom parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=30&offset=20&include_groups=album,single');

      const result = await handler.getArtistAlbums({
        id: '123',
        limit: 30,
        offset: 20,
        include_groups: ['album', 'single']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/albums?limit=30&offset=20&include_groups=album,single');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:artist: prefixed IDs', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=20&offset=0');

      const result = await handler.getArtistAlbums({
        id: 'spotify:artist:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/artists/123/albums?limit=20&offset=0');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when limit is less than 1', async () => {
      await expect(handler.getArtistAlbums({
        id: '123',
        limit: 0
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when limit is greater than 50', async () => {
      await expect(handler.getArtistAlbums({
        id: '123',
        limit: 51
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when offset is negative', async () => {
      await expect(handler.getArtistAlbums({
        id: '123',
        offset: -1
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Offset must be non-negative')
      );
    });
  });
}); 