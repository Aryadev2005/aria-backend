#!/usr/bin/env python3
"""
fetch_viral_ideas.py — Multi-source trend signal fetcher
Sources: Reddit rising + Google Trends RSS + pytrends (as fallback)
No API keys required. Robust — each source is independent.
"""

import json
import sys
import os
import time
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET

# ── CONFIG ────────────────────────────────────────────────────────────────────
niche = os.environ.get("ARIA_NICHE", "general").strip().lower()

NICHE_SUBREDDITS = {
    "mens fashion":   ["malefashionadvice", "streetwear", "mensfashion", "frugalmalefashion"],
    "womens fashion": ["femalefashionadvice", "streetwear", "fashionadvice"],
    "fashion":        ["malefashionadvice", "femalefashionadvice", "streetwear", "fashion"],
    "beauty":         ["SkincareAddiction", "MakeupAddiction", "IndianSkincareAddicts", "beauty"],
    "fitness":        ["fitness", "bodyweightfitness", "GYM", "india_fitness"],
    "food":           ["IndianFood", "food", "recipes", "Cooking"],
    "tech":           ["technology", "gadgets", "artificial", "ChatGPT"],
    "finance":        ["IndiaInvestments", "personalfinance", "StockMarket", "CryptoCurrency"],
    "travel":         ["travel", "solotravel", "backpacking", "india"],
    "gaming":         ["gaming", "IndianGaming", "pcgaming", "mobilegaming"],
    "education":      ["GetStudying", "learnprogramming", "india", "UPSCprep"],
    "comedy":         ["IndianComedians", "funny", "memes", "india"],
    "cricket":        ["cricket", "IPL", "IndianCricket"],
    "wellness":       ["mentalhealth", "meditation", "yoga", "selfimprovement"],
    "hustle":         ["Entrepreneur", "startups", "india", "digitalnomad"],
    "general":        ["india", "trending", "popular", "worldnews"],
}

NICHE_GOOGLE_KEYWORDS = {
    "mens fashion":   ["men fashion", "mens outfit", "menswear trend", "male style"],
    "womens fashion": ["women fashion", "ladies outfit", "girl style trend"],
    "fashion":        ["fashion trend", "outfit ideas", "style trend"],
    "beauty":         ["skincare trend", "makeup trend", "beauty hack"],
    "fitness":        ["workout trend", "gym tips", "fitness challenge"],
    "food":           ["food trend", "viral recipe", "food hack"],
    "tech":           ["tech trend", "ai tools", "gadget review"],
    "finance":        ["investment trend", "make money", "stock tips"],
    "travel":         ["travel trend", "travel destination", "travel tips"],
    "gaming":         ["gaming trend", "game review", "esports"],
    "education":      ["study tips", "online course", "skill development"],
    "comedy":         ["viral comedy", "funny trend", "meme trend"],
    "cricket":        ["cricket trend", "ipl", "cricket tips"],
    "wellness":       ["mental health trend", "meditation", "self care"],
    "hustle":         ["startup trend", "business idea", "side hustle"],
    "general":        ["trending topic", "viral content", "social media trend"],
}


