export interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

export interface SpotifyErrorResponse {
  error: {
    status: number;
    message: string;
  };
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface MarketParams {
  market?: string;
}
