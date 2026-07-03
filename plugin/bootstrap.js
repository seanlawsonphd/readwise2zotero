var ReadwiseSync;

function log(msg) {
	Zotero.debug("ReadwiseSync (bootstrap): " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + "readwise-sync.js");
	ReadwiseSync.init({ id, version, rootURI });

	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + "preferences.xhtml",
		label: "Readwise",
		image: rootURI + "icon.svg",
		scripts: [rootURI + "preferences.js"],
	});

	// Add menu items to any windows already open
	for (let win of Zotero.getMainWindows()) {
		ReadwiseSync.addToWindow(win);
	}
}

function onMainWindowLoad({ window }) {
	ReadwiseSync.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	ReadwiseSync.removeFromWindow(window);
}

function shutdown() {
	if (ReadwiseSync) {
		for (let win of Zotero.getMainWindows()) {
			ReadwiseSync.removeFromWindow(win);
		}
		ReadwiseSync.shutdown();
		ReadwiseSync = undefined;
	}
}

function uninstall() {}
