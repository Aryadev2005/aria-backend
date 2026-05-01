export interface SearchArgs {
  query: string;
  type: 'track' | 'album' | 'artist' | 'playlist';
  limit?: number;
}

export interface SearchResponse {
  tracks?: {
    items: any[];
    limit: number;
    next: string | null;
    offset: number;
    previous: string | null;
    total: number;
  };
  albums?: {
    items: any[];
    limit: number;
    next: string | null;
    offset: number;
    previous: string | null;
    total: number;
  };
  artists?: {
    items: any[];
    limit: number;
    next: string | null;
    offset: number;
    previous: string | null;
    total: number;
  };
  playlists?: {
    items: any[];
    limit: number;
    next: string | null;
    offset: number;
    previous: string | null;
    total: number;
  };
} 