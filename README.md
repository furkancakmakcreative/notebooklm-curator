# notebooklm-curator

An MCP server that **audits and prunes** Gemini Notebook (formerly NotebookLM) libraries.

Off-the-shelf NotebookLM MCPs give you `add_source` and `ask_question`. None of them give you these three:

| Tool | What it does | In other NotebookLM MCPs |
|---|---|---|
| `nlm_list_sources` | Lists the sources in a notebook | ✗ missing |
| `nlm_remove_source` | Deletes a source | ✗ missing |
| `nlm_audit` | Flags stale sources by shelf life | ✗ missing |

Also included: `nlm_auth`, `nlm_list_notebooks`, `nlm_create_notebook`, `nlm_add_source`, `nlm_ask`.

---

## Why browser automation

NotebookLM has **no public API** on the consumer side. Source lists, publish dates,
and deletion are not reachable over HTTP. The Gemini Notebook Enterprise API on
Google Cloud is a separate product that needs an enterprise account.

So the only way in is a persistent Chrome profile. Every selector lives in one
file, `src/notebooklm.js` — when Google ships a UI change, that's the only file
that needs an update.

Selectors were verified live against notebooklm.google.com on 2026-07-29.

---

## Requirements

- **Node.js 20+**
- **Google Chrome installed** (Windows or macOS — the standard desktop app
  from [google.com/chrome](https://www.google.com/chrome/)). This tool
  automates your real Chrome install on purpose, not a downloaded Chromium
  build: patchright's anti-detection patches are far more effective against
  NotebookLM's bot checks when running inside an actual Chrome, so we don't
  trade that away for a "works anywhere" default. If Chrome isn't found,
  `nlm_auth`/any tool call fails immediately with a clear message instead of
  a cryptic browser-launch error.
- Tested on Windows and macOS. Linux is not a current target.

## Setup

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/notebooklm-curator.git
cd notebooklm-curator
npm install
```

Copy `.env.example` to `.env` if you want `nlm_audit`'s YouTube date resolution:

```
YOUTUBE_API_KEY=your_own_key
```

> The key stays on your machine. The server only sends it to `googleapis.com`
> and never logs or forwards it elsewhere.

### Connecting to Claude Desktop / Claude Code

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or the equivalent
config on macOS/Linux:

```json
{
  "mcpServers": {
    "notebooklm-curator": {
      "command": "node",
      "args": ["/full/path/to/notebooklm-curator/src/index.js"],
      "env": { "YOUTUBE_API_KEY": "your_own_key" }
    }
  }
}
```

Fully restart Claude Desktop. On first use, call `nlm_auth`: a visible Chrome
window opens, you sign in with your Google account once, and the session is
saved to a persistent local profile. Every run after that is headless.

---

## Getting a YouTube API key

Google Cloud Console → **APIs & Services**

1. **Library** → search "YouTube Data API v3" → **Enable**
2. **Credentials** → **Create credentials** → **API key**
3. Click the key → **API restrictions** → *Restrict key* → select only
   **YouTube Data API v3** → Save

Don't skip step 3. If a restricted key ever leaks, it can only read public
YouTube data — it can't touch your account or spend money.

### Quota — this matters

The free daily quota is 10,000 units:

- `videos.list` → **1 unit** per call (up to 50 videos)
- `search.list` → **100 units** per call (one title)

NotebookLM never exposes a source's URL, so the **first audit** has to search
by title: 83 sources ≈ 8,300 units, most of the daily quota. But that search
returns a `videoId`. Save it and pass it back to `nlm_audit` as `knownIds` —
every later audit then uses the cheap `videos.list` path, ~2 units total.

The `searchBudget` parameter caps this cost (default 60).

---

## Shelf-life policy

A single global "40 days" threshold gets the wrong answer both ways: a model
announcement is dead in three weeks; a typography video is still useful in
three years. Shelf life is therefore a function of category:

| Category | Days | What lands here |
|---|---|---|
| `news` | 30 | announcements, release notes, weekly roundups |
| `tactics` | 45 | rate limits, model ranking/picking advice tied to a moving target |
| `tool` | 60 | tool usage, workflow tied to a specific release |
| `official` | 150 | Anthropic/Claude official product-feature videos |
| `tutorial` | 120 | courses, walkthroughs, technical deep-dives |
| `principle` | 1095 | theory, strategy, timeless craft |

`nlm_audit` guesses a category from the title heuristically; override any
threshold with the `categories` parameter:

```json
{ "notebookId": "...", "categories": { "news": 14, "tool": 45 } }
```

Status values: `fresh` → `aging` (75% of shelf life burned) → `stale`.
Sources whose date can't be resolved are `unknown` — a date is never guessed.

By default the response only gives you counts for `fresh`/`pinned` sources,
not their full per-item detail — you rarely need to see the sources that
need no action. Pass `includeFresh: true` to get everything, e.g. for a
full-library export.

---

## Delete safety

`nlm_remove_source` is irreversible and refuses to run without `confirm: true`.
`nlm_audit` never deletes anything — it only produces a report.

Intended flow: `nlm_audit` → show the list to the user → call
`nlm_remove_source` one title at a time for what they approve. The model
bulk-deleting on its own is blocked by design.

---

## How `nlm_ask` actually detects "the answer is done"

This turned out to be the hardest part of the tool, worth documenting because
the wrong approach *looks* like it works until it silently doesn't.

The first instinct is to poll `document.querySelector('main').innerText` until
it stops changing. That's wrong: NotebookLM's chat panel renders **outside**
`<main>` entirely. The text there never changes, so the polling loop reports
"stable" almost instantly and returns whatever happens to be sitting in
`<main>` at that moment — in one observed case, hidden emoji-picker markup
that had nothing to do with the question asked.

The actual reliable signal is a `.thinking-message` element (it carries an
`is-changing` class while streaming) detaching from the DOM once the model
finishes. Even then, the query textarea's `disabled` attribute clears
slightly *after* that detachment — firing the next question too early hits a
still-disabled box and hangs. `ask()` in `src/notebooklm.js` waits for both,
in order, before reading the last `.chat-message-pair`'s answer text.

If you're extending this tool and NotebookLM's DOM changes again, that's the
one thing worth re-verifying live before touching anything else. If a wait
times out, `nlm_ask` sets `incomplete: true` on its response rather than
silently returning stale or partial text as if it were final.

---

## Known limitations

- **Source URLs are not readable.** NotebookLM never puts them in the DOM —
  no href, no data attribute, clicking a row doesn't reveal one either. Titles
  are used as the identifier instead, so two sources with an identical title
  can't be told apart (`findDuplicates` reports these separately).
- **The delete confirmation dialog** may or may not appear depending on
  rollout; the code handles both and verifies the source count afterward.
  `removeSource` re-checks the target row's title immediately before acting
  on it, but a full guarantee against the list reordering mid-click isn't
  possible with index-based targeting alone.
- **UI text matching is English/Turkish only.** Menu items, buttons, and the
  category-guessing heuristics in `policy.js` match against those two
  languages; a notebook in a third UI language may fail to categorize or to
  find the "remove" menu item.
- **Freshness dates only resolve for YouTube sources today.** Web pages and
  PDFs always come back `unknown` — there's no per-page date extraction yet.
- Fixed `waitForTimeout` calls are used in a few places instead of polling
  for a DOM signal; on a slow connection they can under-wait, on a fast one
  they add latency. `ask()` uses the more robust polling pattern — anything
  ported from `removeSource`/`addSource` should follow that model instead.
- If Google changes the UI, `src/notebooklm.js` is the only file that needs
  updating.
- This is not an official integration. Consider using a separate Google
  account rather than your primary one — the `account` parameter supports
  multiple profiles.

## Roadmap

Ideas that didn't make v0.1, roughly in order of value:

- Export an `nlm_audit` report to Markdown/CSV for offline review.
- A batch-delete tool that takes a pre-approved list of `{title, occurrence}`
  pairs (still gated by an explicit human-approved list, not autonomous).
- Cross-notebook source search/duplicate detection (`findDuplicates` already
  generalizes to this — it just isn't wired up across notebooks yet).
- Date resolution for web sources via `Last-Modified` headers or
  `article:published_time` / JSON-LD `datePublished` metadata.

Contributions on any of these are welcome.

## License

MIT
