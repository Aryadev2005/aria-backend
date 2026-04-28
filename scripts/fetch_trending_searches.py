#!/usr/bin/env python3
# scripts/fetch_trending_searches.py
# Fetches today's trending searches in India via pytrends
# Install: pip install pytrends

import json
import sys

try:
    from pytrends.request import TrendReq
except ImportError:
    print(json.dumps({"error": "pytrends not installed", "trending": []}))
    sys.exit(0)

def fetch():
    try:
        pytrends = TrendReq(hl='en-IN', tz=330, timeout=(10, 25))
        df = pytrends.trending_searches(pn='india')
        trending = df[0].tolist() if df is not None and len(df) > 0 else []
        print(json.dumps({"trending": trending[:20], "source": "google_trending"}))
    except Exception as e:
        print(json.dumps({"error": str(e), "trending": []}))

if __name__ == '__main__':
    fetch()
