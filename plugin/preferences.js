/* Settings pane script: populate local-provider model dropdowns from each
   server's /v1/models endpoint. Loaded into the pane's sandbox by
   Zotero.PreferencePanes.register.

   Note: Zotero loads pane scripts BEFORE inserting the pane markup, and
   inline oncommand handlers can't see this sandbox's globals — so we wait
   for the DOM and bind buttons programmatically. */
/* global Zotero, document */

var ReadwisePrefs = {
	PREF: "extensions.readwise2zotero.",

	providers: {
		ollama: { basePref: "ollamaBaseUrl", modelPref: "ollamaModel",
			keyPref: "ollamaKey", defBase: "http://localhost:11434/v1" },
		omlx: { basePref: "omlxBaseUrl", modelPref: "omlxModel",
			keyPref: "omlxKey", defBase: "http://localhost:8000/v1" },
		local: { basePref: "localBaseUrl", modelPref: "localModel",
			keyPref: null, defBase: "http://localhost:1234/v1" },
	},

	get(name) {
		return Zotero.Prefs.get(this.PREF + name, true);
	},

	set(name, value) {
		Zotero.Prefs.set(this.PREF + name, value, true);
	},

	init() {
		for (let p of Object.keys(this.providers)) {
			let cfg = this.providers[p];
			let menulist = document.getElementById(`readwise-model-${p}`);
			if (!menulist) continue;
			menulist.value = this.get(cfg.modelPref) || "";
			let save = () => this.set(cfg.modelPref, menulist.value);
			menulist.addEventListener("command", save);
			menulist.addEventListener("change", save);

			let refresh = document.getElementById(`readwise-refresh-${p}`);
			if (refresh) {
				refresh.addEventListener("command", () => this.refreshModels(p));
			}

			// Populate quietly on pane load; unreachable servers just show
			// a note without disturbing the typed value
			this.refreshModels(p);
		}
	},

	async refreshModels(provider) {
		let cfg = this.providers[provider];
		let menulist = document.getElementById(`readwise-model-${provider}`);
		let status = document.getElementById(`readwise-status-${provider}`);
		if (!menulist) return;
		let base = (this.get(cfg.basePref) || cfg.defBase).replace(/\/$/, "");
		if (status) status.textContent = "Checking " + base + "…";
		try {
			let headers = {};
			let key = cfg.keyPref && this.get(cfg.keyPref);
			if (key) headers.Authorization = "Bearer " + key;
			let xhr = await Zotero.HTTP.request("GET", base + "/models", {
				headers, responseType: "json", timeout: 8000,
			});
			let ids = (xhr.response.data || []).map(m => m.id).filter(Boolean).sort();
			let current = menulist.value;
			let popup = menulist.menupopup
				|| menulist.querySelector("menupopup");
			popup.replaceChildren();
			for (let id of ids) {
				let mi = document.createXULElement("menuitem");
				mi.setAttribute("label", id);
				mi.setAttribute("value", id);
				popup.appendChild(mi);
			}
			menulist.value = current; // repopulating must not clobber the setting
			if (status) {
				status.textContent = ids.length
					? `${ids.length} model(s) available`
					: "Server reachable, but no models loaded";
			}
		}
		catch (e) {
			if (status) status.textContent = "Server not reachable — type a model name manually";
		}
	},
};

// The pane's markup is inserted after this script runs — poll until our
// elements exist, then initialize
(function waitForPane() {
	let attempts = 0;
	let timer = setInterval(() => {
		attempts++;
		if (document.getElementById("readwise-model-ollama")) {
			clearInterval(timer);
			try {
				ReadwisePrefs.init();
			}
			catch (e) {
				Zotero.debug("ReadwiseSync prefs init failed: " + e);
			}
		}
		else if (attempts > 150) {
			clearInterval(timer);
		}
	}, 100);
})();
