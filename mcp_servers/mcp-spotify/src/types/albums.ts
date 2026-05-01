import { PaginationParams } from './common.js';

export interface AlbumArgs {
  id: string;
}

export interface AlbumTracksArgs extends AlbumArgs, PaginationParams {}

export interface MultipleAlbumsArgs {
  ids: string[];
}

export interface NewReleasesArgs extends PaginationParams {
  country?: string;
}
