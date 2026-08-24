#!/usr/bin/env python3
"""Build the Gems school-branding directory from ESPN's open team APIs (no key).

For each sport it pulls every college team's official logo, team colors, mascot,
and abbreviation, then unions them by ESPN team id. ESPN uses a DIFFERENT team id
per sport for the same school, so a post-process should merge by normalized name
(union sports, keep the entry that has both logo + color) for a clean one-row-per-
school directory.

Output: schools.json  → load into public.schools (see gems_schools_directory
migration). Re-run periodically to refresh branding.

Usage:  python3 build-schools.py
"""
import json
import urllib.request

SPORTS = {
    "football": "football/college-football",
    "mbb": "basketball/mens-college-basketball",
    "wbb": "basketball/womens-college-basketball",
    "baseball": "baseball/college-baseball",
    "softball": "baseball/college-softball",
    "msoc": "soccer/usa.ncaa.m.1",
    "wsoc": "soccer/usa.ncaa.w.1",
    "hockey": "hockey/mens-college-hockey",
    "wvb": "volleyball/womens-college-volleyball",
}


def fetch(path):
    url = f"https://site.api.espn.com/apis/site/v2/sports/{path}/teams?limit=2000"
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)["sports"][0]["leagues"][0]["teams"]


def main():
    schools = {}
    for key, path in SPORTS.items():
        try:
            teams = fetch(path)
        except Exception as e:  # noqa: BLE001
            print(f"  ({key}: {str(e)[:40]})")
            continue
        for t in teams:
            tm = t["team"]
            tid = tm.get("id")
            if not tid:
                continue
            s = schools.setdefault(tid, {
                "id": tid,
                "name": tm.get("location") or tm.get("displayName"),
                "display": tm.get("displayName"),
                "mascot": tm.get("name"),
                "abbrev": tm.get("abbreviation"),
                "color": tm.get("color"),
                "alt_color": tm.get("alternateColor"),
                "logo": (tm.get("logos") or [{}])[0].get("href"),
                "sports": set(),
            })
            s["sports"].add(key)
        print(f"{key}: {len(teams)} teams")
    for s in schools.values():
        s["sports"] = sorted(s["sports"])
    rows = list(schools.values())
    json.dump(rows, open("schools.json", "w"))
    print(f"\nUNIQUE ROWS: {len(rows)}")


if __name__ == "__main__":
    main()
