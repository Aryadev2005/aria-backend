declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string;
    geo?: string;
    startTime?: Date;
    endTime?: Date;
    timeframe?: string;
    category?: number;
    property?: string;
  }

  interface TrendsResult {
    default: {
      interestOverTime: (options: TrendsOptions) => Promise<string>;
      dailyTrends: (options?: { geo?: string; hl?: string }) => Promise<string>;
      realTimeTrends: (options?: { geo?: string; hl?: string }) => Promise<string>;
      interestByRegion: (options: TrendsOptions) => Promise<string>;
      relatedQueries: (options: TrendsOptions) => Promise<string>;
      relatedTopics: (options: TrendsOptions) => Promise<string>;
      autoComplete: (options: { keyword: string; geo?: string; hl?: string }) => Promise<string>;
    };
  }

  const trends: TrendsResult['default'];
  export = trends;
}