def safe_get(url, timeout=8, headers=None):
    """HTTP GET with timeout, returns text or None"""
    try:
        req = urllib.request.Request(url, headers=headers or {
            "User-Agent": "Mozilla/5.0 (compatible; AriaBot/1.0)"
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="ignore")
    except Exception:
        return None


# ── SOURCE 1: Reddit Rising (no auth, JSON API) ───────────────────────────────
def fetch_reddit_rising(niche: str) -> list:
    subreddits = NICHE_SUBREDDITS.get(niche, NICHE_SUBREDDITS["general"])
    ideas = []
    seen = set()

    for sub in subreddits[:3]:  # Max 3 subreddits
        url = f"https://www.reddit.com/r/{sub}/rising.json?limit=10&raw_json=1"
        text = safe_get(url)
        if not text:
            continue

        try:
            data = json.loads(text)
            posts = data.get("data", {}).get("children", [])

            for post in posts:
                p = post.get("data", {})
                title = p.get("title", "").strip()
                score = p.get("score", 0)
                comments = p.get("num_comments", 0)
                upvote_ratio = p.get("upvote_ratio", 0.5)
                created = p.get("created_utc", 0)

                # Filter: minimum engagement + recent (last 48h)
                age_hours = (time.time() - created) / 3600
                if not title or score < 10 or age_hours > 48:
                    continue

                key = title.lower()[:50]
                if key in seen:
                    continue
                seen.add(key)

                # Velocity = engagement quality score
                velocity = min(95, int(
                    (upvote_ratio * 40) +
                    (min(score, 1000) / 1000 * 30) +
                    (min(comments, 500) / 500 * 30)
                ))

                ideas.append({
                    "title": title,
                    "source": f"reddit_r/{sub}_rising",
                    "niche": niche,
                    "velocity": max(60, velocity),
                    "growth_value": f"{score} upvotes · {comments} comments",
                    "is_breakout": score > 500 and age_hours < 6,
                    "geo": "GLOBAL",
                    "subreddit": sub,
                    "age_hours": round(age_hours, 1),
                })

        except Exception:
            continue

    # Sort by velocity
    ideas.sort(key=lambda x: x["velocity"], reverse=True)
    return ideas[:8]


# ── SOURCE 2: Google Trends RSS (no auth, real-time) ─────────────────────────
def fetch_google_trends_rss() -> list:
    """
    Google Trends daily trending searches RSS — no auth, no rate limit.
    Returns top trending queries globally.
    """
    url = "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US"
    text = safe_get(url, timeout=10)
    if not text:
        # Try India feed as fallback
        text = safe_get(
            "https://trends.google.com/trends/trendingsearches/daily/rss?geo=IN",
            timeout=10
        )
    if not text:
        return []

    try:
        root = ET.fromstring(text)
        ns = {"ht": "https://trends.google.com/trends/trendingsearches/daily"}
        items = root.findall(".//item")
        trends = []

        for i, item in enumerate(items[:15]):
            title_el = item.find("title")
            traffic_el = item.find("ht:approx_traffic", ns)

            if title_el is None:
                continue

            title = (title_el.text or "").strip()
            traffic_str = (traffic_el.text or "0+") if traffic_el is not None else "0+"
            traffic_num = int(traffic_str.replace(",", "").replace("+", "") or 0)

            if not title:
                continue

            trends.append({
                "title": title,
                "source": "google_trends_rss",
                "niche": "general",
                "velocity": max(70, min(98, 98 - i * 2)),  # rank-based velocity
                "growth_value": f"{traffic_str} searches",
                "is_breakout": i < 3,
                "geo": "GLOBAL",
                "traffic": traffic_num,
            })

        return trends

    except Exception:
        return []


# ── SOURCE 3: Reddit Hot → niche-specific (backup) ───────────────────────────
def fetch_reddit_hot(niche: str) -> list:
    subreddits = NICHE_SUBREDDITS.get(niche, NICHE_SUBREDDITS["general"])
    ideas = []
    seen = set()

    # Only hit one subreddit for hot (less important than rising)
    sub = subreddits[0] if subreddits else "india"
    url = f"https://www.reddit.com/r/{sub}/hot.json?limit=8&raw_json=1"
    text = safe_get(url)
    if not text:
        return []

    try:
        data = json.loads(text)
        posts = data.get("data", {}).get("children", [])

        for post in posts[1:]:  # Skip pinned post
            p = post.get("data", {})
            title = p.get("title", "").strip()
            score = p.get("score", 0)
            created = p.get("created_utc", 0)
            age_hours = (time.time() - created) / 3600

            if not title or score < 50 or age_hours > 72:
                continue

            key = title.lower()[:50]
            if key in seen:
                continue
            seen.add(key)

            ideas.append({
                "title": title,
                "source": f"reddit_r/{sub}_hot",
                "niche": niche,
                "velocity": min(85, max(55, int(min(score, 2000) / 2000 * 60) + 25)),
                "growth_value": f"{score} upvotes",
                "is_breakout": False,
                "geo": "GLOBAL",
            })

    except Exception:
        pass

    return ideas[:4]


# ── SOURCE 4: pytrends interest_over_time (if available, as bonus) ────────────
def fetch_pytrends_bonus(niche: str) -> list:
    try:
        from pytrends.request import TrendReq
        keywords = NICHE_GOOGLE_KEYWORDS.get(niche, NICHE_GOOGLE_KEYWORDS["general"])
        seed = keywords[0]  # Just one keyword — minimal rate limit risk

        pt = TrendReq(hl="en-US", tz=0, timeout=(5, 15), retries=1, backoff_factor=0.3)
        pt.build_payload([seed], timeframe="now 1-d", geo="", gprop="")

        related = pt.related_queries()
        rising_df = related.get(seed, {}).get("rising")

        if rising_df is None or rising_df.empty:
            return []

        results = []
        for _, row in rising_df.head(5).iterrows():
            query = str(row.get("query", "")).strip()
            value = row.get("value", 0)
            if not query:
                continue

            is_breakout = str(value) == "Breakout"
            results.append({
                "title": query.title(),
                "source": "pytrends_rising",
                "niche": niche,
                "velocity": 98 if is_breakout else min(90, max(65, int(value or 65))),
                "growth_value": "Breakout" if is_breakout else f"+{value}%",
                "is_breakout": is_breakout,
                "geo": "GLOBAL",
            })

        return results

    except Exception:
        return []  # Completely optional — never block on this


# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    all_ideas = []

    # Source 1: Reddit rising (primary — most reliable)
    reddit_rising = fetch_reddit_rising(niche)
    all_ideas.extend(reddit_rising)

    # Source 2: Google Trends RSS (global real-time)
    google_rss = fetch_google_trends_rss()
    all_ideas.extend(google_rss)

    # Source 3: Reddit hot (backup fill)
    if len(all_ideas) < 8:
        reddit_hot = fetch_reddit_hot(niche)
        all_ideas.extend(reddit_hot)

    # Source 4: pytrends (bonus — don't wait too long)
    pytrends_bonus = fetch_pytrends_bonus(niche)
    all_ideas.extend(pytrends_bonus)

    # Deduplicate by title similarity
    seen_titles = set()
    deduped = []
    for idea in all_ideas:
        key = idea["title"].lower()[:40]
        if key not in seen_titles:
            seen_titles.add(key)
            deduped.append(idea)

    # Sort by velocity desc
    deduped.sort(key=lambda x: x["velocity"], reverse=True)

    print(json.dumps({
        "ideas": deduped[:15],
        "niche": niche,
        "count": len(deduped),
        "sources": list(set(i["source"].split("_")[0] for i in deduped)),
    }))


if __name__ == "__main__":
    main()
