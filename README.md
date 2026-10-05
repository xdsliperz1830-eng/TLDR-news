# TLDR Reader

A personal website that collects the [TLDR](https://tldr.tech) newsletters
from their public web archive and shows them as one filterable news feed.

- **Filter by newsletter** (TLDR, AI, Web Dev, InfoSec, …). Your choice is remembered.
- **Search** headlines and summaries, with matches highlighted.
- **Hide sponsored** stories (on by default).
- **Save** stories for later and see them with *Saved only*. Stories you've opened are dimmed.

Saved stories and read history are kept in your browser (localStorage) only.

## How it works

```
scraper/scrape.py        fetches https://tldr.tech/<newsletter>/<date>, parses the stories
docs/data/<date>.json    one file per day, all newsletters combined
docs/data/index.json     list of available days
docs/                    the static website (index.html, app.js, style.css)
.github/workflows/       runs the scraper 3x a day, commits new data, deploys to GitHub Pages
```

## Setup (one time)

1. In the GitHub repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Go to **Actions → Update news and deploy site → Run workflow**. Enter `30` for
   *days* to backfill the last month.
3. The site will be at `https://<your-username>.github.io/<repo-name>/`.

After that it updates itself every day.

## Choosing newsletters

Edit `scraper/newsletters.json`. Remove the ones you don't want, or add others
using the slug from the tldr.tech URL (e.g. `tldr.tech/ai/...` → `"ai"`).
Slugs that don't publish on a given day are skipped.

## Running locally

```sh
pip install -r requirements.txt
python scraper/scrape.py --days 7        # fetch the last week
python tests/test_parse.py               # parser test
python -m http.server -d docs 8000       # open http://localhost:8000
```

## If stories stop showing up

The scraper depends on the HTML layout of tldr.tech. If TLDR redesigns it, the
workflow will run but find no stories. Fix `parse_issue()` in `scraper/scrape.py`
and update `tests/fixtures/ai-sample.html` to match.
