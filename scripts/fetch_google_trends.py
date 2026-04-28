#!/usr/bin/env python3
# scripts/fetch_google_trends.py
# Fetches real Google Trends data for India using pytrends
# Install: pip install pytrends
# Called by googleTrends.service.js

import json
import sys
import time

try:
    from pytrends.request import TrendReq
except ImportError:
    print(json.dumps({"error": "pytrends not installed. Run: pip install pytrends"}))
    sys.exit(0)

# India niche keywords — grouped for batch fetching
KEYWORD_GROUPS = [
    ['instagram reels', 'youtube shorts', 'content creator'],
    ['myntra fashion', 'nykaa beauty', 'meesho'],
    ['zerodha', 'groww app', 'mutual funds'],
    ['street food', 'zomato', 'swiggy'],
    ['gym workout', 'yoga', 'fitness india'],
    ['bollywood', 'ipl 2025', 'cricket'],
    ['startup india', 'shark tank india', 'side hustle'],
    ['ai tools', 'chatgpt india', 'smartphone'],
]

NICHE_MAP = {
    'instagram reels': ['fashion', 'comedy', 'general'],
    'youtube shorts': ['education', 'tech', 'general'],
    'content creator': ['general'],
    'myntra fashion': ['fashion'],
    'nykaa beauty': ['fashion', 'beauty'],
    'meesho': ['fashion', 'hustle'],
    'zerodha': ['finance'],
    'groww app': ['finance'],
    'mutual funds': ['finance'],
    'street food': ['food'],
    'zomato': ['food'],
    'swiggy': ['food'],
    'gym workout': ['fitness', 'athlete'],
    'yoga': ['fitness', 'wellness'],
    'fitness india': ['fitness'],
    'bollywood': ['entertainment', 'bollywood'],
    'ipl 2025': ['cricket', 'sports'],
    'cricket': ['sports'],
    'startup india': ['hustle', 'business'],
    'shark tank india': ['hustle', 'business'],
    'side hustle': ['hustle', 'finance'],
    'ai tools': ['tech'],
    'chatgpt india': ['tech', 'education'],
    'smartphone': ['tech'],
}

def fetch_trends():
    try:
        pytrends = TrendReq(
            hl='en-IN',
            tz=330,  # IST = UTC+5:30
            timeout=(10, 25),
            retries=2,
            backoff_factor=0.5,
        )

        all_trends = []
        seen_titles = set()

        for group in KEYWORD_GROUPS[:4]:  # Limit to 4 groups to avoid rate limiting
            try:
                pytrends.build_payload(
                    group,
                    cat=0,
                    timeframe='now 7-d',
                    geo='IN',
                    gprop=''
                )

                # Interest over time
                interest_df = pytrends.interest_over_time()

                if interest_df is not None and not interest_df.empty:
                    for keyword in group:
                        if keyword in interest_df.columns:
                            values = interest_df[keyword].tolist()
                            if len(values) >= 2:
                                current = values[-1]
                                previous = values[0] if values[0] > 0 else 1
                                velocity = min(100, int((current / previous) * 50))
                                search_volume = current * 1000  # Scale to approximate volume

                                if keyword not in seen_titles and current > 10:
                                    seen_titles.add(keyword)
                                    all_trends.append({
                                        'title': keyword.title(),
                                        'search_volume': search_volume,
                                        'velocity': max(50, velocity),
                                        'niche_tags': NICHE_MAP.get(keyword, ['general']),
                                        'source': 'google_trends',
                                        'raw_interest': current,
                                    })

                time.sleep(1.5)  # Rate limiting between requests

            except Exception as e:
                continue  # Skip failed group, try next

        # Also fetch trending searches in India
        try:
            trending = pytrends.trending_searches(pn='india')
            trending_list = trending[0].tolist() if trending is not None else []

            for i, term in enumerate(trending_list[:10]):
                if term not in seen_titles:
                    seen_titles.add(term)
                    all_trends.append({
                        'title': str(term).title(),
                        'search_volume': max(50000, (10 - i) * 10000),
                        'velocity': max(70, 100 - i * 3),
                        'niche_tags': ['general'],
                        'source': 'google_trending',
                        'raw_interest': 100 - i * 5,
                    })
        except Exception:
            pass  # Trending searches optional

        # Sort by velocity
        all_trends.sort(key=lambda x: x['velocity'], reverse=True)

        print(json.dumps({
            'trends': all_trends[:25],
            'count': len(all_trends),
            'source': 'pytrends',
        }))

    except Exception as e:
        print(json.dumps({'error': str(e), 'trends': []}))

if __name__ == '__main__':
    fetch_trends()
