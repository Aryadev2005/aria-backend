#!/usr/bin/env python3
"""
Instagram Profile Scraper
Requires: instaloader
Usage: python3 scrape_instagram.py <handle>
Output: Valid JSON to stdout, all errors to stderr
"""

import sys
import json
import re
from datetime import datetime, timedelta

def scrape_instagram_profile(handle):
    """
    Fetch Instagram profile data using instaloader
    Returns JSON with profile stats and last 20 posts
    """
    try:
        import instaloader
    except ImportError:
        print(json.dumps({
            "error": "instaloader not installed",
            "hint": "Install with: pip install instaloader"
        }), file=sys.stderr)
        sys.exit(1)

    try:
        loader = instaloader.Instaloader(
            download_pictures=False,
            download_videos=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=True,
        )

        profile = instaloader.Profile.from_username(loader.context, handle)

        # Handle private profiles
        if profile.is_private:
            print(json.dumps({
                "isPrivate": True,
                "error": "Profile is private"
            }))
            sys.exit(0)

        # Fetch posts
        posts_data = []
        post_count = 0

        for post in profile.get_posts():
            if post_count >= 20:
                break

            hashtags = re.findall(r'#\w+', post.caption or '')
            post_data = {
                "type": "video" if post.is_video else "reel" if post.is_video else "photo",
                "likes": post.likes,
                "comments": post.comments,
                "caption": post.caption[:200] if post.caption else "",
                "hashtags": hashtags[:15],
                "timestamp": post.date.isoformat(),
                "videoDuration": post.video_duration if post.is_video else None,
            }
            posts_data.append(post_data)
            post_count += 1

        # Compute statistics
        total_likes = sum(p["likes"] for p in posts_data)
        total_comments = sum(p["comments"] for p in posts_data)
        avg_likes = total_likes / len(posts_data) if posts_data else 0
        avg_comments = total_comments / len(posts_data) if posts_data else 0

        # Estimate posts per week
        if posts_data:
            oldest_post_date = datetime.fromisoformat(posts_data[-1]["timestamp"])
            newest_post_date = datetime.fromisoformat(posts_data[0]["timestamp"])
            days_span = (newest_post_date - oldest_post_date).days or 1
            posts_per_week = (len(posts_data) / days_span) * 7
        else:
            posts_per_week = 0

        # Extract top hashtags
        all_hashtags = []
        for post in posts_data:
            all_hashtags.extend(post["hashtags"])
        hashtag_counts = {}
        for tag in all_hashtags:
            hashtag_counts[tag] = hashtag_counts.get(tag, 0) + 1
        top_hashtags = sorted(hashtag_counts.items(), key=lambda x: x[1], reverse=True)[:10]
        top_hashtags = [tag for tag, count in top_hashtags]

        result = {
            "followers": profile.followers,
            "following": profile.followees,
            "totalPosts": profile.mediacount,
            "posts": posts_data,
            "postsPerWeek": round(posts_per_week, 1),
            "topHashtags": top_hashtags,
            "isPrivate": False,
            "avgLikes": round(avg_likes, 1),
            "avgComments": round(avg_comments, 1),
        }

        print(json.dumps(result))
        sys.exit(0)

    except instaloader.InstaloaderException as e:
        error_msg = str(e)
        if "does not exist" in error_msg or "not found" in error_msg:
            print(json.dumps({
                "error": "Profile not found",
                "isPrivate": False,
            }), file=sys.stderr)
            sys.exit(1)
        elif "private" in error_msg.lower():
            print(json.dumps({
                "isPrivate": True,
                "error": "Profile is private"
            }))
            sys.exit(0)
        else:
            print(json.dumps({
                "error": error_msg,
                "details": "Could not scrape profile"
            }), file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "details": "Unexpected error during scraping"
        }), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: python3 scrape_instagram.py <handle>",
            "example": "python3 scrape_instagram.py cristiano"
        }), file=sys.stderr)
        sys.exit(1)

    handle = sys.argv[1]

    # Validate handle
    if not re.match(r'^[a-zA-Z0-9_.]+$', handle):
        print(json.dumps({
            "error": "Invalid Instagram handle format"
        }), file=sys.stderr)
        sys.exit(1)

    scrape_instagram_profile(handle)
