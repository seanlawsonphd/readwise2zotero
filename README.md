# Readwise Sync for Zotero

A Zotero plugin that imports your **entire Readwise library** into Zotero —
both [Readwise Reader](https://readwise.io/read) documents (articles, PDFs,
epubs, videos) *and* your classic Readwise library (Kindle books, KOReader,
Apple Books, podcasts, saved tweets) — as properly-typed items with formatted
highlight notes. It can also enrich their citation metadata using Zotero's
own site translators, bibliographic databases, and (optionally) an AI model
of your choice, including fully local ones.

**Requires:** Zotero 8 or later (developed and tested on Zotero 9) and a
Readwise account.

---

## Features

- **One-click sync of both Readwise libraries** (Tools → Sync from Readwise):
  every Reader document with at least one highlight becomes a Zotero item,
  and every book, podcast, or tweet in your classic Readwise library syncs
  alongside — filed into a collection of your choice, with source metadata
  mapped to the right fields and item types (Kindle book → book, podcast →
  podcast, tweet → forum post, article → webpage, …).
- **Position-linked book highlights**: quotes from Kindle/KOReader books
  carry `(Page 12)` / `(Location 1042)` links that open the highlight in
  Readwise; Reader quotes link as `(View Highlight)`.
- **Formatted highlight notes** following Readwise's own export conventions —
  heading markers, concatenation markers, your annotations as headings, and a
  "View Highlight" link back to Reader for every quote.
- **Incremental and non-destructive**: re-syncs only fetch what changed, new
  highlights are appended to existing notes under a dated header, and nothing
  you've edited in Zotero is overwritten.
- **Metadata enrichment** (right-click → Enrich Metadata (Readwise Sync)): fills
  empty fields using Zotero's ~600 site translators; falls back to an AI
  model when translators come up empty.
- **Book-aware enrichment**: books are resolved through Open Library and
  library catalogs (WorldCat, Library of Congress) via ISBN, with an Amazon
  fallback using Zotero's Amazon translator.
- **Bring your own AI**: Anthropic, OpenAI, Google Gemini, Ollama (local or
  cloud), oMLX, or any OpenAI-compatible local server (LM Studio, MLX). Local
  models keep everything on your machine.
- **Optional background auto-sync** on an interval you choose.

---

## Installation

