import { jest } from '@jest/globals';
import { AlbumsHandler } from '../handlers/albums.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from '../utils/auth.js';

jest.mock('../utils/api');

describe('AlbumsHandler', () => {
  let handler: AlbumsHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;
    handler = new AlbumsHandler(mockApi);
  });

  describe('getAlbum', () => {
    it('should fetch an album by ID', async () => {
      const mockResponse = { id: '123', name: 'Test Album' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getAlbum({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums/123');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:album: prefixed IDs', async () => {
      const mockResponse = { id: '123', name: 'Test Album' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getAlbum({ id: 'spotify:album:123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums/123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getMultipleAlbums', () => {
    it('should fetch multiple albums by IDs', async () => {
      const mockResponse = { albums: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getMultipleAlbums({ ids: ['123', '456'] });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums?ids=123,456');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:album: prefixed IDs', async () => {
      const mockResponse = { albums: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.getMultipleAlbums({
        ids: ['spotify:album:123', 'spotify:album:456']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums?ids=123,456');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when no IDs provided', async () => {
      await expect(handler.getMultipleAlbums({ ids: [] })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'At least one album ID must be provided')
      );
    });

    it('should throw error when too many IDs provided', async () => {
      const ids = Array(21).fill('123');
      await expect(handler.getMultipleAlbums({ ids })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Maximum of 20 album IDs allowed')
      );
    });
  });

  describe('getAlbumTracks', () => {
    it('should fetch album tracks with default parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=20&offset=0');

      const result = await handler.getAlbumTracks({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums/123/tracks?limit=20&offset=0');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch album tracks with custom parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=30&offset=20');

      const result = await handler.getAlbumTracks({
        id: '123',
        limit: 30,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums/123/tracks?limit=30&offset=20');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:album: prefixed IDs', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=20&offset=0');

      const result = await handler.getAlbumTracks({
        id: 'spotify:album:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/albums/123/tracks?limit=20&offset=0');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when limit is less than 1', async () => {
      await expect(handler.getAlbumTracks({
        id: '123',
        limit: 0
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when limit is greater than 50', async () => {
      await expect(handler.getAlbumTracks({
        id: '123',
        limit: 51
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when offset is negative', async () => {
      await expect(handler.getAlbumTracks({
        id: '123',
        offset: -1
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Offset must be non-negative')
      );
    });
  });

  describe('getNewReleases', () => {
    it('should fetch new releases with default parameters', async () => {
      const mockResponse = { albums: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=20&offset=0');

      const result = await handler.getNewReleases({});

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/new-releases?limit=20&offset=0');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch new releases with custom parameters', async () => {
      const mockResponse = { albums: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?country=US&limit=30&offset=20');

      const result = await handler.getNewReleases({
        country: 'US',
        limit: 30,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/new-releases?country=US&limit=30&offset=20');
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when limit is less than 1', async () => {
      await expect(handler.getNewReleases({
        limit: 0
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when limit is greater than 50', async () => {
      await expect(handler.getNewReleases({
        limit: 51
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Limit must be between 1 and 50')
      );
    });

    it('should throw error when offset is negative', async () => {
      await expect(handler.getNewReleases({
        offset: -1
      })).rejects.toThrow(
        new McpError(ErrorCode.InvalidParams, 'Offset must be non-negative')
      );
    });
  });
}); 