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
import hashlib
import html as htmllib
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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

        # Some hrefs are double-escaped in the page source ("&amp;amp;").
        url = htmllib.unescape(link["href"].strip())
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


# Query parameters that only track where a click came from. Dropping them lets the
# same story linked from two newsletters be recognised as one.
TRACKING_PARAM_RE = re.compile(r"^;?(utm_\w+|ref|ref_src|source|src|via|sp|trk|sc_channel|dub_id|campaign_id|gift|ncid|mc_cid|mc_eid|fbclid|gclid|accesstoken|smid)$", re.I)


def story_key(url: str) -> str:
    """Normalised URL used to spot the same story across newsletters."""
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not TRACKING_PARAM_RE.match(k)]
    host = parts.netloc.lower().removeprefix("www.")
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(("https", host, path, urlencode(query), ""))


def fetch_issue(session: requests.Session, slug: str, date: str) -> list[dict] | None:
    """Return the stories in one issue, or None if no issue was published that day.

    An empty list means the issue page exists but no stories could be parsed,
    which usually means tldr.tech changed its layout.
    """
    url = f"https://tldr.tech/{slug}/{date}"
    resp = session.get(url, headers=HEADERS, timeout=30)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    # Days without an issue redirect to the newsletter's landing page.
    if not resp.url.rstrip("/").endswith(date):
        return None
    return parse_issue(resp.text, slug, date)


def scrape_date(session: requests.Session, date: str, problems: list[str]) -> dict:
    issues = {}
    for slug, name in NEWSLETTERS.items():
        try:
            try:
                stories = fetch_issue(session, slug, date)
            except requests.RequestException:
                time.sleep(5)  # one retry for a flaky connection
                stories = fetch_issue(session, slug, date)
        except requests.RequestException as exc:
            print(f"  ! {slug} {date}: {exc}", file=sys.stderr)
            problems.append(f"{slug} {date}: request failed ({exc})")
            continue
        if stories:
            issues[slug] = stories
            print(f"  {name}: {len(stories)} stories")
        elif stories is not None:
            print(f"  ! {name}: page exists but no stories were parsed", file=sys.stderr)
            problems.append(f"{slug} {date}: page exists but no stories were parsed (layout change?)")
        time.sleep(0.5)  # be polite
    return issues


def load_days() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text()) for p in sorted(DATA_DIR.glob("????-??-??.json"))}


def add_keys(days: dict[str, dict]) -> None:
    """Make sure every saved story carries its dedupe key (older files predate it)."""
    for date, day in days.items():
        changed = False
        for stories in day["issues"].values():
            for s in stories:
                key = story_key(s["url"])
                if s.get("key") != key:
                    s["key"] = key
                    changed = True
        if changed:
            (DATA_DIR / f"{date}.json").write_text(json.dumps(day, indent=1, ensure_ascii=False) + "\n")


SEARCH_FIELDS = ["date", "newsletters", "title", "url", "summary", "section", "read_minutes", "kind", "sponsored", "key"]


def write_search_index(days: dict[str, dict]) -> list[str]:
    """Compact, de-duplicated story lists (one file per month) for searching the whole archive.

    Returns the months written, newest first.
    """
    seen: dict[str, list] = {}
    for date in sorted(days):  # oldest first, so a repeat keeps its first appearance
        for slug, stories in days[date]["issues"].items():
            for s in stories:
                if s["key"] in seen:
                    if slug not in seen[s["key"]][1]:
                        seen[s["key"]][1].append(slug)
                    continue
                seen[s["key"]] = [date, [slug], s["title"], s["url"], s["summary"], s["section"],
                                  s["read_minutes"], s.get("kind"), int(s["sponsored"]), s["key"]]
    by_month: dict[str, list] = {}
    for row in seen.values():
        by_month.setdefault(row[0][:7], []).append(row)
    search_dir = DATA_DIR / "search"
    search_dir.mkdir(exist_ok=True)
    for old in search_dir.glob("*.json"):
        if old.stem not in by_month:
            old.unlink()
    for month, rows in by_month.items():
        rows.sort(key=lambda r: r[0], reverse=True)
        out = {"fields": SEARCH_FIELDS, "rows": rows}
        (search_dir / f"{month}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    return sorted(by_month, reverse=True)


def data_fingerprint() -> str:
    """Hash of every saved story file, so 'updated' only moves when stories change."""
    h = hashlib.sha256()
    for p in sorted(DATA_DIR.rglob("*.json")):
        if p.name != "index.json":
            h.update(p.relative_to(DATA_DIR).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


def write_index(days: dict[str, dict], months: list[str]) -> None:
    path = DATA_DIR / "index.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    fingerprint = data_fingerprint()
    index = {
        "updated": old.get("updated"),
        "fingerprint": fingerprint,
        "newsletters": NEWSLETTERS,
        "days": sorted(days, reverse=True),
        "search_months": months,
    }
    if old.get("fingerprint") != fingerprint or {**old, "updated": None} != {**index, "updated": None}:
        index["updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    path.write_text(json.dumps(index, indent=1) + "\n")


def last_weekday_before(today: dt.date) -> dt.date:
    d = today - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=3,
                        help="how many recent days to fetch (default 3; 30 while under a week is saved)")
    parser.add_argument("--date", help="fetch a single YYYY-MM-DD date")
    parser.add_argument("--force", action="store_true", help="re-fetch days that are already saved")
    args = parser.parse_args()

    if args.date:
        dates = [args.date]
    else:
        days = args.days
        # First runs: backfill a month so the site isn't nearly empty.
        if len(list(DATA_DIR.glob("????-??-??.json"))) < 7:
            days = max(days, 30)
        today = dt.date.today()
        dates = [(today - dt.timedelta(days=i)).isoformat() for i in range(days)]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    problems: list[str] = []
    for date in dates:
        out = DATA_DIR / f"{date}.json"
        # Today's issues may still be arriving, so always refresh the last 2 days.
        recent = date >= (dt.date.today() - dt.timedelta(days=1)).isoformat()
        if out.exists() and not (args.force or recent):
            continue
        print(f"{date}:")
        issues = scrape_date(session, date, problems)
        if issues:
            out.write_text(json.dumps({"date": date, "issues": issues}, indent=1, ensure_ascii=False) + "\n")
        else:
            print("  (no issues)")

    saved = load_days()
    add_keys(saved)
    months = write_search_index(saved)
    write_index(saved, months)

    # Health check: TLDR publishes every weekday, so the last weekday should have issues.
    expected = last_weekday_before(dt.date.today()).isoformat()
    if not args.date and expected in dates and expected not in saved:
        problems.append(f"no issues found for {expected}, a weekday")
    if problems:
        print("\nPROBLEMS:", *problems, sep="\n  ", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
