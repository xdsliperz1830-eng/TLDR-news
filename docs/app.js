// TLDR Reader: renders the JSON written by scraper/scrape.py.

const DAYS_PER_PAGE = 7;

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
  loaded: [],          // [{date, issues}] fetched so far
  selected: new Set(store.get("selected", [])),  // empty = all
  hideSponsored: store.get("hideSponsored", true),
  savedOnly: false,
  query: "",
  saved: store.get("saved", {}),   // url -> story
  read: new Set(store.get("read", [])),
};

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const t of terms) {
    const re = new RegExp(`(${escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return html;
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

function allStories() {
  if (state.savedOnly) return Object.values(state.saved);
  return state.loaded.flatMap((day) => Object.values(day.issues).flat());
}

function matches(story, terms) {
  if (state.selected.size && !state.selected.has(story.newsletter)) return false;
  if (state.hideSponsored && story.sponsored) return false;
  if (!terms.length) return true;
  const hay = `${story.title} ${story.summary} ${story.section}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function renderChips() {
  const counts = {};
  for (const s of allStories()) {
    if (state.hideSponsored && s.sponsored) continue;
    counts[s.newsletter] = (counts[s.newsletter] || 0) + 1;
  }
  const chip = (slug, label, pressed, n) =>
    `<button class="chip" data-slug="${slug}" aria-pressed="${pressed}">${escapeHtml(label)}${n != null ? `<span class="n">${n}</span>` : ""}</button>`;
  const present = Object.keys(state.newsletters).filter((slug) => counts[slug] || state.selected.has(slug));
  $("chips").innerHTML =
    chip("", "All", state.selected.size === 0) +
    present.map((slug) => chip(slug, state.newsletters[slug].replace(/^TLDR /, "") || "Tech", state.selected.has(slug), counts[slug] || 0)).join("");
}

function storyHtml(s, terms) {
  const name = state.newsletters[s.newsletter] || s.newsletter;
  const meta = [
    `<span class="nl">${escapeHtml(name)}</span>`,
    s.section && `<span>${escapeHtml(s.section)}</span>`,
    s.read_minutes && `<span>${s.read_minutes} min read</span>`,
    s.kind && s.kind !== "sponsor" && `<span>${escapeHtml(s.kind)}</span>`,
    s.sponsored && `<span class="sp">Sponsored</span>`,
    state.savedOnly && `<span>${escapeHtml(s.date)}</span>`,
  ].filter(Boolean).join("");
  const saved = !!state.saved[s.url];
  return `<article class="story${state.read.has(s.url) ? " read" : ""}">
    <div class="meta">${meta}</div>
    <h3><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" data-url="${escapeHtml(s.url)}">${highlight(s.title, terms)}</a></h3>
    <p>${highlight(s.summary, terms)}</p>
    <div class="actions"><button class="save" data-url="${escapeHtml(s.url)}" aria-pressed="${saved}">${saved ? "★ Saved" : "☆ Save"}</button></div>
  </article>`;
}

function render() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  renderChips();

  const stories = allStories().filter((s) => matches(s, terms));
  // Group by date (preserving newsletter order within a day), dedupe by URL.
  const byDay = new Map();
  const seen = new Set();
  for (const s of stories) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }
  const days = [...byDay.keys()].sort().reverse();

  $("feed").innerHTML = days
    .map((d) => `<section class="day"><h2>${formatDay(d)}</h2>${byDay.get(d).map((s) => storyHtml(s, terms)).join("")}</section>`)
    .join("");

  const total = stories.length;
  $("status").textContent = total
    ? `${total} stor${total === 1 ? "y" : "ies"}${state.savedOnly ? " saved" : ` from the last ${state.loaded.length} day${state.loaded.length === 1 ? "" : "s"}`}`
    : state.savedOnly ? "Nothing saved yet. Use ☆ Save on any story." : "No stories match.";
  $("more").hidden = state.savedOnly || state.loaded.length >= state.days.length;
}

function bindEvents() {
  $("search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
  $("hideSponsored").checked = state.hideSponsored;
  $("hideSponsored").addEventListener("change", (e) => { state.hideSponsored = e.target.checked; store.set("hideSponsored", state.hideSponsored); render(); });
  $("savedOnly").addEventListener("change", (e) => { state.savedOnly = e.target.checked; render(); });
  $("more").addEventListener("click", () => loadMoreDays());

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
      const url = save.dataset.url;
      if (state.saved[url]) delete state.saved[url];
      else state.saved[url] = allStories().find((s) => s.url === url) || state.saved[url];
      store.set("saved", state.saved);
      render();
      return;
    }
    const link = e.target.closest("a[data-url]");
    if (link) {
      state.read.add(link.dataset.url);
      store.set("read", [...state.read].slice(-2000));
      link.closest(".story").classList.add("read");
    }
  });
}

async function init() {
  bindEvents();
  try {
    const index = await fetchJson("data/index.json");
    state.newsletters = index.newsletters;
    state.days = index.days;
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
