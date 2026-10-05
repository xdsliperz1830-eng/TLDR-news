# TLDR Reader

A personal website that collects the [TLDR](https://tldr.tech) newsletters
from their public web archive and shows them as one filterable news feed.

- **Filter by newsletter** (TLDR, AI, Web Dev, InfoSec, …). Your choice is remembered.
- **Search** headlines and summaries across the whole archive, with matches highlighted.
- **My topics:** list words you care about (e.g. `Apple, Rust, security`); matching stories get a ★ badge,
  and *My topics only* shows just those.
- Stories that appear in several newsletters are shown once, labelled with each newsletter.
- **Hide sponsored** stories (on by default).
- **Save** stories for later and see them with *Saved only*. Stories you've opened are dimmed.

Saved stories and read history are kept in your browser (localStorage) only.

## How it works

```
scraper/scrape.py        fetches https://tldr.tech/<newsletter>/<date>, parses the stories
docs/data/<date>.json    one file per day, all newsletters combined
docs/data/index.json     list of available days
docs/data/search/        every story, de-duplicated, one file per month (used by search)
docs/                    the static website (index.html, app.js, style.css)
.github/workflows/       runs the scraper every 30 min; commits + redeploys only when there are new stories
```

## Setup (one time)

1. In the GitHub repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Go to **Actions → Update news and deploy site → Run workflow**. Enter `30` for
   *days* to backfill the last month.
3. The site will be at `https://<your-username>.github.io/<repo-name>/`.

After that it checks for new issues every 30 minutes. "Updated" on the site is when new stories last arrived.

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

The scraper depends on the HTML layout of tldr.tech. If an issue page can't be
parsed, or no issues are found for the last weekday, the workflow's **alert** job
fails and GitHub emails you, at most once a day (stories it did find are still saved and published). Fix `parse_issue()` in `scraper/scrape.py`
and update `tests/fixtures/ai-sample.html` to match.
