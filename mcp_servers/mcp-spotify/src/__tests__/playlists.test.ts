import { jest } from '@jest/globals';
import { PlaylistsHandler } from '../handlers/playlists.js';
import { SpotifyApi } from '../utils/api.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from '../utils/auth.js';

jest.mock('../utils/api');

describe('PlaylistsHandler', () => {
  let handler: PlaylistsHandler;
  let mockApi: jest.Mocked<SpotifyApi>;

  beforeEach(() => {
    mockApi = {
      makeRequest: jest.fn(),
      buildQueryString: jest.fn(),
    } as unknown as jest.Mocked<SpotifyApi>;
    handler = new PlaylistsHandler(mockApi);
  });

  describe('getPlaylist', () => {
    it('should fetch a playlist by ID', async () => {
      const mockResponse = { id: '123', name: 'Test Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylist({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch a playlist with market parameter', async () => {
      const mockResponse = { id: '123', name: 'Test Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?market=US');

      const result = await handler.getPlaylist({ id: '123', market: 'US' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123?market=US');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { id: '123', name: 'Test Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylist({ id: 'spotify:playlist:123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getPlaylistTracks', () => {
    it('should fetch playlist tracks with default parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylistTracks({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/tracks');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch playlist tracks with custom parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?market=US&limit=30&offset=20&fields=items(track(id,name))');

      const result = await handler.getPlaylistTracks({
        id: '123',
        market: 'US',
        limit: 30,
        offset: 20,
        fields: 'items(track(id,name))'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/tracks?market=US&limit=30&offset=20&fields=items(track(id,name))');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylistTracks({
        id: 'spotify:playlist:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/tracks');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getPlaylistItems', () => {
    it('should fetch playlist items with default parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylistItems({ id: '123' });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/items');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch playlist items with custom parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?market=US&limit=30&offset=20&fields=items(track(id,name))');

      const result = await handler.getPlaylistItems({
        id: '123',
        market: 'US',
        limit: 30,
        offset: 20,
        fields: 'items(track(id,name))'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/items?market=US&limit=30&offset=20&fields=items(track(id,name))');
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getPlaylistItems({
        id: 'spotify:playlist:123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/playlists/123/items');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('modifyPlaylist', () => {
    it('should modify playlist with all parameters', async () => {
      const mockResponse = { id: '123', name: 'Updated Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.modifyPlaylist({
        id: '123',
        name: 'Updated Playlist',
        public: true,
        collaborative: false,
        description: 'New description'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123',
        'PUT',
        {
          name: 'Updated Playlist',
          public: true,
          collaborative: false,
          description: 'New description'
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should modify playlist with partial parameters', async () => {
      const mockResponse = { id: '123', name: 'Updated Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.modifyPlaylist({
        id: '123',
        name: 'Updated Playlist'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123',
        'PUT',
        {
          name: 'Updated Playlist'
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { id: '123', name: 'Updated Playlist' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.modifyPlaylist({
        id: 'spotify:playlist:123',
        name: 'Updated Playlist'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123',
        'PUT',
        {
          name: 'Updated Playlist'
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('addTracksToPlaylist', () => {
    it('should add tracks to playlist', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.addTracksToPlaylist({
        id: '123',
        uris: ['spotify:track:456', 'spotify:track:789']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'POST',
        {
          uris: ['spotify:track:456', 'spotify:track:789']
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should add tracks to playlist at specific position', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.addTracksToPlaylist({
        id: '123',
        uris: ['spotify:track:456'],
        position: 5
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'POST',
        {
          uris: ['spotify:track:456'],
          position: 5
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.addTracksToPlaylist({
        id: 'spotify:playlist:123',
        uris: ['spotify:track:456']
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'POST',
        {
          uris: ['spotify:track:456']
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('removeTracksFromPlaylist', () => {
    it('should remove tracks from playlist', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.removeTracksFromPlaylist({
        id: '123',
        tracks: [
          { uri: 'spotify:track:456' },
          { uri: 'spotify:track:789' }
        ]
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'DELETE',
        {
          tracks: [
            { uri: 'spotify:track:456' },
            { uri: 'spotify:track:789' }
          ]
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should remove tracks from playlist with snapshot ID', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.removeTracksFromPlaylist({
        id: '123',
        tracks: [{ uri: 'spotify:track:456' }],
        snapshot_id: 'abc123'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'DELETE',
        {
          tracks: [{ uri: 'spotify:track:456' }],
          snapshot_id: 'abc123'
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle spotify:playlist: prefixed IDs', async () => {
      const mockResponse = { snapshot_id: 'abc123' };
      mockApi.makeRequest.mockResolvedValue(mockResponse);

      const result = await handler.removeTracksFromPlaylist({
        id: 'spotify:playlist:123',
        tracks: [{ uri: 'spotify:track:456' }]
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith(
        '/playlists/123/tracks',
        'DELETE',
        {
          tracks: [{ uri: 'spotify:track:456' }]
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getCurrentUserPlaylists', () => {
    it('should fetch current user playlists with default parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getCurrentUserPlaylists({});

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/me/playlists');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch current user playlists with custom parameters', async () => {
      const mockResponse = { items: [{ id: '123' }, { id: '456' }] };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=30&offset=20');

      const result = await handler.getCurrentUserPlaylists({
        limit: 30,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/me/playlists?limit=30&offset=20');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getFeaturedPlaylists', () => {
    it('should fetch featured playlists with default parameters', async () => {
      const mockResponse = { playlists: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getFeaturedPlaylists({});

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/featured-playlists');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch featured playlists with custom parameters', async () => {
      const mockResponse = { playlists: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?locale=es_ES&limit=30&offset=20');

      const result = await handler.getFeaturedPlaylists({
        locale: 'es_ES',
        limit: 30,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/featured-playlists?locale=es_ES&limit=30&offset=20');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getCategoryPlaylists', () => {
    it('should fetch category playlists with default parameters', async () => {
      const mockResponse = { playlists: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('');

      const result = await handler.getCategoryPlaylists({
        category_id: 'pop'
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/categories/pop/playlists');
      expect(result).toEqual(mockResponse);
    });

    it('should fetch category playlists with custom parameters', async () => {
      const mockResponse = { playlists: { items: [{ id: '123' }, { id: '456' }] } };
      mockApi.makeRequest.mockResolvedValue(mockResponse);
      mockApi.buildQueryString.mockReturnValue('?limit=30&offset=20');

      const result = await handler.getCategoryPlaylists({
        category_id: 'pop',
        limit: 30,
        offset: 20
      });

      expect(mockApi.makeRequest).toHaveBeenCalledWith('/browse/categories/pop/playlists?limit=30&offset=20');
      expect(result).toEqual(mockResponse);
    });
  });
}); 