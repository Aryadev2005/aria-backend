import { MarketParams, PaginationParams } from './common';

export interface ArtistArgs {
  id: string;
}

export interface ArtistTopTracksArgs extends ArtistArgs, MarketParams {}

export interface ArtistRelatedArtistsArgs extends ArtistArgs {}

export interface ArtistAlbumsArgs extends ArtistArgs, PaginationParams {
  include_groups?: ('album' | 'single' | 'appears_on' | 'compilation')[];
}

export interface MultipleArtistsArgs {
  ids: string[];
}
