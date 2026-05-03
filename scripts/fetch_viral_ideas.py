#!/usr/bin/env python3
"""
fetch_viral_ideas.py
Fetches GLOBAL rising signals from pytrends related_queries.
These are the 48-72h early indicators — breakout queries before
they hit mainstream trending searches.
Called by: viralIdeas.service.ts
"""

import json
import sys
import time
import os

try:
    from pytrends.request import TrendReq
except ImportError:
    print(json.dumps({"error": "pytrends not installed", "ideas": []}))
    sys.exit(0)

# Niche → seed keywords to pull related_queries from
# Keep seeds broad so related_queries returns specific emerging topics
NICHE_SEEDS = {
    "fashion":     ["fashion trends", "outfit ideas", "streetwear", "aesthetic fashion", "thrift fashion"],
    "beauty":      ["skincare routine", "makeup tutorial", "beauty hacks", "drugstore makeup", "glow up"],
    "fitness":     ["workout routine", "weight loss", "gym tips", "calisthenics", "home workout"],
    "food":        ["recipe ideas", "street food", "viral food", "easy recipes", "food hack"],
    "tech":        ["ai tools", "tech review", "smartphone", "chatgpt", "productivity apps"],
    "finance":     ["investment tips", "make money online", "stock market", "crypto", "side hustle"],
    "travel":      ["travel tips", "budget travel", "solo travel", "hidden gems", "travel vlog"],
    "education":   ["study tips", "online learning", "skill development", "upsc preparation", "coding tutorial"],
    "comedy":      ["funny videos", "comedy skits", "viral memes", "stand up comedy", "trending jokes"],
    "gaming": ["gaming tips", "game review", "esports", "mobile gaming", "twitch stream"],
    "cricket":     ["cricket highlights", "ipl", "cricket tips", "fantasy cricket", "cricket news"],
    "bollywood":   ["bollywood songs", "movie review", "celebrity news", "web series", "ott releases"],
    "hustle":      ["entrepreneurship", "startup ideas", "business tips", "passive income", "freelancing"],
    "wellness":    ["mental health", "meditation", "yoga", "self care", "mindfulness"],
    "mens fashion":   ["men's fashion", "mens outfit", "menswear", "male fashion", "men style"],
    "mens grooming":  ["men grooming", "beard care", "mens skincare", "male grooming"],
    "womens fashion": ["womens fashion", "women outfit", "ladies fashion", "girl outfit ideas"],
    "street fashion": ["streetwear", "street style", "urban fashion", "sneaker culture"],
    "general":     ["viral content", "trending now", "social media tips", "content ideas", "viral video"],
}

def fetch_for_niche(pytrends, niche: str, seeds: list) -> list:
    ideas = []
    seen = set()

    # Use only first 3 seeds per niche to stay within rate limits
    for seed in seeds[:3]:
        try:
            pytrends.build_payload(
                [seed],
                timeframe="now 7-d",  # Last 7 days globally
                geo="",               # GLOBAL — not IN
                gprop=""
            )

            related = pytrends.related_queries()
            rising_df = related.get(seed, {}).get("rising")

            if rising_df is None or rising_df.empty:
                continue

            for _, row in rising_df.head(5).iterrows():
                query = str(row.get("query", "")).strip()
                value = row.get("value", 0)

                if not query or query.lower() in seen:
                    continue
                seen.add(query.lower())

                # "Breakout" means >5000% growth — highest priority signal
                is_breakout = str(value) == "Breakout"
                velocity = 98 if is_breakout else min(95, max(60, int(value or 60)))

                ideas.append({
                    "title": query.title(),
                    "seed_keyword": seed,
                    "niche": niche,
                    "velocity": velocity,
                    "is_breakout": is_breakout,
                    "growth_value": "Breakout" if is_breakout else f"+{value}%",
                    "source": "google_related_rising_global",
                    "geo": "GLOBAL",
                })

            time.sleep(1.2)  # Respect rate limit

        except Exception as e:
            continue  # Skip failed seeds, try next

    return ideas


def main():
    # Accept niche via environment variable for better stability
    niche = os.environ.get("ARIA_NICHE", "general").strip().lower()
    seeds = NICHE_SEEDS.get(niche, NICHE_SEEDS["general"])

    try:
        pytrends = TrendReq(
            hl="en-US",
            tz=0,  # UTC for global
            timeout=(10, 25),
            retries=2,
            backoff_factor=0.5,
        )

        ideas = fetch_for_niche(pytrends, niche, seeds)

        # Sort by velocity desc
        ideas.sort(key=lambda x: x["velocity"], reverse=True)

        print(json.dumps({
            "ideas": ideas[:15],  # Top 15 raw signals
            "niche": niche,
            "count": len(ideas),
            "source": "pytrends_related_rising_global",
        }))

    except Exception as e:
        print(json.dumps({"error": str(e), "ideas": [], "niche": niche}))


if __name__ == "__main__":
    main()