1. Download `readwise-sync-for-zotero.xpi` (or build it from source — see
   [Building](#building-from-source)).
2. In Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and
   select the `.xpi`.
3. Restart Zotero after first install so the settings pane registers.

## Setup

1. Get your Readwise access token from
   <https://readwise.io/access_token> (you must be logged in).
2. In Zotero: **Settings → Readwise** → paste the token.
3. Optionally change the target collection name (default: `Readwise`; created
   automatically if it doesn't exist).
4. Run **Tools → Sync from Readwise**.

The first sync imports both libraries. The Reader phase can take a while
(each Reader document needs its own metadata request, and Readwise's API is
rate-limited to roughly 20 requests/minute — the plugin waits and retries
automatically, and the progress popup shows what it's doing). The classic
phase is much faster: the export API returns books with highlights nested,
so even thousands of Kindle highlights import in a handful of requests.
Subsequent syncs only fetch changes and typically finish in seconds.

---

## Usage

### Syncing

| Action | What it does |
|---|---|
| **Tools → Sync from Readwise** | Incremental sync: processes highlights new or changed since the last sync. |
| **Tools → Sync from Readwise (Full Rescan)** | Re-examines every highlight in your Readwise library. Use after restoring a library or if things seem out of sync. Never creates duplicates. |
| **Settings → Readwise → Sync automatically** | Runs the incremental sync in the background on a configurable interval (default 60 min, minimum 15). |

### Enriching metadata

Select one or more items (any items with URLs — not just Readwise imports),
right-click → **Enrich Metadata (Readwise Sync)**. A progress popup reports the
outcome per batch: `enriched` (site translators), `AI-enriched` (AI
fallback), `no new data`, `without URL`, or `failed`.

### AI providers

Configured in **Settings → Readwise → AI Enrichment**. The AI is only used
as a *fallback* when Zotero's site translators find nothing useful on a page,
and only when the selected provider is configured.

| Provider | Needs | Notes |
|---|---|---|
| Anthropic (Claude) | API key from console.anthropic.com | Haiku 4.5 (default), Sonnet 5, or Opus 4.8 |
| OpenAI | API key | Model name is free text |
| Google Gemini | AI Studio API key | Via Google's OpenAI-compatible endpoint |
| Ollama | Nothing (local) or an ollama.com key (cloud) | Model dropdown auto-populates from the server |
| oMLX | Nothing (key optional) | Apple Silicon inference server; dropdown auto-populates |
| Other local | A running LM Studio / MLX server | Base URL + model; dropdown auto-populates |

For the local providers, the model dropdowns query the server's
`/v1/models` endpoint when the settings pane opens (and on Refresh), and
remain editable text fields if the server is offline.

---

## How it works under the hood

Maximum transparency: this section documents exactly what the plugin does,
in the order it does it. Everything runs as JavaScript inside Zotero's own
process — there are no external scripts, subprocesses, or helper daemons.

### Sync pipeline

1. **Fetch highlights.** The plugin calls the Readwise Reader API v3
   (`readwise.io/api/v3/list/`) directly, authenticated with your token.
   Highlights in Reader are themselves documents (`category=highlight`) that
   point at a parent document; annotations are child documents
   (`category=note`). The plugin fetches both — incrementally, using an
   `updatedAfter` cursor stored in Zotero's preferences — and joins them.
   Readwise 429 rate-limit responses are honored by waiting the server's
   requested interval and retrying.
2. **Group by parent document** and fetch each parent's metadata (one API
   call per document, first run only — already-synced documents skip this).
3. **Dedupe.** Before creating anything, the plugin scans your library for
   items whose Extra field contains `Readwise-ID: <id>` — that marker is the
   permanent link between a Zotero item and its Reader document. This is why
   re-syncs and Full Rescans never duplicate.
4. **Create items** via Zotero's internal API (`new Zotero.Item(...)`,
   `item.saveTx()`), with this mapping:

   | Reader field | Zotero field |
   |---|---|
   | category | item type: article/RSS/email → webpage, pdf → document, epub → book, video → video recording, podcast → podcast, tweet → forum post, audiobook → audio recording |
   | title, author | title, creators (author string parsed into first/last names) |
   | source_url | URL |
   | published_date | date |
   | summary | abstract |
   | site_name | website title / forum title / studio / series title (by item type) |
   | saved_at | access date |
   | tags | tags |
   | id | `Readwise-ID:` line in Extra (plus a `Readwise-URL:` link to Reader) |

5. **Build the highlight note** (see [Note format](#note-format)) and attach
   it as a child note.
6. **Sync the classic library.** The plugin then calls the classic Readwise
   export API (`readwise.io/api/v2/export/`), which returns books with their
   highlights nested — covering Kindle, KOReader, Apple Books, podcasts, and
   anything else highlighted outside Reader. Classic entries whose source is
   `reader` are skipped (the Reader sync above already handled them), so
   nothing is duplicated. Deleted books and highlights are excluded.

   Classic mapping: category → item type (books → book, articles → webpage,
   tweets → forum post, podcasts → podcast); author → creators; summary →
   abstract; book tags → tags; ASIN and source recorded in Extra alongside
   the `Readwise-Book-ID:` dedupe marker and a `Readwise-URL:` link.
   Highlights are ordered by their position in the book, and each quote
   links as `(Page N)` / `(Location N)` (or `(View Highlight)` when the
   source has no position) pointing at `readwise.io/open/<highlight id>`.
   The classic library keeps its own incremental cursor (`lastSyncClassic`),
   so both phases stay cheap after the first run.
7. **Update existing items.** If a document was already synced and has new
   highlights, the plugin parses the existing note for the highlight IDs it
   already contains (each quote's "View Highlight" link carries its ID),
   renders only the genuinely new ones, and appends them under a
   `## New highlights added <date>` header. Nothing in the existing note is
   rewritten. Edits or deletions of old highlights in Reader are *not*
   propagated (append-only by design).

### Note format

Notes follow Readwise's export conventions, rendered as HTML (Zotero notes
are HTML):

- Each highlight is a `<blockquote>` ending with a location link: **(View
  Highlight)** for Reader documents, **(Page N)** / **(Location N)** for
  classic-library books — either way it opens that highlight in Readwise.
- A highlight whose annotation is `.h1` / `.h2` / `.h3` becomes a heading of
  that level (its text is the highlight text) instead of a quote.
- Consecutive highlights annotated `.c1`, `.c2`, … are concatenated into a
  single blockquote joined by ` [...] `.
- Any other annotation renders as an `<h3>` heading above its quote
  (first line), with subsequent lines as paragraphs.
- Highlight tags render as an italic `Tags:` line under the quote.

### Enrichment pipeline

When you enrich an item, the plugin tries these steps in order and stops at
the first one that yields data. **The merge is always conservative: only
empty fields are filled — nothing you already have is overwritten — except
the item type, which is upgraded only from a generic type (webpage/document)
to a more specific one. Highlight notes, tags, Extra, and access date are
never touched.**

**For books** (what Reader epubs sync as):

1. **Open Library work search** by title/author, with a title-overlap guard
   (no plausible match → no changes, rather than wrong data).
2. **Edition selection**: among the work's English editions with an ISBN-13,
   prefer the one published closest to the work's first publication year
   (this favors the original publisher's edition over reprints and
   print-on-demand copies).
3. **ISBN resolution through Zotero's identifier-search translators** — the
   same machinery as Zotero's "Add Item by Identifier" wand, drawing on
   WorldCat, the Library of Congress, and other catalogs. If that fails, the
   Open Library fields themselves (publisher, date, ISBN, pages, authors)
   are merged instead.
4. **Amazon fallback**: search Amazon's book section, load the first product
   page in Zotero's hidden browser, and run Zotero's Amazon translator on it
   — identical to clicking the Zotero connector on that page. A wrong-book
   guard rejects results whose title doesn't match. (Amazon occasionally
   serves bot-check pages; those simply fall through.)
5. If both book paths fail, the item continues to the webpage path below.

**For everything else (and books that fell through):**

1. **Load the item's URL** in Zotero's hidden browser
   (`Zotero.HTTP.processDocuments`) — a real Firefox page load inside the
   Zotero process, since Zotero is built on Firefox.
2. **Run Zotero's site translators** (`Zotero.Translate.Web`) against the
   loaded page — the same ~600 extractors that power the Zotero browser
   connector. Multi-item listing pages are skipped rather than guessed at.
3. **AI fallback** (only if a provider is configured *and* the translators
   found nothing useful — no authors, date, publication, or DOI): the
   visible text of the already-loaded page (up to 30,000 characters) is sent
   to your chosen model with a strict JSON schema requesting item type,
   title, creators, date, publication, publisher, DOI, and language. The
   prompt instructs the model to use only information present in the text.
   - Anthropic uses the native Messages API with structured outputs.
   - All other providers use the OpenAI-compatible `chat/completions`
     endpoint with `json_schema` response format; servers that reject it
     (some local ones) are retried in plain-JSON mode with the schema
     embedded in the prompt.

### Where your credentials live

All tokens and API keys are entered in the settings UI and stored in
**Zotero's preferences database inside your Zotero profile**
(`extensions.readwise2zotero.*` keys). They are never written into the
plugin code, the `.xpi`, or any file in this repository — sharing the plugin
shares no credentials. The plugin's `prefs.js` declares empty-string
defaults only.

### Network traffic summary

For full transparency, this is every network connection the plugin can make,
and when:

| Destination | When | What is sent |
|---|---|---|
| `readwise.io` | Every sync | Your Readwise token; requests for your Reader documents/highlights and classic-library export |
| The item's own URL | Enrichment only | A normal page request (no cookies from your browser profile) |
| `openlibrary.org` | Book enrichment only | Title/author search terms |
| Library catalogs (WorldCat etc.) | Book enrichment, via Zotero's ISBN translators | The ISBN |
| `amazon.com` | Book enrichment fallback only | Title/author search terms |
| Your AI provider | AI fallback only, if configured | Page text (≤30K chars) of the item being enriched + your API key |
| `localhost` (Ollama/oMLX/LM Studio/MLX) | AI fallback with a local provider; model-list refresh in settings | Page text; never leaves your machine |

The plugin makes **no** analytics, telemetry, or update-check calls of its
own. (Zotero itself checks the `update_url` in the manifest for plugin
updates; that URL serves only a version manifest.)

---

## Settings reference

All preferences are under `extensions.readwise2zotero.` (visible in
Zotero's Config Editor):

| Key | Default | Meaning |
|---|---|---|
| `token` | – | Readwise access token |
| `collection` | `Readwise` | Target collection name |
| `lastSync` / `lastSyncClassic` | – | ISO timestamp cursors for incremental sync (Reader / classic library); only advanced after a run with zero failures |
| `autoSync` / `autoSyncMinutes` | off / 60 | Background sync |
| `enrichOnSync` | off | Run enrichment on each newly synced item |
| `aiProvider` | `anthropic` | Which AI provider the fallback uses |
| `anthropicKey` / `anthropicModel` | – / `claude-haiku-4-5` | Anthropic |
| `openaiKey` / `openaiModel` | – / `gpt-5-mini` | OpenAI |
| `geminiKey` / `geminiModel` | – / `gemini-2.5-flash` | Gemini |
| `ollamaBaseUrl` / `ollamaModel` / `ollamaKey` | `http://localhost:11434/v1` / – / – | Ollama (key only for Ollama Cloud) |
| `omlxBaseUrl` / `omlxModel` / `omlxKey` | `http://localhost:8000/v1` / – / – | oMLX |
| `localBaseUrl` / `localModel` | `http://localhost:1234/v1` / – | LM Studio / MLX |

## Limitations and known behaviors

- **Append-only notes:** highlights deleted or edited in Reader are not
  removed/updated in Zotero. To rebuild an item from scratch, delete it in
  Zotero and run a Full Rescan.
- **Only documents with highlights sync.** Reader documents and classic
  books you haven't highlighted are ignored by design.
- **First sync is slow** due to Readwise's API rate limits; the plugin waits
  and retries automatically.
- **AI extraction can be imperfect**, especially with small local models —
  spot-check AI-enriched authors and dates. The fill-empty-only merge limits
  the blast radius of a bad extraction.
- **Amazon may bot-block** the book fallback intermittently; affected items
  just fall through to the next step.

## Troubleshooting

Enable **Help → Debug Output Logging → View Output** and look for lines
prefixed `ReadwiseSync:` — every pipeline decision (translator results, AI
calls, book-lookup steps, skips, and errors) is logged there.

Common cases:

- *Settings pane missing after upgrade* → restart Zotero.
- *Local model dropdown says "Server not reachable"* → the server isn't
  running or the base URL/port is wrong; you can still type a model name.
- *Enrichment says "no new data"* → translators and fallbacks found nothing
  the item didn't already have; for books, check whether the title contains
  extra junk (edition markers, subtitle formatting) and clean it, then retry.

## Building from source

The plugin is plain JavaScript — no build toolchain required:

```sh
cd plugin
zip -r ../readwise-sync-for-zotero.xpi \
    manifest.json bootstrap.js prefs.js preferences.xhtml \
    preferences.js readwise-sync.js icon.svg
```

### Releasing updates

The manifest's `update_url` points at [`update.json`](update.json) on this
repository's `main` branch. To ship a new version to existing users:

1. Bump `version` in `plugin/manifest.json` and rebuild the `.xpi`.
2. Create a GitHub release tagged `v<version>` with the `.xpi` attached.
3. Update `version` and `update_link` in `update.json` and push.

Installed copies check that file periodically and offer the update
automatically.

### Repository layout

| Path | What it is |
|---|---|
| `plugin/manifest.json` | Plugin manifest (Zotero 8–10) |
| `plugin/bootstrap.js` | Lifecycle hooks: menu items, settings pane registration |
| `plugin/readwise-sync.js` | Everything else: sync, note rendering, enrichment, AI providers, book lookup |
| `plugin/preferences.xhtml` / `preferences.js` | Settings pane and its logic (model auto-population) |
| `plugin/prefs.js` | Default (empty) preference values |
| `plugin/icon.svg` | Plugin icon |
| `readwise2zotero.py` | Legacy prototype: a standalone CLI sync script predating the plugin. Uses the `readwise` CLI + Zotero's local API/connector. Kept for reference; the plugin supersedes it. |

## Acknowledgments

Built on Zotero's excellent internal APIs: the translator framework, the
identifier-search (ISBN) machinery, and the hidden-browser document loader.
Highlight formatting follows Readwise's export conventions.
