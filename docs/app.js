// TLDR Reader: renders the JSON written by scraper/scrape.py.

const DAYS_PER_PAGE = 7;
const MAX_SEARCH_RESULTS = 300;

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  newsletters: {},
  days: [],            // all available dates, newest first
  searchMonths: [],    // months with a search file, newest first
  loaded: [],          // [{date, issues}] fetched so far
  archive: null,       // every story (from data/search/*.json), loaded on first search
  archiveLoading: null,
  selected: new Set(store.get("selected", [])),  // empty = all
  hideSponsored: store.get("hideSponsored", true),
  savedOnly: false,
  topicsOnly: store.get("topicsOnly", false),
  topics: store.get("topics", []),
  query: "",
  saved: store.get("saved", {}),   // key -> story
  read: new Set(store.get("read", [])),
};

const $ = (id) => document.getElementById(id);
const keyOf = (s) => s.key || s.url;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Topics match whole words ("AI" doesn't match "said"); search terms match anywhere.
function topicRegex(topic) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(topic)}(?![\\p{L}\\p{N}])`, "iu");
}
let topicRes = [];
function setTopics(list) {
  state.topics = list;
  topicRes = list.map((t) => ({ topic: t, re: topicRegex(t) }));
}
function topicsFor(s) {
  const text = `${s.title} ${s.summary}`;
  return topicRes.filter(({ re }) => re.test(text)).map(({ topic }) => topic);
}

function highlight(text, terms, topics) {
  // Mark ranges in the raw text first, then escape, so tags never get mangled.
  const ranges = [];
  const add = (re, cls) => { for (const m of text.matchAll(re)) if (m[0]) ranges.push([m.index, m.index + m[0].length, cls]); };
  for (const t of terms) add(new RegExp(escapeRe(t), "gi"), "q");
  for (const t of topics) add(new RegExp(topicRegex(t).source, "giu"), "t");
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "", pos = 0;
  for (const [start, end, cls] of ranges) {
    if (start < pos) continue;
    out += escapeHtml(text.slice(pos, start)) + `<mark class="${cls}">${escapeHtml(text.slice(start, end))}</mark>`;
    pos = end;
  }
  return out + escapeHtml(text.slice(pos));
}

function formatDay(date) {
  const d = new Date(date + "T12:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function loadMoreDays() {
  const next = state.days.slice(state.loaded.length, state.loaded.length + DAYS_PER_PAGE);
  const results = await Promise.all(next.map((d) => fetchJson(`data/${d}.json`).catch(() => ({ date: d, issues: {} }))));
  state.loaded.push(...results);
  render();
}

function loadArchive() {
  if (!state.archiveLoading) {
    state.archiveLoading = Promise.all(
      state.searchMonths.map((m) => fetchJson(`data/search/${m}.json`).catch(() => ({ fields: [], rows: [] })))
    ).then((files) => {
      state.archive = files.flatMap(({ fields, rows }) =>
        rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])))
      );
      render();
    });
  }
  return state.archiveLoading;
}

// Stories from the loaded days, with repeats (same story in several newsletters) merged.
function dayStories() {
  const byKey = new Map();
  for (const day of state.loaded) {
    for (const [slug, stories] of Object.entries(day.issues)) {
      for (const s of stories) {
        const k = keyOf(s);
        const existing = byKey.get(k);
        if (existing) {
          if (!existing.newsletters.includes(slug)) existing.newsletters.push(slug);
          continue;
        }
        byKey.set(k, { ...s, newsletters: [slug] });
      }
    }
  }
  return [...byKey.values()];
}

function sourceStories() {
  if (state.savedOnly) return Object.values(state.saved);
  if (state.query.trim() && state.archive) return state.archive;
  return dayStories();
}

function inSelectedNewsletters(s) {
  const nls = s.newsletters || [s.newsletter];
  return !state.selected.size || nls.some((n) => state.selected.has(n));
}

function matches(s, terms) {
  if (!inSelectedNewsletters(s)) return false;
  if (state.hideSponsored && s.sponsored) return false;
  if (state.topicsOnly && !topicsFor(s).length) return false;
  if (!terms.length) return true;
  const hay = `${s.title} ${s.summary} ${s.section}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function renderChips(stories) {
  const counts = {};
  for (const s of stories) {
    if (state.hideSponsored && s.sponsored) continue;
    for (const n of s.newsletters || [s.newsletter]) counts[n] = (counts[n] || 0) + 1;
  }
  const chip = (slug, label, pressed, n) =>
    `<button class="chip" data-slug="${slug}" aria-pressed="${pressed}">${escapeHtml(label)}${n != null ? `<span class="n">${n}</span>` : ""}</button>`;
  const present = Object.keys(state.newsletters).filter((slug) => counts[slug] || state.selected.has(slug));
  $("chips").innerHTML =
    chip("", "All", state.selected.size === 0) +
    present.map((slug) => chip(slug, state.newsletters[slug].replace(/^TLDR /, "") || "Tech", state.selected.has(slug), counts[slug] || 0)).join("");
}

