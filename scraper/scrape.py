"""Fetch TLDR newsletter issues from the public web archive at tldr.tech.

Each issue lives at https://tldr.tech/<slug>/<YYYY-MM-DD>. Results are written
to docs/data/<YYYY-MM-DD>.json (one file per day, all newsletters combined) and
docs/data/index.json lists the available days, newest first.

Usage:
    python scraper/scrape.py                 # last 3 days
    python scraper/scrape.py --days 30       # backfill a month
    python scraper/scrape.py --date 2026-10-02
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
NEWSLETTERS = json.loads((Path(__file__).parent / "newsletters.json").read_text())

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; personal-tldr-reader/1.0)"}
READ_TIME_RE = re.compile(r"\s*\((\d+)\s+minute read\)\s*$", re.I)
TAG_RE = re.compile(r"\s*\((sponsor|github repo|website|tool|podcast|video)\)\s*$", re.I)


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def section_for(article: Tag) -> str:
    """Name of the section (e.g. "Big Tech & Startups") an article sits in."""
    section = article.find_parent("section")
    if section:
        heading = section.find(["h3", "h2"], class_=re.compile("text-center"))
        if heading and heading is not article.find("h3"):
            return clean(heading.get_text())
    prev = article.find_previous(["h3", "h2"], class_=re.compile("text-center"))
    return clean(prev.get_text()) if prev else ""


def parse_issue(html: str, slug: str, date: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    stories = []
    for article in soup.find_all("article"):
        link = article.find("a", href=True)
        title_el = article.find("h3") or link
        if not link or not title_el:
            continue
        raw_title = clean(title_el.get_text())
        if not raw_title:
            continue

        read_minutes = None
        m = READ_TIME_RE.search(raw_title)
        if m:
            read_minutes = int(m.group(1))
            raw_title = raw_title[: m.start()]
        kind = None
        m = TAG_RE.search(raw_title)
        if m:
            kind = m.group(1).lower()
            raw_title = raw_title[: m.start()]

        summary_el = article.find("div", class_="newsletter-html")
        if summary_el:
            summary = clean(summary_el.get_text(" "))
        else:
            # Fallback: everything in the article except the title.
            title_el.extract()
            summary = clean(article.get_text(" "))

        url = link["href"]
        section = section_for(article)
        sponsored = kind == "sponsor" or "sponsor" in section.lower() or "utm_campaign=sponsor" in url.lower()
        stories.append(
            {
                "newsletter": slug,
                "date": date,
                "section": section,
                "title": clean(raw_title),
                "url": url,
                "summary": summary,
                "read_minutes": read_minutes,
                "kind": kind,
                "sponsored": sponsored,
            }
        )
    return stories


def fetch_issue(session: requests.Session, slug: str, date: str) -> list[dict] | None:
    """Return the stories in one issue, or None if no issue was published that day."""
    url = f"https://tldr.tech/{slug}/{date}"
    resp = session.get(url, headers=HEADERS, timeout=30)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    # Days without an issue redirect to the newsletter's landing page.
    if not resp.url.rstrip("/").endswith(date):
        return None
    stories = parse_issue(resp.text, slug, date)
    return stories or None


def scrape_date(session: requests.Session, date: str) -> dict:
    issues = {}
    for slug, name in NEWSLETTERS.items():
        try:
            stories = fetch_issue(session, slug, date)
        except requests.RequestException as exc:
            print(f"  ! {slug} {date}: {exc}", file=sys.stderr)
            continue
        if stories:
            issues[slug] = stories
            print(f"  {name}: {len(stories)} stories")
        time.sleep(0.5)  # be polite
    return issues


def write_index() -> None:
    days = sorted((p.stem for p in DATA_DIR.glob("????-??-??.json")), reverse=True)
    index = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "newsletters": NEWSLETTERS,
        "days": days,
    }
    (DATA_DIR / "index.json").write_text(json.dumps(index, indent=1) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=3, help="how many recent days to fetch (default 3)")
    parser.add_argument("--date", help="fetch a single YYYY-MM-DD date")
    parser.add_argument("--force", action="store_true", help="re-fetch days that are already saved")
    args = parser.parse_args()

    if args.date:
        dates = [args.date]
    else:
        today = dt.date.today()
        dates = [(today - dt.timedelta(days=i)).isoformat() for i in range(args.days)]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    for date in dates:
        out = DATA_DIR / f"{date}.json"
        # Today's issues may still be arriving, so always refresh the last 2 days.
        recent = date >= (dt.date.today() - dt.timedelta(days=1)).isoformat()
        if out.exists() and not (args.force or recent):
            continue
        print(f"{date}:")
        issues = scrape_date(session, date)
        if issues:
            out.write_text(json.dumps({"date": date, "issues": issues}, indent=1, ensure_ascii=False) + "\n")
        else:
            print("  (no issues)")
    write_index()


if __name__ == "__main__":
    main()
