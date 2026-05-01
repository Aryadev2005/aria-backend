import { jest } from '@jest/globals';
import { AudiobooksHandler } from '../handlers/audiobooks.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Mock the SpotifyApi class
jest.mock('../utils/api.js');

describe('AudiobooksHandler', () => {
  let audiobooksHandler: AudiobooksHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a mock instance of SpotifyApi
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;

    audiobooksHandler = new AudiobooksHandler(mockApi);
  });

  describe('getAudiobook', () => {
    it('should fetch an audiobook by ID', async () => {
      const mockAudiobook = { id: '123', name: 'Test Audiobook' };
      mockApi.makeRequest.mockResolvedValue(mockAudiobook);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getAudiobook({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123');
      expect(result).toEqual(mockAudiobook);
    });

    it('should fetch an audiobook with market parameter', async () => {
      const mockAudiobook = { id: '123', name: 'Test Audiobook' };
      mockApi.makeRequest.mockResolvedValue(mockAudiobook);
      mockApi.buildQueryString.mockReturnValue('?market=US');

      const result = await audiobooksHandler.getAudiobook({ id: '123', market: 'US' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123?market=US');
      expect(result).toEqual(mockAudiobook);
    });

    it('should handle spotify:audiobook: prefixed IDs', async () => {
      const mockAudiobook = { id: '123', name: 'Test Audiobook' };
      mockApi.makeRequest.mockResolvedValue(mockAudiobook);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getAudiobook({ id: 'spotify:audiobook:123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123');
      expect(result).toEqual(mockAudiobook);
    });
  });

  describe('getMultipleAudiobooks', () => {
    it('should fetch multiple audiobooks by IDs', async () => {
      const mockAudiobooks = { audiobooks: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockAudiobooks);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getMultipleAudiobooks({ ids: ['123', '456'] });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks?ids=123,456');
      expect(result).toEqual(mockAudiobooks);
    });

    it('should fetch multiple audiobooks with market parameter', async () => {
      const mockAudiobooks = { audiobooks: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockAudiobooks);
      mockApi.buildQueryString.mockReturnValue('&market=US');

      const result = await audiobooksHandler.getMultipleAudiobooks({
        ids: ['123', '456'],
        market: 'US'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks?ids=123,456&market=US');
      expect(result).toEqual(mockAudiobooks);
    });

    it('should throw error when no IDs are provided', async () => {
      await expect(
        audiobooksHandler.getMultipleAudiobooks({ ids: [] })
      ).rejects.toThrow(new McpError(ErrorCode.InvalidParams, 'At least one audiobook ID must be provided'));
    });

    it('should throw error when more than 50 IDs are provided', async () => {
      const ids = Array(51).fill('123');
      await expect(
        audiobooksHandler.getMultipleAudiobooks({ ids })
      ).rejects.toThrow(new McpError(ErrorCode.InvalidParams, 'Maximum of 50 audiobook IDs allowed'));
    });

    it('should handle spotify:audiobook: prefixed IDs', async () => {
      const mockAudiobooks = { audiobooks: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockAudiobooks);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getMultipleAudiobooks({
        ids: ['spotify:audiobook:123', 'spotify:audiobook:456']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks?ids=123,456');
      expect(result).toEqual(mockAudiobooks);
    });
  });

  describe('getAudiobookChapters', () => {
    it('should fetch audiobook chapters with default parameters', async () => {
      const mockChapters = { items: [{ id: '1' }, { id: '2' }] };
      mockApi.makeRequest.mockResolvedValue(mockChapters);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getAudiobookChapters({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123/chapters');
      expect(result).toEqual(mockChapters);
    });

    it('should fetch audiobook chapters with custom parameters', async () => {
      const mockChapters = { items: [{ id: '1' }, { id: '2' }] };
      mockApi.makeRequest.mockResolvedValue(mockChapters);
      mockApi.buildQueryString.mockReturnValue('?market=US&limit=10&offset=20');

      const result = await audiobooksHandler.getAudiobookChapters({
        id: '123',
        market: 'US',
        limit: 10,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123/chapters?market=US&limit=10&offset=20');
      expect(result).toEqual(mockChapters);
    });

    it('should handle spotify:audiobook: prefixed IDs', async () => {
      const mockChapters = { items: [{ id: '1' }, { id: '2' }] };
      mockApi.makeRequest.mockResolvedValue(mockChapters);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await audiobooksHandler.getAudiobookChapters({
        id: 'spotify:audiobook:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/audiobooks/123/chapters');
      expect(result).toEqual(mockChapters);
    });
  });
}); 