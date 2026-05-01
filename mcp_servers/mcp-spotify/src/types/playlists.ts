import { MarketParams, PaginationParams } from './common.js';

export interface PlaylistArgs extends MarketParams {
  id: string;
}

export interface PlaylistTracksArgs extends MarketParams, PaginationParams {
  id: string;
  fields?: string;
}

export interface PlaylistItemsArgs extends MarketParams, PaginationParams {
  id: string;
  fields?: string;
}

export interface ModifyPlaylistArgs {
  id: string;
  name?: string;
  public?: boolean;
  collaborative?: boolean;
  description?: string;
}

export interface AddTracksToPlaylistArgs {
  id: string;
  uris: string[];
  position?: number;
}

export interface RemoveTracksFromPlaylistArgs {
  id: string;
  tracks: Array<{
    uri: string;
    positions?: number[];
  }>;
  snapshot_id?: string;
}

export interface GetCurrentUserPlaylistsArgs extends PaginationParams {
  limit?: number;
  offset?: number;
}

export interface GetFeaturedPlaylistsArgs {
  locale?: string;
  limit?: number;
  offset?: number;
}

export interface GetCategoryPlaylistsArgs {
  category_id: string;
  limit?: number;
  offset?: number;
}
