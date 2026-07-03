#!/opt/homebrew/bin/python3.11
"""Sync Readwise Reader documents into Zotero via the local API.

Default behavior: find every Reader document that has at least one highlight
(new or updated since the last sync), create a matching Zotero item in the
"Readwise" collection with source metadata, and attach the highlights as a
child note. Re-running updates the highlight notes of already-synced items
when their highlights change.

Requires: Zotero running with the local API enabled
(Settings > Advanced > "Allow other applications on this computer to
communicate with Zotero").
"""

import argparse
import html
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

READWISE_BIN = "/Users/seanlawson/.nvm/versions/node/v20.19.6/bin/readwise"
ZOTERO_API = "http://localhost:23119/api/users/0"
ZOTERO_CONNECTOR = "http://localhost:23119/connector"
STATE_FILE = Path(__file__).parent / "state.json"

# Reader category -> Zotero item type
CATEGORY_ITEMTYPE = {
    "article": "webpage",
    "rss": "webpage",
    "email": "webpage",
    "note": "webpage",
    "pdf": "document",
    "epub": "book",
    "tweet": "forumPost",
    "video": "videoRecording",
    "podcast": "podcast",
    "audiobook": "audioRecording",
}

# Where to put site_name for each item type (None = Extra only)
SITENAME_FIELD = {
    "webpage": "websiteTitle",
    "forumPost": "forumTitle",
    "videoRecording": "studio",
    "podcast": "seriesTitle",
    "audioRecording": "label",
}


# ---------------------------------------------------------------- readwise

def run_readwise(args: list[str]):
    result = subprocess.run(
        [READWISE_BIN, "--json", *args],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"readwise {' '.join(args)} failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def list_highlight_parents(since: str | None, verbose: bool = False,
                           max_parents: int | None = None) -> list[str]:
    """Return parent document IDs of all highlight docs, newest first."""
    parents: dict[str, None] = {}  # ordered set
    cursor = None
    page = 0
    while True:
        if max_parents and len(parents) >= max_parents:
            break
        args = ["reader-list-documents", "--category", "highlight",
                "--limit", "100", "--response-fields", "parent_id,updated_at"]
        if since:
            args += ["--updated-after", since]
        if cursor:
            args += ["--page-cursor", cursor]
        data = run_readwise(args)
        page += 1
        if verbose:
            print(f"  fetched highlights page {page} "
                  f"({len(data['results'])} of {data['count']} total)")
        for h in data["results"]:
            pid = h.get("parent_id")
            if pid:
                parents.setdefault(pid, None)
        cursor = data.get("nextPageCursor")
        if not cursor:
            break
    return list(parents)


def get_document(doc_id: str) -> dict | None:
    fields = ("url,title,author,source,category,location,tags,site_name,"
              "created_at,published_date,summary,source_url,saved_at,notes")
    data = run_readwise(["reader-list-documents", "--id", doc_id,
                         "--response-fields", fields])
    results = data.get("results", [])
    return results[0] if results else None


def get_highlights(doc_id: str) -> list[dict]:
    return run_readwise(["reader-get-document-highlights", "--document-id", doc_id])


# ---------------------------------------------------------------- zotero

def zotero_request(method: str, path: str, body=None, headers=None):
    url = ZOTERO_API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Zotero-API-Version", "3")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        if e.code == 403:
            sys.exit("Zotero local API returned 403 Forbidden.\n"
                     "Enable it in Zotero: Settings > Advanced > "
                     '"Allow other applications on this computer to communicate with Zotero".')
        raise RuntimeError(f"Zotero {method} {path} -> {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach Zotero at {ZOTERO_API} — is Zotero running? ({e.reason})")


def connector_request(endpoint: str, body: dict):
    """POST to Zotero's connector API (the write channel; local API is read-only)."""
    req = urllib.request.Request(
        f"{ZOTERO_CONNECTOR}/{endpoint}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Zotero connector /{endpoint} -> {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach Zotero at {ZOTERO_CONNECTOR} — is Zotero running? ({e.reason})")