function storyHtml(s, terms, showDate) {
  const nls = s.newsletters || [s.newsletter];
  const hits = topicsFor(s);
  const meta = [
    nls.map((n) => `<span class="nl">${escapeHtml(state.newsletters[n] || n)}</span>`).join(""),
    s.section && `<span>${escapeHtml(s.section)}</span>`,
    s.read_minutes && `<span>${s.read_minutes} min read</span>`,
    s.kind && s.kind !== "sponsor" && `<span>${escapeHtml(s.kind)}</span>`,
    s.sponsored && `<span class="sp">Sponsored</span>`,
    showDate && `<span>${escapeHtml(s.date)}</span>`,
    ...hits.map((t) => `<span class="topic">★ ${escapeHtml(t)}</span>`),
  ].filter(Boolean).join("");
  const k = keyOf(s);
  const saved = !!state.saved[k];
  return `<article class="story${state.read.has(k) ? " read" : ""}${hits.length ? " hit" : ""}">
    <div class="meta">${meta}</div>
    <h3><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" data-key="${escapeHtml(k)}">${highlight(s.title, terms, hits)}</a></h3>
    <p>${highlight(s.summary, terms, hits)}</p>
    <div class="actions"><button class="save" data-key="${escapeHtml(k)}" aria-pressed="${saved}">${saved ? "★ Saved" : "☆ Save"}</button></div>
  </article>`;
}

let visible = new Map(); // key -> story currently on screen (for Save)

function render() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0 && !state.savedOnly;
  if (searching && !state.archive) loadArchive();

  const source = sourceStories();
  renderChips(source);

  const all = source.filter((s) => matches(s, terms));
  const shown = all.slice(0, searching ? MAX_SEARCH_RESULTS : undefined);
  visible = new Map(shown.map((s) => [keyOf(s), s]));

  const byDay = new Map();
  for (const s of shown) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }
  const days = [...byDay.keys()].sort().reverse();
  $("feed").innerHTML = days
    .map((d) => `<section class="day"><h2>${formatDay(d)}</h2>${byDay.get(d).map((s) => storyHtml(s, terms, false)).join("")}</section>`)
    .join("");

  const n = all.length;
  const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  let status;
  if (state.savedOnly) status = n ? `${n} saved stor${n === 1 ? "y" : "ies"}` : "Nothing saved yet. Use ☆ Save on any story.";
  else if (searching && !state.archive) status = `Searching the last ${plural(state.loaded.length, "day")}… loading the full archive`;
  else if (searching) status = n ? `${n} match${n === 1 ? "" : "es"} across ${plural(state.days.length, "day")}${n > shown.length ? ` (showing newest ${shown.length})` : ""}` : "No stories match.";
  else status = n ? `${n} stor${n === 1 ? "y" : "ies"} from the last ${plural(state.loaded.length, "day")}` : "No stories match.";
  $("status").textContent = status;
  $("more").hidden = searching || state.savedOnly || state.loaded.length >= state.days.length;
}

function bindEvents() {
  let t;
  $("search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = e.target.value; render(); }, 150);
  });
  $("hideSponsored").checked = state.hideSponsored;
  $("hideSponsored").addEventListener("change", (e) => { state.hideSponsored = e.target.checked; store.set("hideSponsored", state.hideSponsored); render(); });
  $("savedOnly").addEventListener("change", (e) => { state.savedOnly = e.target.checked; render(); });
  $("topicsOnly").checked = state.topicsOnly;
  $("topicsOnly").addEventListener("change", (e) => { state.topicsOnly = e.target.checked; store.set("topicsOnly", state.topicsOnly); render(); });
  $("more").addEventListener("click", () => loadMoreDays());

  $("topics").value = state.topics.join(", ");
  $("topics").addEventListener("change", (e) => {
    const list = [...new Set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))];
    setTopics(list);
    store.set("topics", list);
    e.target.value = list.join(", ");
    render();
  });

  $("chips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const slug = btn.dataset.slug;
    if (!slug) state.selected.clear();
    else if (state.selected.has(slug)) state.selected.delete(slug);
    else state.selected.add(slug);
    store.set("selected", [...state.selected]);
    render();
  });

  $("feed").addEventListener("click", (e) => {
    const save = e.target.closest(".save");
    if (save) {
      const k = save.dataset.key;
      if (state.saved[k]) delete state.saved[k];
      else if (visible.get(k)) state.saved[k] = visible.get(k);
      store.set("saved", state.saved);
      render();
      return;
    }
    const link = e.target.closest("a[data-key]");
    if (link) {
      state.read.add(link.dataset.key);
      store.set("read", [...state.read].slice(-3000));
      link.closest(".story").classList.add("read");
    }
  });
}

async function init() {
  setTopics(state.topics);
  bindEvents();
  try {
    const index = await fetchJson("data/index.json");
    state.newsletters = index.newsletters;
    state.days = index.days;
    state.searchMonths = index.search_months || [];
    if (index.updated) $("updated").textContent = `Updated ${new Date(index.updated).toLocaleString()}`;
    if (!state.days.length) {
      $("status").textContent = "No issues fetched yet. Run the scraper (see README).";
      return;
    }
    await loadMoreDays();
  } catch (err) {
    $("status").textContent = `Could not load data: ${err.message}`;
  }
}

init();
