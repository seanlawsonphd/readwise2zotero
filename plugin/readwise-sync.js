/**
 * Readwise Sync for Zotero — core module.
 *
 * Imports Readwise Reader documents that have highlights into Zotero:
 * source metadata mapped to item fields, highlights rendered into a child
 * note following the Readwise export conventions (.h1-.h3 heading markers,
 * .c1/.c2 concatenation markers, annotations as h3 headings, View Highlight
 * links). Existing items get new highlights appended to their note under a
 * "New highlights added <date>" header.
 */

ReadwiseSync = {
	id: null,
	version: null,
	rootURI: null,
	PREF: "extensions.readwise2zotero.",
	API: "https://readwise.io/api/v3",

	_addedElementIDs: [
		"readwise-sync-menuitem",
		"readwise-sync-full-menuitem",
		"readwise-enrich-menuitem",
	],
	_timerID: null,
	_syncing: false,

	// Reader category -> Zotero item type
	CATEGORY_ITEMTYPE: {
		article: "webpage",
		rss: "webpage",
		email: "webpage",
		note: "webpage",
		pdf: "document",
		epub: "book",
		tweet: "forumPost",
		video: "videoRecording",
		podcast: "podcast",
		audiobook: "audioRecording",
	},

	// Where to put site_name for each item type (absent = Extra only)
	SITENAME_FIELD: {
		webpage: "websiteTitle",
		forumPost: "forumTitle",
		videoRecording: "studio",
		podcast: "seriesTitle",
		audioRecording: "label",
	},

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._setupAutoSync();
	},

	shutdown() {
		this._clearAutoSync();
	},

	log(msg) {
		Zotero.debug("ReadwiseSync: " + msg);
	},

	getPref(name) {
		return Zotero.Prefs.get(this.PREF + name, true);
	},

	setPref(name, value) {
		Zotero.Prefs.set(this.PREF + name, value, true);
	},

	// ------------------------------------------------------------ UI

	addToWindow(window) {
		let doc = window.document;
		if (doc.getElementById("readwise-sync-menuitem")) return;
		let toolsPopup = doc.getElementById("menu_ToolsPopup");
		if (!toolsPopup) return;

		let item = doc.createXULElement("menuitem");
		item.id = "readwise-sync-menuitem";
		item.setAttribute("label", "Sync from Readwise");
		item.addEventListener("command", () => this.sync({ full: false }));
		toolsPopup.appendChild(item);

		let full = doc.createXULElement("menuitem");
		full.id = "readwise-sync-full-menuitem";
		full.setAttribute("label", "Sync from Readwise (Full Rescan)");
		full.addEventListener("command", () => this.sync({ full: true }));
		toolsPopup.appendChild(full);

		// Item context menu: enrich metadata from the item's URL
		let itemMenu = doc.getElementById("zotero-itemmenu");
		if (itemMenu) {
			let enrich = doc.createXULElement("menuitem");
			enrich.id = "readwise-enrich-menuitem";
			enrich.setAttribute("label", "Enrich Metadata (Readwise Sync)");
			enrich.addEventListener("command", () => this.enrichSelected(window));
			itemMenu.appendChild(enrich);
		}
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of this._addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
	},

	_setupAutoSync() {
		this._clearAutoSync();
		if (!this.getPref("autoSync")) return;
		let minutes = Math.max(15, this.getPref("autoSyncMinutes") || 60);
		this._timerID = Zotero.getMainWindow()?.setInterval(() => {
			if (this.getPref("autoSync")) {
				this.sync({ full: false, silent: true });
			}
		}, minutes * 60 * 1000);
	},

	_clearAutoSync() {
		if (this._timerID) {
			Zotero.getMainWindow()?.clearInterval(this._timerID);
			this._timerID = null;
		}
	},

	// ------------------------------------------------------------ Readwise API

	async _request(params) {
		let url = this.API + "/list/?" + new URLSearchParams(params).toString();
		return this._apiGET(url);
	},

	async _apiGET(url) {
		let token = this.getPref("token");
		// Cap rate-limit retries: waiting forever wedges the sync silently
		const MAX_RETRIES = 8;
		for (let attempt = 0; ; attempt++) {
			try {
				let xhr = await Zotero.HTTP.request("GET", url, {
					headers: { Authorization: "Token " + token },
					responseType: "json",
					timeout: 60000,
				});
				return xhr.response;
			}
			catch (e) {
				let status = e.status || (e.xmlhttp && e.xmlhttp.status);
				if (status == 429) {
					if (attempt >= MAX_RETRIES) {
						throw new Error(
							"Readwise rate limit persisted after "
							+ MAX_RETRIES + " retries — try again later; "
							+ "the next sync will resume where this one stopped.");
					}
					let retry = 30;
					try {
						retry = parseInt(e.xmlhttp.getResponseHeader("Retry-After")) || 30;
					}
					catch (e2) {}
					retry = Math.min(retry, 120);
					this.log(`Rate limited; waiting ${retry}s (retry ${attempt + 1}/${MAX_RETRIES})`);
					this._progressText(
						`Rate limited by Readwise — waiting ${retry}s (retry ${attempt + 1}/${MAX_RETRIES})…`);
					await Zotero.Promise.delay((retry + 1) * 1000);
					continue;
				}
				if (status == 401) {
					throw new Error("Readwise rejected the access token. Check it in Settings → Readwise.");
				}
				throw e;
			}
		}
	},

	async _listAll(params, label) {
		let results = [];
		let cursor = null;
		do {
			let page = { ...params };
			if (cursor) page.pageCursor = cursor;
			let data = await this._request(page);
			results.push(...(data.results || []));
			cursor = data.nextPageCursor;
			if (label) {
				this._progressText(`${label}: ${results.length} fetched…`);
			}
		} while (cursor);
		return results;
	},

	async _getDocument(id) {
		let data = await this._request({ id });
		return (data.results || [])[0] || null;
	},

	/**
	 * Fetch books + nested highlights from the classic Readwise export API
	 * (v2) — this covers Kindle, KOReader, Apple Books, and other classic
	 * sources that never appear as Reader documents.
	 */
	async _listClassicExport(updatedAfter, label) {
		let books = [];
		let cursor = null;
		do {
			let params = new URLSearchParams();
			if (updatedAfter) params.set("updatedAfter", updatedAfter);
			if (cursor) params.set("pageCursor", cursor);
			let data = await this._apiGET(
				"https://readwise.io/api/v2/export/?" + params.toString());
			books.push(...(data.results || []));
			cursor = data.nextPageCursor;
			if (label) this._progressText(`${label}: ${books.length} books fetched…`);
		} while (cursor);
		return books;
	},

	// ------------------------------------------------------------ helpers

	_tagNames(tags) {
		// Reader tags come as a dict of {slug: {name}} or an array
		if (!tags) return [];
		if (Array.isArray(tags)) {
			return tags.map(t => (typeof t == "string" ? t : t.name)).filter(Boolean);
		}
		return Object.values(tags).map(t => t.name).filter(Boolean);
	},

	_parseCreators(author) {
		if (!author || !author.trim()) return [];
		let parts = author.split(/;|,|\band\b|&/);
		let creators = [];
		for (let part of parts) {
			part = part.trim();
			if (!part) continue;
			if (part.includes(" ") && !/\d/.test(part)) {
				let idx = part.lastIndexOf(" ");
				creators.push({
					creatorType: "author",
					firstName: part.slice(0, idx),
					lastName: part.slice(idx + 1),
				});
			}
			else {
				creators.push({ creatorType: "author", lastName: part, fieldMode: 1 });
			}
		}
		return creators;
	},

	_parseDate(value) {
		if (!value) return "";
		if (typeof value == "number") {
			return new Date(value).toISOString().slice(0, 10);
		}
		return String(value).slice(0, 10);
	},

	// ------------------------------------------------------------ note rendering

	_escape(text) {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	},

	_inlineHTML(text) {
		text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, ""); // drop images
		text = this._escape(text);
		text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
		text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
		text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
		return text;
	},

	_flatten(text) {
		return text.replace(/\s+/g, " ").trim();
	},

	_renderAnnotation(note) {
		let lines = note.split("\n").map(l => l.trim()).filter(Boolean);
		if (!lines.length) return [];
		let parts = [`<h3>${this._inlineHTML(lines[0])}</h3>`];
		for (let line of lines.slice(1)) {
			parts.push(`<p>${this._inlineHTML(line)}</p>`);
		}
		return parts;
	},

	_renderQuote(text, hl, tags) {
		// hl: { id, locLabel?, locUrl? } — Reader highlights link as
		// "View Highlight"; classic ones as "Page N" / "Location N"
		let label = this._escape(hl.locLabel || "View Highlight");
		let url = hl.locUrl || `https://read.readwise.io/read/${hl.id}`;
		let link = ` (<a href="${this._escape(url)}">${label}</a>)`;
		let paragraphs = text.split("\n\n").map(p => p.trim()).filter(Boolean);
		if (!paragraphs.length) return [];
		let body = paragraphs.map((p, i) =>
			`<p>${this._inlineHTML(this._flatten(p))}${i == paragraphs.length - 1 ? link : ""}</p>`
		).join("");
		let parts = [`<blockquote>${body}</blockquote>`];
		let names = this._tagNames(tags);
		if (names.length) {
			parts.push(`<p><em>Tags: ${this._inlineHTML(names.join(", "))}</em></p>`);
		}
		return parts;
	},

	/**
	 * Render highlights following the Readwise export conventions:
	 * - a note of ".h2" (or .h1/.h3) turns the highlight text into a heading
	 * - consecutive notes ".c1", ".c2", ... concatenate their highlights into
	 *   one blockquote joined by " [...] "
	 * - any other note renders as an h3 annotation above the blockquote
	 *
	 * Each highlight: { id, content, note, tags }
	 */
	buildNoteHTML(highlights) {
		const HEADING = /^\.h([1-3])\s*/i;
		const CONCAT = /^\.c(\d+)\s*/i;
		let parts = [];
		let i = 0;
		while (i < highlights.length) {
			let h = highlights[i];
			let content = (h.content || "").trim();
			let note = (h.note || "").trim();

			let hm = note.match(HEADING);
			if (hm) {
				let level = hm[1];
				parts.push(`<h${level}>${this._inlineHTML(this._flatten(content))}</h${level}>`);
				let remainder = note.slice(hm[0].length).trim();
				if (remainder) parts.push(...this._renderAnnotation(remainder));
				i++;
				continue;
			}

			if (CONCAT.test(note)) {
				let chunks = [], notesText = [], tags = [];
				let firstHl = h;
				while (i < highlights.length) {
					let nh = highlights[i];
					let nNote = (nh.note || "").trim();
					let cm = nNote.match(CONCAT);
					if (!cm && chunks.length) break;
					if (!cm) break;
					chunks.push(this._flatten(nh.content || ""));
					let remainder = nNote.slice(cm[0].length).trim();
					if (remainder) notesText.push(remainder);
					tags.push(...this._tagNames(nh.tags));
					i++;
				}
				if (notesText.length) parts.push(...this._renderAnnotation(notesText.join("\n")));
				parts.push(...this._renderQuote(chunks.join(" [...] "), firstHl, tags));
				continue;
			}

			if (note) parts.push(...this._renderAnnotation(note));
			parts.push(...this._renderQuote(content, h, h.tags));
			i++;
		}
		return parts.join("");
	},

	_appendHeader() {
		let now = new Date();
		let date = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		let time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
			.toLowerCase().replace(" ", "");
		return `<h2>New highlights added ${date} at ${time}</h2>`;
	},

	// ------------------------------------------------------------ Zotero side

	async _getCollection(libraryID) {
		let name = this.getPref("collection") || "Readwise";
		let collections = Zotero.Collections.getByLibrary(libraryID);
		let existing = collections.find(c => c.name == name);
		if (existing) return existing;
		let collection = new Zotero.Collection();
		collection.libraryID = libraryID;
		collection.name = name;
		await collection.saveTx();
		this.log(`Created collection "${name}"`);
		return collection;
	},

	/**
	 * Maps of Readwise IDs -> Zotero items, scanning the whole library.
	 * `reader` is keyed by Reader document ID (Readwise-ID: marker);
	 * `classic` by classic-library book ID (Readwise-Book-ID: marker).
	 */
	async _buildItemMap(libraryID) {
		let search = new Zotero.Search();
		search.libraryID = libraryID;
		search.addCondition("extra", "contains", "Readwise-");
		let ids = await search.search();
		let reader = new Map();
		let classic = new Map();
		for (let item of await Zotero.Items.getAsync(ids)) {
			let extra = item.getField("extra") || "";
			let m = extra.match(/^Readwise-ID:\s*(\S+)/m);
			if (m) reader.set(m[1], item);
			let b = extra.match(/^Readwise-Book-ID:\s*(\S+)/m);
			if (b) classic.set(b[1], item);
		}
		return { reader, classic };
	},

	_docToItem(doc, libraryID, collectionID) {
		let itemType = this.CATEGORY_ITEMTYPE[doc.category] || "webpage";
		let item = new Zotero.Item(itemType);
		item.libraryID = libraryID;
		item.setField("title", doc.title || "(untitled)");
		if (doc.summary) item.setField("abstractNote", doc.summary);
		let url = doc.source_url || doc.url;
		if (url) item.setField("url", url);
		let date = this._parseDate(doc.published_date);
		if (date) item.setField("date", date);
		if (doc.saved_at || doc.created_at) {
			item.setField("accessDate",
				Zotero.Date.dateToSQL(new Date(doc.saved_at || doc.created_at), true));
		}

		let extra = [`Readwise-ID: ${doc.id}`];
		if (doc.url) extra.push(`Readwise-URL: ${doc.url}`);
		if (doc.site_name) {
			let field = this.SITENAME_FIELD[itemType];
			if (field) item.setField(field, doc.site_name);
			else extra.push(`Website: ${doc.site_name}`);
		}
		item.setField("extra", extra.join("\n"));

		item.setCreators(this._parseCreators(doc.author));
		for (let tag of this._tagNames(doc.tags)) {
			item.addTag(tag, 0);
		}
		item.setCollections([collectionID]);
		return item;
	},

	/** Map a classic-library book (v2 export) to a new Zotero item. */
	_classicToItem(book, libraryID, collectionID) {
		const typeMap = {
			books: "book",
			articles: "webpage",
			tweets: "forumPost",
			podcasts: "podcast",
		};
		let itemType = typeMap[book.category] || "webpage";
		let item = new Zotero.Item(itemType);
		item.libraryID = libraryID;
		item.setField("title", book.title || "(untitled)");
		let url = book.source_url || book.unique_url;
		if (url) item.setField("url", url);
		if (book.summary) item.setField("abstractNote", book.summary);

		let extra = [`Readwise-Book-ID: ${book.user_book_id}`];
		if (book.readwise_url) extra.push(`Readwise-URL: ${book.readwise_url}`);
		if (book.asin) extra.push(`ASIN: ${book.asin}`);
		if (book.source) extra.push(`Readwise-Source: ${book.source}`);
		item.setField("extra", extra.join("\n"));

		item.setCreators(this._parseCreators(book.author));
		for (let t of (book.book_tags || [])) {
			let name = typeof t == "string" ? t : t.name;
			if (name) item.addTag(name, 0);
		}
		item.setCollections([collectionID]);
		return item;
	},

	_findReadwiseNote(item) {
		for (let noteID of item.getNotes()) {
			let note = Zotero.Items.get(noteID);
			let html = note.getNote();
			if (html.includes("read.readwise.io/read/")
					|| html.includes("readwise.io/open/")) {
				return note;
			}
		}
		return null;
	},

	// ------------------------------------------------------------ sync

	_progressWin: null,
	_progressLine: null,

	_progressText(text) {
		if (this._progressLine) {
			this._progressLine.setText(text);
		}
	},

	_syncStartedAt: null,

	async sync({ full = false, silent = false } = {}) {
		if (this._syncing) {
			let minutes = this._syncStartedAt
				? Math.round((Date.now() - this._syncStartedAt) / 60000) : 0;
			// A sync stuck for this long is wedged — recover instead of
			// silently refusing every future sync until restart
			if (minutes >= 30) {
				this.log(`Previous sync appears wedged (${minutes} min); resetting`);
				this._syncing = false;
			}
			else {
				this.log("Sync already running; skipping");
				if (!silent) {
					Zotero.alert(
						Zotero.getMainWindow(),
						"Readwise Sync",
						`A sync is already running (started ${minutes} minute(s) ago). `
						+ "If it seems stuck, it will reset itself after 30 minutes, "
						+ "or restart Zotero to clear it immediately."
					);
				}
				return;
			}
		}
		if (!this.getPref("token")) {
			if (!silent) {
				Zotero.alert(
					Zotero.getMainWindow(),
					"Readwise Sync",
					"No Readwise access token configured.\n\n"
					+ "Get one at https://readwise.io/access_token and enter it in "
					+ "Zotero Settings → Readwise."
				);
			}
			return;
		}

		this._syncing = true;
		this._syncStartedAt = Date.now();
		let syncStart = new Date().toISOString();
		this._progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
		this._progressWin.changeHeadline("Readwise Sync");
		this._progressLine = new this._progressWin.ItemProgress(
			"chrome://zotero/skin/tick.png", "Starting…");
		this._progressWin.show();

		let created = 0, updated = 0, skipped = 0, failed = 0;
		try {
			let libraryID = Zotero.Libraries.userLibraryID;
			let collection = await this._getCollection(libraryID);
			let itemMap = await this._buildItemMap(libraryID);

			let updatedAfter = full ? null : (this.getPref("lastSync") || null);
			let listParams = { category: "highlight" };
			if (updatedAfter) listParams.updatedAfter = updatedAfter;
			let highlightDocs = await this._listAll(listParams, "Fetching highlights");
			highlightDocs = highlightDocs.filter(h => !h.is_deleted);

			// Highlight annotations are child documents of category "note"
			let noteParams = { category: "note" };
			if (updatedAfter) noteParams.updatedAfter = updatedAfter;
			let noteDocs = await this._listAll(noteParams, "Fetching annotations");
			let notesByHighlight = new Map();
			for (let n of noteDocs) {
				if (n.parent_id && !n.is_deleted) notesByHighlight.set(n.parent_id, n.content || "");
			}

			// Group highlights by parent document, in creation order
			highlightDocs.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
			let byParent = new Map();
			for (let h of highlightDocs) {
				if (!h.parent_id) continue;
				if (!byParent.has(h.parent_id)) byParent.set(h.parent_id, []);
				byParent.get(h.parent_id).push({
					id: h.id,
					content: h.content || "",
					note: notesByHighlight.get(h.id) || h.notes || "",
					tags: h.tags,
				});
			}

			let total = byParent.size;
			let n = 0;
			for (let [parentID, highlights] of byParent) {
				n++;
				this._progressText(`Processing document ${n}/${total} (${created} new, ${updated} updated)`);
				try {
					let existing = itemMap.reader.get(parentID);
					if (existing) {
						let didUpdate = await this._appendNewHighlights(existing, highlights);
						didUpdate ? updated++ : skipped++;
						continue;
					}
					let doc = await this._getDocument(parentID);
					if (!doc || doc.is_deleted) {
						skipped++;
						continue;
					}
					let item = this._docToItem(doc, libraryID, collection.id);
					await item.saveTx();
					let note = new Zotero.Item("note");
					note.libraryID = libraryID;
					note.parentItemID = item.id;
					note.setNote(this.buildNoteHTML(highlights));
					await note.saveTx();
					itemMap.reader.set(parentID, item);
					created++;
					if (this.getPref("enrichOnSync")) {
						try {
							// Bounded so a slow page/AI call can't stall the sync
							await Promise.race([
								this.enrichItem(item),
								Zotero.Promise.delay(120000).then(() => {
									throw new Error("enrichment timed out (120s)");
								}),
							]);
						}
						catch (e) {
							this.log(`enrich during sync failed for ${parentID}: ${e}`);
						}
					}
				}
				catch (e) {
					this.log(`Failed on document ${parentID}: ${e}`);
					failed++;
				}
			}

			// ---- Classic Readwise library (Kindle, KOReader, Apple Books,
			// podcasts, ...) — these never appear as Reader documents ----
			let readerFailed = failed;
			let classicAfter = full ? null : (this.getPref("lastSyncClassic") || null);
			let books = await this._listClassicExport(classicAfter,
				"Fetching classic library (Kindle etc.)");
			let cn = 0;
			for (let book of books) {
				cn++;
				// Reader documents are synced above via the Reader API;
				// the classic export mirrors them, so skip to avoid doubles
				if (book.source == "reader" || book.is_deleted) continue;
				let highlights = (book.highlights || [])
					.filter(h => !h.is_deleted && (h.text || "").trim());
				if (!highlights.length) continue;
				this._progressText(`Classic library ${cn}/${books.length} (${created} new, ${updated} updated)`);

				// Sort by position in the book where possible
				highlights.sort((a, b) => (a.location ?? 1e12) - (b.location ?? 1e12));
				let normalized = highlights.map(h => ({
					id: String(h.id),
					content: h.text || "",
					note: h.note || "",
					tags: (h.tags || []).map(t => t.name),
					locLabel: h.location != null
						? (h.location_type == "page" ? `Page ${h.location}`
							: h.location_type == "location" ? `Location ${h.location}`
							: "View Highlight")
						: "View Highlight",
					locUrl: h.url || `https://readwise.io/open/${h.id}`,
				}));

				try {
					let bookID = String(book.user_book_id);
					let existing = itemMap.classic.get(bookID);
					if (existing) {
						let didUpdate = await this._appendNewHighlights(existing, normalized);
						didUpdate ? updated++ : skipped++;
						continue;
					}
					let item = this._classicToItem(book, libraryID, collection.id);
					await item.saveTx();
					let note = new Zotero.Item("note");
					note.libraryID = libraryID;
					note.parentItemID = item.id;
					note.setNote(this.buildNoteHTML(normalized));
					await note.saveTx();
					itemMap.classic.set(bookID, item);
					created++;
					if (this.getPref("enrichOnSync")) {
						try {
							// Books route to Open Library/ISBN/Amazon; bounded
							// so a slow lookup can't stall the sync
							await Promise.race([
								this.enrichItem(item),
								Zotero.Promise.delay(120000).then(() => {
									throw new Error("enrichment timed out (120s)");
								}),
							]);
						}
						catch (e) {
							this.log(`enrich during sync failed for classic book ${bookID}: ${e}`);
						}
					}
				}
				catch (e) {
					this.log(`Failed on classic book ${book.user_book_id} ("${book.title}"): ${e}`);
					failed++;
				}
			}
			if (failed == readerFailed) {
				this.setPref("lastSyncClassic", syncStart);
			}

			// Only advance the incremental cursor on a clean run — if any
			// document failed, keep the old cursor so the next sync retries
			// it (dedupe makes re-processing the successes harmless)
			if (!readerFailed) {
				this.setPref("lastSync", syncStart);
			}
			if (failed) {
				this.log(`${failed} document(s) failed; not advancing sync cursor(s) so they retry next run`);
			}

			this._progressText(
				`Done: ${created} created, ${updated} updated, ${skipped} unchanged`
				+ (failed ? `, ${failed} failed (will retry next sync)` : ""));
			this._progressWin.startCloseTimer(6000);
		}
		catch (e) {
			this.log("Sync failed: " + e);
			this._progressText("Sync failed: " + (e.message || e));
			this._progressWin.startCloseTimer(10000);
		}
		finally {
			this._syncing = false;
			this._progressLine = null;
		}
	},

	// ------------------------------------------------------------ enrichment

	/**
	 * Load the item's URL, run Zotero's web translators on the page, and
	 * merge the extracted metadata into the item. If the translators find
	 * nothing and an Anthropic API key is configured, fall back to Claude
	 * for AI extraction from the page text. Only fills empty fields
	 * (never overwrites), except the item type, which is upgraded when the
	 * item is a generic webpage/document and the source identifies
	 * something more specific.
	 *
	 * Returns: "enriched", "ai-enriched", "no-url", "no-data", "error"
	 */
	async enrichItem(item) {
		// Books: bibliographic databases beat scraping the item's URL.
		// Open Library finds the ISBN; Zotero's identifier-search translators
		// (WorldCat, Library of Congress, ...) provide library-grade metadata.
		if (Zotero.ItemTypes.getName(item.itemTypeID) == "book") {
			try {
				let result = await this.enrichBook(item);
				if (result == "enriched") return "enriched";
			}
			catch (e) {
				this.log(`enrich: book lookup failed for "${item.getField("title")}": ${e}`);
			}
			// fall through to URL/AI enrichment if the book search found nothing
		}

		let url = item.getField("url");
		if (!url) return "no-url";

		let doc;
		try {
			await Zotero.HTTP.processDocuments(url, (d) => { doc = d; });
		}
		catch (e) {
			this.log(`enrich: failed to load ${url}: ${e}`);
			return "error";
		}
		if (!doc) return "error";

		let json = await this._runWebTranslators(doc, url);

		let viaAI = false;
		let hasUsefulData = json && (json.creators?.length || json.date
			|| json.publicationTitle || json.DOI);
		if (!hasUsefulData && this._aiConfig()) {
			let aiJson = await this.aiExtract(doc, url);
			if (aiJson) {
				json = aiJson;
				viaAI = true;
			}
		}
		if (!json) return "no-data";

		let changed = this._mergeMetadata(item, json);
		if (!changed) return "no-data";
		await item.saveTx();
		return viaAI ? "ai-enriched" : "enriched";
	},

	/**
	 * Enrich a book item: find the work on Open Library by title/author,
	 * pick a sensible English edition's ISBN, then resolve full metadata
	 * via Zotero's ISBN search translators (WorldCat, Library of Congress).
	 * (Open Library rather than Google Books: the keyless Google Books API
	 * runs on a shared anonymous quota that is usually exhausted.)
	 * Returns "enriched" or "no-data".
	 */
	async enrichBook(item) {
		let title = item.getField("title");
		if (!title) return "no-data";
		let creators = item.getCreators();
		let author = creators.length
			? (creators[0].lastName || creators[0].firstName || "") : "";

		let json = null;
		try {
			json = await this._bookFromOpenLibrary(title, author);
		}
		catch (e) {
			this.log(`enrich: Open Library lookup failed for "${title}": ${e}`);
		}
		if (!json) {
			try {
				json = await this._bookFromAmazon(title, author);
			}
			catch (e) {
				this.log(`enrich: Amazon lookup failed for "${title}": ${e}`);
			}
		}
		if (!json) return "no-data";
		if (!this._mergeMetadata(item, json)) return "no-data";
		await item.saveTx();
		return "enriched";
	},

	/** Open Library work search → English edition ISBN → Zotero ISBN translators. */
	async _bookFromOpenLibrary(title, author) {
		let params = "title=" + encodeURIComponent(title)
			+ (author ? "&author=" + encodeURIComponent(author) : "")
			+ "&limit=5&fields=" + encodeURIComponent(
				"key,title,author_name,first_publish_year,number_of_pages_median");
		let xhr = await Zotero.HTTP.request("GET",
			"https://openlibrary.org/search.json?" + params,
			{ responseType: "json", timeout: 30000 });
		let docs = xhr.response.docs || [];

		// Best match: title must overlap, or no changes at all
		let work = docs.find(d => this._titlesOverlap(title, d.title));
		if (!work) return null;

		// Choose an English edition with an ISBN-13, preferring the one
		// published closest to the work's first publication (usually the
		// original publisher's edition, not a reprint)
		let edition = null;
		let isbn = null;
		try {
			let ex = await Zotero.HTTP.request("GET",
				`https://openlibrary.org${work.key}/editions.json?limit=50`,
				{ responseType: "json", timeout: 30000 });
			let candidates = (ex.response.entries || []).filter(e =>
				e.isbn_13?.length
				&& (!e.languages?.length
					|| e.languages.some(l => l.key == "/languages/eng")));
			let firstYear = work.first_publish_year || 0;
			let yearOf = (e) => {
				let m = String(e.publish_date || "").match(/\d{4}/);
				return m ? parseInt(m[0]) : 9999;
			};
			candidates.sort((a, b) =>
				Math.abs(yearOf(a) - firstYear) - Math.abs(yearOf(b) - firstYear));
			edition = candidates[0] || null;
			isbn = edition && edition.isbn_13[0];
		}
		catch (e) {
			this.log(`enrich: editions lookup failed for ${work.key}: ${e}`);
		}

		// Preferred source: Zotero's ISBN search translators
		let json = isbn ? await this._isbnLookup(isbn) : null;

		// Fallback: merge Open Library's own fields
		if (!json) {
			json = { itemType: "book" };
			if (edition?.publishers?.length) json.publisher = edition.publishers[0];
			let date = edition?.publish_date
				|| (work.first_publish_year ? String(work.first_publish_year) : "");
			if (date) json.date = date;
			if (isbn) json.ISBN = isbn;
			let pages = edition?.number_of_pages || work.number_of_pages_median;
			if (pages) json.numPages = String(pages);
			if (work.author_name?.length) {
				json.creators = this._parseCreators(
					[...new Set(work.author_name)].join("; "));
			}
		}
		return json;
	},

	/**
	 * Find the book on Amazon and run Zotero's Amazon translator on the
	 * product page — the same extraction the browser connector would do.
	 */
	async _bookFromAmazon(title, author) {
		let searchUrl = "https://www.amazon.com/s?i=stripbooks&k="
			+ encodeURIComponent(title + (author ? " " + author : ""));
		let searchDoc;
		await Zotero.HTTP.processDocuments(searchUrl, (d) => { searchDoc = d; });
		if (!searchDoc) return null;

		// First organic product link
		let link = searchDoc.querySelector(
			"div[data-component-type='s-search-result'] a[href*='/dp/']")
			|| searchDoc.querySelector("a[href*='/dp/']");
		if (!link) return null;
		let productUrl = new URL(link.getAttribute("href"),
			"https://www.amazon.com").href.split("?")[0];

		let doc;
		await Zotero.HTTP.processDocuments(productUrl, (d) => { doc = d; });
		if (!doc) return null;
		let json = await this._runWebTranslators(doc, productUrl);
		if (!json) return null;
		// Wrong-book guard: only accept if the titles plausibly match
		if (!this._titlesOverlap(title, json.title)) {
			this.log(`enrich: Amazon result "${json.title}" doesn't match "${title}", skipping`);
			return null;
		}
		return json;
	},

	/** Resolve an ISBN via Zotero's search translators. Returns item JSON or null. */
	async _isbnLookup(isbn) {
		try {
			let translate = new Zotero.Translate.Search();
			translate.setIdentifier({ ISBN: isbn });
			let translators = await translate.getTranslators();
			if (!translators.length) return null;
			translate.setTranslator(translators);
			let results = await translate.translate({
				libraryID: false,
				saveAttachments: false,
			});
			return (results && results[0]) || null;
		}
		catch (e) {
			this.log(`enrich: ISBN ${isbn} lookup failed: ${e}`);
			return null;
		}
	},

	/** Run Zotero's site translators on a loaded page. Returns item JSON or null. */
	async _runWebTranslators(doc, url) {
		try {
			let translate = new Zotero.Translate.Web();
			translate.setDocument(doc);
			// If the page is a multi-item listing, skip rather than guess
			translate.setHandler("select", (obj, items, callback) => callback([]));
			let translators = await translate.getTranslators();
			if (!translators.length) return null;
			translate.setTranslator(translators[0]);
			let results = await translate.translate({
				libraryID: false,
				saveAttachments: false,
			});
			return (results && results[0]) || null;
		}
		catch (e) {
			this.log(`enrich: translation failed for ${url}: ${e}`);
			return null;
		}
	},

	_norm(s) {
		return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	},

	_titlesOverlap(a, b) {
		let na = this._norm(a);
		let nb = this._norm(b);
		return na && nb && (na.includes(nb) || nb.includes(na)
			|| nb.startsWith(na.slice(0, 30)));
	},

	/** Merge extracted metadata JSON into the item. Returns true if changed. */
	_mergeMetadata(item, json) {
		let changed = false;

		// Upgrade generic item types when the translator found something better
		let genericTypes = ["webpage", "document"];
		let currentType = Zotero.ItemTypes.getName(item.itemTypeID);
		if (json.itemType && json.itemType != currentType
				&& genericTypes.includes(currentType)
				&& !genericTypes.includes(json.itemType)) {
			item.setType(Zotero.ItemTypes.getID(json.itemType));
			changed = true;
		}

		const SKIP_FIELDS = new Set([
			"itemType", "creators", "tags", "notes", "attachments", "seeAlso",
			"extra", "id", "key", "version", "accessDate", "url",
		]);
		for (let [field, value] of Object.entries(json)) {
			if (SKIP_FIELDS.has(field)) continue;
			if (!value || typeof value != "string") continue;
			let fieldID = Zotero.ItemFields.getID(field);
			if (!fieldID) continue;
			let targetID = fieldID;
			if (!Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
				try {
					targetID = Zotero.ItemFields.getFieldIDFromTypeAndBase(
						item.itemTypeID, fieldID) || null;
				}
				catch (e) {
					targetID = null;
				}
				if (!targetID) continue;
			}
			if (!item.getField(targetID)) {
				item.setField(targetID, value);
				changed = true;
			}
		}

		// Only take translator creators when the item has none
		if (json.creators?.length && !item.getCreators().length) {
			let valid = json.creators.filter(c => c.lastName || c.firstName || c.name);
			for (let c of valid) {
				if (!c.creatorType
						|| !Zotero.CreatorTypes.isValidForItemType(
							Zotero.CreatorTypes.getID(c.creatorType), item.itemTypeID)) {
					c.creatorType = Zotero.CreatorTypes.getName(
						Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID));
				}
			}
			if (valid.length) {
				item.setCreators(valid);
				changed = true;
			}
		}

		return changed;
	},

	/**
	 * Resolve the configured AI provider, or null if not usable.
	 * Providers: "anthropic" (native API), "openai", "gemini", and "local"
	 * (LM Studio / Ollama / MLX) — the latter three all speak the
	 * OpenAI-compatible chat-completions dialect.
	 */
	_aiConfig() {
		let provider = this.getPref("aiProvider") || "anthropic";
		if (provider == "anthropic") {
			let key = this.getPref("anthropicKey");
			if (!key) return null;
			return { provider, key,
				model: this.getPref("anthropicModel") || "claude-haiku-4-5" };
		}
		if (provider == "openai") {
			let key = this.getPref("openaiKey");
			if (!key) return null;
			return { provider, key,
				model: this.getPref("openaiModel") || "gpt-5-mini",
				baseUrl: "https://api.openai.com/v1" };
		}
		if (provider == "gemini") {
			let key = this.getPref("geminiKey");
			if (!key) return null;
			return { provider, key,
				model: this.getPref("geminiModel") || "gemini-2.5-flash",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" };
		}
		if (provider == "ollama") {
			let model = this.getPref("ollamaModel");
			if (!model) return null;
			// Key is only needed for Ollama Cloud (https://ollama.com/v1)
			return { provider, key: this.getPref("ollamaKey") || "", model,
				baseUrl: (this.getPref("ollamaBaseUrl") || "http://localhost:11434/v1")
					.replace(/\/$/, "") };
		}
		if (provider == "omlx") {
			let model = this.getPref("omlxModel");
			if (!model) return null;
			return { provider, key: this.getPref("omlxKey") || "", model,
				baseUrl: (this.getPref("omlxBaseUrl") || "http://localhost:8000/v1")
					.replace(/\/$/, "") };
		}
		if (provider == "local") {
			let model = this.getPref("localModel");
			if (!model) return null;
			return { provider, key: "",  model,
				baseUrl: (this.getPref("localBaseUrl") || "http://localhost:1234/v1")
					.replace(/\/$/, "") };
		}
		return null;
	},

	/**
	 * Extract citation metadata from page text using the configured AI
	 * provider, returning translator-style item JSON, or null on failure.
	 */
	async aiExtract(doc, url) {
		let cfg = this._aiConfig();
		if (!cfg) return null;
		let text = ((doc.title || "") + "\n\n"
			+ (doc.body ? doc.body.innerText : "")).slice(0, 30000);
		if (text.trim().length < 100) return null;

		let data;
		try {
			if (cfg.provider == "anthropic") {
				data = await this._anthropicExtract(cfg, url, text);
			}
			else {
				data = await this._openaiCompatExtract(cfg, url, text);
			}
		}
		catch (e) {
			let status = e.status || (e.xmlhttp && e.xmlhttp.status);
			if (status == 401) {
				this.log(`enrich: ${cfg.provider} API rejected the key (401)`);
			}
			else {
				this.log(`enrich: AI extraction (${cfg.provider}) failed for ${url}: ${e}`);
			}
			return null;
		}
		if (!data) return null;

		// Convert to translator-style JSON for the shared merge logic
		let json = { itemType: data.itemType };
		for (let f of ["title", "date", "publicationTitle", "websiteTitle",
			"publisher", "DOI", "language"]) {
			if (data[f]) json[f] = data[f];
		}
		json.creators = (data.creators || [])
			.filter(c => c && c.lastName)
			.map(c => c.firstName
				? { creatorType: "author", firstName: c.firstName, lastName: c.lastName }
				: { creatorType: "author", lastName: c.lastName, fieldMode: 1 });
		return json;
	},

	_extractionSystem() {
		return "You extract bibliographic citation metadata from webpage text. "
			+ "Use only information present in the text. Use empty strings for "
			+ "unknown fields. Authors must be real people or organizations "
			+ "credited for the work (for an organization, put the full name in "
			+ "lastName and leave firstName empty). Choose the most specific "
			+ "itemType that fits the source.";
	},

	_extractionSchema() {
		return {
			type: "object",
			additionalProperties: false,
			required: ["itemType", "title", "creators", "date",
				"publicationTitle", "websiteTitle", "publisher", "DOI", "language"],
			properties: {
				itemType: {
					type: "string",
					enum: ["webpage", "blogPost", "newspaperArticle",
						"magazineArticle", "journalArticle", "videoRecording",
						"podcast", "book", "report", "document", "forumPost",
						"presentation", "thesis"],
				},
				title: { type: "string" },
				creators: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["firstName", "lastName"],
						properties: {
							firstName: { type: "string" },
							lastName: { type: "string" },
						},
					},
				},
				date: { type: "string", description: "Publication date, ISO format, empty if unknown" },
				publicationTitle: { type: "string" },
				websiteTitle: { type: "string" },
				publisher: { type: "string" },
				DOI: { type: "string" },
				language: { type: "string" },
			},
		};
	},

	/** Anthropic Messages API with structured outputs. Returns parsed data. */
	async _anthropicExtract(cfg, url, text) {
		let body = {
			model: cfg.model,
			max_tokens: 1024,
			system: this._extractionSystem(),
			messages: [{
				role: "user",
				content: `URL: ${url}\n\nPage text:\n${text}`,
			}],
			output_config: {
				format: { type: "json_schema", schema: this._extractionSchema() },
			},
		};
		let xhr = await Zotero.HTTP.request("POST",
			"https://api.anthropic.com/v1/messages", {
				headers: {
					"x-api-key": cfg.key,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				responseType: "json",
				timeout: 90000,
			});
		let resp = xhr.response;
		if (resp.stop_reason == "refusal" || !resp.content?.length) return null;
		let textBlock = resp.content.find(b => b.type == "text");
		return textBlock ? JSON.parse(textBlock.text) : null;
	},

	/**
	 * OpenAI-compatible chat completions — covers OpenAI, Gemini (via
	 * Google's compatibility endpoint), and local servers (LM Studio,
	 * Ollama, MLX). Tries strict json_schema response format first; some
	 * local servers only support json_object, so falls back on a 400.
	 */
	async _openaiCompatExtract(cfg, url, text) {
		let messages = [
			{ role: "system", content: this._extractionSystem() },
			{ role: "user", content: `URL: ${url}\n\nPage text:\n${text}` },
		];
		let request = async (responseFormat) => {
			let headers = { "Content-Type": "application/json" };
			if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
			let xhr = await Zotero.HTTP.request("POST",
				cfg.baseUrl + "/chat/completions", {
					headers,
					body: JSON.stringify({
						model: cfg.model,
						messages,
						response_format: responseFormat,
					}),
					responseType: "json",
					timeout: 120000,
				});
			return xhr.response;
		};

		let resp;
		try {
			resp = await request({
				type: "json_schema",
				json_schema: {
					name: "citation_metadata",
					strict: true,
					schema: this._extractionSchema(),
				},
			});
		}
		catch (e) {
			let status = e.status || (e.xmlhttp && e.xmlhttp.status);
			if (status != 400) throw e;
			// Server doesn't support json_schema — embed the schema in the
			// prompt and ask for plain JSON output instead
			messages[0].content += "\n\nRespond with a single JSON object "
				+ "matching this JSON schema exactly:\n"
				+ JSON.stringify(this._extractionSchema());
			resp = await request({ type: "json_object" });
		}

		let content = resp.choices?.[0]?.message?.content;
		if (!content) return null;
		// Strip markdown fences some models wrap around JSON
		content = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
		return JSON.parse(content);
	},

	/** Context-menu entry point: enrich all selected items that have URLs. */
	async enrichSelected(window) {
		let items = window.ZoteroPane.getSelectedItems()
			.filter(i => i.isRegularItem());
		if (!items.length) return;

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Enrich Metadata (Readwise Sync)");
		let line = new pw.ItemProgress("chrome://zotero/skin/tick.png", "Starting…");
		pw.show();

		let counts = { enriched: 0, "ai-enriched": 0, "no-url": 0, "no-data": 0, error: 0 };
		for (let i = 0; i < items.length; i++) {
			line.setText(`Enriching ${i + 1}/${items.length}: ${items[i].getField("title").slice(0, 50)}`);
			let result = await this.enrichItem(items[i]);
			counts[result]++;
		}
		let summary = `${counts.enriched} enriched`;
		let rest = [];
		if (counts["ai-enriched"]) rest.push(`${counts["ai-enriched"]} AI-enriched`);
		if (counts["no-data"]) rest.push(`${counts["no-data"]} no new data`);
		if (counts["no-url"]) rest.push(`${counts["no-url"]} without URL`);
		if (counts.error) rest.push(`${counts.error} failed`);
		line.setText("Done: " + [summary, ...rest].join(", "));
		pw.startCloseTimer(6000);
	},

	/**
	 * Append highlights not already present in the item's Readwise note,
	 * under a "New highlights added <date>" header. Returns true if the
	 * note changed.
	 */
	async _appendNewHighlights(item, highlights) {
		let note = this._findReadwiseNote(item);
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = item.libraryID;
			note.parentItemID = item.id;
			note.setNote(this.buildNoteHTML(highlights));
			await note.saveTx();
			return true;
		}
		let existingHTML = note.getNote();
		let existingIDs = new Set();
		for (let m of existingHTML.matchAll(/read\.readwise\.io\/read\/([a-z0-9]+)/g)) {
			existingIDs.add(m[1]);
		}
		// Classic-library highlights link as readwise.io/open/<numeric id>
		for (let m of existingHTML.matchAll(/readwise\.io\/open\/(\d+)/g)) {
			existingIDs.add(m[1]);
		}
		let fresh = highlights.filter(h => !existingIDs.has(h.id));
		if (!fresh.length) return false;
		note.setNote(existingHTML + this._appendHeader() + this.buildNoteHTML(fresh));
		await note.saveTx();
		return true;
	},
};