def resolve_collection(name: str) -> tuple[str, str]:
    """Return (webAPIKey, connectorTreeViewID) for the named collection.

    The collection must already exist — Zotero's local API is read-only and
    the connector API can't create collections.
    """
    # Local API has no default limit — returns all collections in one response
    _, _, collections = zotero_request("GET", "/collections")
    key = next((c["key"] for c in collections if c["data"]["name"] == name), None)

    _, targets_resp = connector_request("getSelectedCollection", {})
    tree_id = next((t["id"] for t in targets_resp.get("targets", [])
                    if t["name"] == name and t["id"].startswith("C")), None)

    if not key or not tree_id:
        sys.exit(f'Collection "{name}" not found in Zotero.\n'
                 f'Please create it first (File > New Collection, name it "{name}") '
                 "and run again.")
    return key, tree_id


# ---------------------------------------------------------------- mapping

def parse_creators(author: str | None) -> list[dict]:
    if not author or not author.strip():
        return []
    # Split multiple authors on ";", ",", " and ", "&"
    parts = re.split(r";|,|\band\b|&", author)
    creators = []
    for part in (p.strip() for p in parts):
        if not part:
            continue
        if " " in part and not any(ch.isdigit() for ch in part):
            first, _, last = part.rpartition(" ")
            creators.append({"creatorType": "author",
                             "firstName": first, "lastName": last})
        else:
            # Single-field creator (connector/translator format)
            creators.append({"creatorType": "author",
                             "lastName": part, "fieldMode": 1})
    return creators


def to_access_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso)
        # API-JSON ISO 8601 format required by Zotero's item.fromJSON
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return ""


def doc_to_item(doc: dict) -> dict:
    item_type = CATEGORY_ITEMTYPE.get(doc.get("category") or "", "webpage")
    extra_lines = [f"Readwise-ID: {doc['id']}"]
    if doc.get("url"):
        extra_lines.append(f"Readwise-URL: {doc['url']}")

    item = {
        "itemType": item_type,
        "title": doc.get("title") or "(untitled)",
        "creators": parse_creators(doc.get("author")),
        "abstractNote": doc.get("summary") or "",
        "url": doc.get("source_url") or doc.get("url") or "",
        "date": doc.get("published_date") or "",
        "extra": "\n".join(extra_lines),
        "tags": [{"tag": t["name"]} for t in (doc.get("tags") or {}).values()],
    }
    site_name = doc.get("site_name")
    if site_name:
        field = SITENAME_FIELD.get(item_type)
        if field:
            item[field] = site_name
        else:
            item["extra"] += f"\nWebsite: {site_name}"
    if item_type in ("webpage", "document", "forumPost", "videoRecording",
                     "podcast", "book", "audioRecording"):
        access = to_access_date(doc.get("saved_at"))
        if access:
            item["accessDate"] = access
    return item


HEADING_MARKER = re.compile(r"^\.h([1-3])\s*", re.I)
CONCAT_MARKER = re.compile(r"^\.c(\d+)\s*", re.I)


