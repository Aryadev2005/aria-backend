import { MarketParams } from './common.js';

export interface AudiobookChaptersArgs extends MarketParams {
  id: string;
  limit?: number;
  offset?: number;
}

export interface AudiobookArgs extends MarketParams {
  id: string;
}

export interface MultipleAudiobooksArgs extends MarketParams {
  ids: string[];
}