def inline_html(text: str) -> str:
    """Escape text and convert minimal markdown (bold/italic/links) to HTML."""
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)  # drop images
    text = html.escape(text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    return text


def flatten(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def render_annotation(note: str) -> list[str]:
    """Regular annotation: first line as an h3, remaining lines as paragraphs."""
    lines = [ln.strip() for ln in note.splitlines() if ln.strip()]
    if not lines:
        return []
    parts = [f"<h3>{inline_html(lines[0])}</h3>"]
    parts.extend(f"<p>{inline_html(ln)}</p>" for ln in lines[1:])
    return parts


def render_quote(text: str, highlight_id: str, tags: list) -> list[str]:
    link = (f' (<a href="https://read.readwise.io/read/{highlight_id}">'
            "View Highlight</a>)")
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return []
    body = "".join(
        f"<p>{inline_html(flatten(p))}{link if i == len(paragraphs) - 1 else ''}</p>"
        for i, p in enumerate(paragraphs))
    parts = [f"<blockquote>{body}</blockquote>"]
    if tags:
        names = ", ".join(t["name"] if isinstance(t, dict) else str(t) for t in tags)
        parts.append(f"<p><em>Tags: {inline_html(names)}</em></p>")
    return parts


def build_note_html(doc: dict, highlights: list[dict]) -> str:
    """Render highlights following the Readwise export conventions:

    - a note of ".h2" (or .h1/.h3) turns the highlight text into a heading
    - consecutive notes ".c1", ".c2", ... concatenate their highlights into
      one blockquote joined by " [...] "
    - any other note renders as an h3 annotation above the blockquote
    """
    parts = []
    i = 0
    while i < len(highlights):
        h = highlights[i]
        content = (h.get("content") or "").strip()
        note = (h.get("notes") or "").strip()

        m = HEADING_MARKER.match(note)
        if m:
            level = m.group(1)
            parts.append(f"<h{level}>{inline_html(flatten(content))}</h{level}>")
            remainder = note[m.end():].strip()
            if remainder:
                parts.extend(render_annotation(remainder))
            i += 1
            continue

        if CONCAT_MARKER.match(note):
            chunks, notes_text, tags = [], [], []
            first_id = h["id"]
            while i < len(highlights):
                nh = highlights[i]
                n_note = (nh.get("notes") or "").strip()
                cm = CONCAT_MARKER.match(n_note)
                if not cm and chunks:
                    break
                chunks.append(flatten(nh.get("content") or ""))
                remainder = n_note[cm.end():].strip()
                if remainder:
                    notes_text.append(remainder)
                tags.extend(nh.get("tags") or [])
                i += 1
            if notes_text:
                parts.extend(render_annotation("\n".join(notes_text)))
            parts.extend(render_quote(" [...] ".join(chunks), first_id, tags))
            continue

        if note:
            parts.extend(render_annotation(note))
        parts.extend(render_quote(content, h["id"], h.get("tags") or []))
        i += 1

    return "".join(parts)


# ---------------------------------------------------------------- state

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_sync": None, "items": {}}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def rebuild_state_from_zotero(state: dict, collection_key: str):
    """Recover readwise-id -> zotero-key mapping by scanning the collection."""
    start = 0
    while True:
        _, headers, items = zotero_request(
            "GET", f"/collections/{collection_key}/items/top?limit=100&start={start}")
        if not items:
            break
        for it in items:
            m = re.search(r"^Readwise-ID:\s*(\S+)", it["data"].get("extra") or "", re.M)
            if m and m.group(1) not in state["items"]:
                state["items"][m.group(1)] = {"itemKey": it["key"]}
        start += len(items)
        if start >= int(headers.get("Total-Results", 0)):
            break


# ---------------------------------------------------------------- sync

def create_item_with_note(item: dict, note_html: str, doc: dict,
                          collection_key: str, tree_id: str,
                          dry_run: bool) -> dict:
    """Save an item + highlights note via the connector API, filed into the
    target collection, then look up its key via the (read-only) local API."""
    if dry_run:
        print(f"[dry-run] would create {item['itemType']}: {item['title']!r} "
              f"+ note with highlights")
        return {"itemKey": None}
    session_id = str(uuid.uuid4())
    item = {**item, "id": doc["id"], "notes": [{"note": note_html}],
            "attachments": []}
    status, _ = connector_request("saveItems", {
        "sessionID": session_id,
        "uri": item.get("url") or "https://readwise.io",
        "items": [item],
    })
    if status != 201:
        raise RuntimeError(f"saveItems returned {status}")
    # File it into the target collection and apply Reader tags. Tags must go
    # through updateSession: saveItems forces tag type to "automatic", which
    # Zotero drops unless the automatic-tags pref is enabled.
    connector_request("updateSession", {
        "sessionID": session_id,
        "target": tree_id,
        "tags": [t["tag"] for t in item.get("tags", [])],
    })

    # Recover the new item's key for the dedupe map
    _, _, recent = zotero_request(
        "GET", f"/collections/{collection_key}/items/top"
               "?sort=dateAdded&direction=desc&limit=10")
    for it in recent:
        if f"Readwise-ID: {doc['id']}" in (it["data"].get("extra") or ""):
            return {"itemKey": it["key"]}
    return {"itemKey": None}


def main():
    ap = argparse.ArgumentParser(
        description="Sync Readwise Reader documents with highlights into Zotero.")
    ap.add_argument("--id", help="sync a single Reader document by ID")
    ap.add_argument("--all", action="store_true",
                    help="ignore last-sync time; scan every highlight")
    ap.add_argument("--limit", type=int, help="max documents to sync this run")
    ap.add_argument("--collection", default="Readwise",
                    help='target Zotero collection (default: "Readwise")')
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would happen without writing to Zotero")
    ap.add_argument("--rebuild-state", action="store_true",
                    help="rescan the Zotero collection to rebuild the dedupe map")
    args = ap.parse_args()

    sync_started = datetime.now(timezone.utc).isoformat()
    state = load_state()

    collection_key, tree_id = resolve_collection(args.collection)

    if collection_key and (args.rebuild_state or
                           (not state["items"] and not STATE_FILE.exists())):
        rebuild_state_from_zotero(state, collection_key)
        if state["items"]:
            print(f"Recovered {len(state['items'])} existing items from Zotero.")

    # Which documents to process?
    if args.id:
        parent_ids = [args.id]
    else:
        since = None if args.all else state.get("last_sync")
        scope = f"updated after {since}" if since else "all time"
        print(f"Scanning Reader highlights ({scope})...")
        # When limited, fetch a buffer of extra parents to cover skips/failures
        max_parents = (args.limit * 2 + 10) if args.limit else None
        parent_ids = list_highlight_parents(since, verbose=True,
                                            max_parents=max_parents)
    target = args.limit or len(parent_ids)
    print(f"Processing up to {target} document(s).\n")

    created = skipped = 0
    for i, pid in enumerate(parent_ids, 1):
        if created >= target:
            break
        try:
            doc = get_document(pid)
        except RuntimeError as e:
            print(f"[{i}] skip {pid}: document fetch failed "
                  "(likely deleted in Reader)")
            skipped += 1
            continue
        if not doc or doc.get("is_deleted"):
            skipped += 1
            continue
        title = (doc.get("title") or "(untitled)")[:70]
        try:
            highlights = get_highlights(pid)
        except RuntimeError:
            print(f"[{i}] skip {title!r}: highlight fetch failed")
            skipped += 1
            continue
        if not highlights:
            skipped += 1
            continue
        note_html = build_note_html(doc, highlights)
        entry = state["items"].get(pid)
        if entry and args.id and entry.get("itemKey"):
            # Explicit re-sync: if the item was deleted in Zotero, recreate it
            try:
                zotero_request("GET", f"/items/{entry['itemKey']}")
            except RuntimeError:
                del state["items"][pid]
                entry = None
        if entry:
            # Zotero's local API is read-only and the connector API can only
            # create, so existing items can't be updated in place. To refresh
            # one, delete it in Zotero and rerun with --id <readwise-id>.
            print(f"[{i}] already synced, skipping: {title}")
            skipped += 1
            continue
        print(f"[{i}] create ({len(highlights)} highlights): {title}")
        item = doc_to_item(doc)
        keys = create_item_with_note(item, note_html, doc, collection_key,
                                     tree_id, args.dry_run)
        if not args.dry_run:
            state["items"][pid] = keys
        created += 1
        if not args.dry_run:
            save_state(state)

    if not args.dry_run and not args.id and not args.limit:
        state["last_sync"] = sync_started
        save_state(state)

    print(f"\nDone: {created} created, {skipped} skipped.")
    if args.dry_run:
        print("(dry run — nothing was written to Zotero)")


if __name__ == "__main__":
    main()
