"use strict";
/*
 * wa-native.js — mobile/offline archive layer for the Samarpan Upanishad APK.
 *
 * On a phone there is no FastAPI server: this file answers every /api/* call
 * app.js makes from an ON-DEVICE copy of wisdom.db, opened with the official
 * SQLite WebAssembly build (vendor/sqlite3.js — includes FTS5). Every response
 * reproduces app/main.py's JSON shapes exactly, including the {"detail": ...}
 * error contract and the `(date IS NULL), date DESC, id DESC` ordering.
 *
 * ACTIVATION — this file is a no-op unless one of:
 *   1. Running inside Capacitor on a device  (window.Capacitor.isNativePlatform())
 *   2. Test mode: open with ?waNativeTest=1  (persists in localStorage; ?waNativeTest=0 clears)
 * On the normal desktop app it does nothing: fetch is untouched, the wasm is
 * never downloaded, and FastAPI keeps serving /api/* as always.
 *
 * Data it needs in the web bundle (assembled by mobile/build_www.mjs):
 *   /data/wisdom.db      — the index (vacuumed out of WAL mode)
 *   /wa-mobile.json      — build manifest: versions, bundled ids, extras map, update URL
 *   /thumbs/…            — bundled thumbnails
 *   /source_data/<id>/…  — bundled full images (full build only)
 *
 * Content updates: when wa-mobile.json carries an updateBase URL, "Sync now"
 * (and a background check at launch) fetches ${updateBase}/manifest.json and,
 * if newer, downloads wisdom.db + extras.json into app storage and swaps them
 * in live. Images for new entries load from ${updateBase} and are cached to
 * app storage on first view. Without an updateBase this reports the same
 * "not_configured" state the desktop Settings page already knows how to show.
 */
(function () {
  // wa-boot.js (frozen, ships in the APK) owns activation, signature/hash
  // verification and the downloader. If it decided this is not a device -- or
  // browser test mode -- WA_BOOT is absent and there is nothing to do here.
  //
  // EVERYTHING BELOW THIS LINE UPDATES OVER THE AIR. Add features here, not in
  // wa-boot.js: a bug in this file is fixable with a publish, a bug in that one
  // is fixable only by every user reinstalling.
  const B = window.WA_BOOT;
  if (!B) return;

  const ls = B.ls;
  const cap = B.cap;
  const isNative = B.isNative;
  const b64ToBytes = B.b64ToBytes;
  const bytesToB64 = B.bytesToB64;

  window.WA_NATIVE_ACTIVE = true;

  const Plugins = (cap && cap.Plugins) || {};
  const FS = isNative ? Plugins.Filesystem : null;
  const AppPlugin = isNative ? Plugins.App : null;

  // ---------------------------------------------------------------- utilities
  const enc = new TextEncoder();
  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  function detail(msg, status) { return jsonResponse({ detail: msg }, status); }
  function normPath(p) { return (p || "").replace(/\\/g, "/"); }
  function fileNameOf(p) { const n = normPath(p); return n.slice(n.lastIndexOf("/") + 1); }
  // ---------------------------------------------------------------- state
  let sqlite3 = null;      // the wasm module
  let db = null;           // open oo1.DB handle
  let manifest = null;     // wa-mobile.json contents
  let bundledIds = new Set();       // ids whose FULL images ship inside the APK
  let bundledThumbIds = new Set();  // ids whose thumbnails ship inside the APK
  let extras = {};         // {id: [{lang, page, file}]}
  let cachedFiles = new Set();   // filenames present in the on-device image cache
  const CACHE_DIR = "wa-imgcache";
  const DB_FILE = "wa-data/wisdom.db";
  const EXTRAS_FILE = "wa-data/extras.json";

  let lastSync = { ok: null, checked_at: null, added: [], error: null };

  function contentVersion() { return ls.get("wa:mobile:contentVersion", (manifest && manifest.contentVersion) || "bundled"); }
  // ---------------------------------------------------------------- database
  function openFromBytes(bytes) {
    const d = new sqlite3.oo1.DB();
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(
      d.pointer, "main", p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );
    d.checkRc(rc);
    // fail fast if this isn't a wisdom index
    d.selectValue("SELECT COUNT(*) FROM entries");
    return d;
  }

  async function readPersisted(path) {
    if (!FS) return null;
    try {
      const r = await FS.readFile({ path, directory: "DATA" });
      return typeof r.data === "string" ? r.data : null;
    } catch { return null; }
  }
  async function writePersisted(path, b64) {
    if (!FS) return false;
    try {
      await FS.writeFile({ path, directory: "DATA", data: b64, recursive: true });
      return true;
    } catch { return false; }
  }

  async function loadDatabase() {
    // Prefer a content-updated DB in app storage; fall back to the bundled one.
    const persisted = await readPersisted(DB_FILE);
    if (persisted) {
      try { return openFromBytes(b64ToBytes(persisted)); }
      catch (e) { console.warn("wa-native: persisted DB unreadable, using bundled", e); }
    }
    const r = await fetch("/data/wisdom.db");
    if (!r.ok) throw new Error("bundled wisdom.db missing (" + r.status + ")");
    return openFromBytes(new Uint8Array(await r.arrayBuffer()));
  }

  async function loadExtras() {
    const persisted = await readPersisted(EXTRAS_FILE);
    if (persisted) {
      try { return JSON.parse(atob(persisted)); } catch {}
      try { return JSON.parse(persisted); } catch {}
    }
    return (manifest && manifest.extras) || {};
  }

  async function loadCacheIndex() {
    if (!FS) return;
    try {
      const r = await FS.readdir({ path: CACHE_DIR, directory: "DATA" });
      (r.files || []).forEach((f) => cachedFiles.add(typeof f === "string" ? f : f.name));
    } catch { /* cache dir doesn't exist yet */ }
  }

  function q(sql, bind) { return db.selectObjects(sql, bind || []); }

  // ---------------------------------------------------------------- images
  // Entries bundled in the APK serve straight from the web assets (relative
  // URLs). Entries that arrived via a content update resolve to the on-device
  // cache when present, else to the public update host (and are cached in the
  // background on first view).
  // ⚠ `cachedFiles` means "this file is ON DISK", and a download in progress is
  // NOT that. It used to be claimed up front to stop parallel views downloading
  // the same image twice, but Filesystem.getUri() happily builds a URL for a file
  // that doesn't exist — so any resolveImage() that ran during the download handed
  // back a path to nothing, and the reader showed a broken image until the app was
  // relaunched (reported 2026-08-13 on a daily-notification tap, where two renders
  // fire microseconds apart). The double-download guard now lives in its own set.
  const inFlightFiles = new Set();
  async function cacheRemote(fileName, remoteUrl) {
    if (!FS || cachedFiles.has(fileName) || inFlightFiles.has(fileName)) return;
    inFlightFiles.add(fileName);
    try {
      const r = await fetch(remoteUrl);
      if (!r.ok) throw new Error(String(r.status));
      const b64 = bytesToB64(new Uint8Array(await r.arrayBuffer()));
      await FS.writeFile({ path: CACHE_DIR + "/" + fileName, directory: "DATA", data: b64, recursive: true });
      cachedFiles.add(fileName);   // only now is it true
    } catch { /* stays uncached — callers keep using the remote URL */ }
    finally { inFlightFiles.delete(fileName); }
  }
  // Generic media persistence for content that arrives from the update host
  // AFTER this APK was built — today: Letterpad pages newer than the bundle.
  // A plain <img src="https://…"> only ever lives in the WebView's HTTP cache,
  // which is evictable and cleared by Android's "Clear cache", so those pages
  // would silently vanish offline. Writing them into the Filesystem DATA dir
  // (the same store the daily-msg image cache uses) makes them behave like
  // every other downloaded image. Bundled pages never reach here — app.js
  // serves those straight from the APK.
  // Returns a displayable local URL, or null if it couldn't be persisted (the
  // caller then just keeps using the remote URL).
  async function cacheMedia(remoteUrl) {
    if (!FS || !remoteUrl) return null;
    // Flatten the remote path into one cache filename; the host prefix is
    // dropped so a host change doesn't orphan everything already downloaded.
    const fileName = "m_" + String(remoteUrl)
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_");
    const have = await cachedUrl(fileName);
    if (have) return have;
    await cacheRemote(fileName, remoteUrl);
    return cachedUrl(fileName);
  }

  async function cachedUrl(fileName) {
    if (!FS || !cachedFiles.has(fileName) || !cap.convertFileSrc) return null;
    try {
      const u = await FS.getUri({ path: CACHE_DIR + "/" + fileName, directory: "DATA" });
      return cap.convertFileSrc(u.uri);
    } catch { return null; }
  }
  async function resolveImage(id, relPath) {
    // relPath is relative to the publish root, e.g. "source_data/3445/3445_Eng.jpg"
    // or "thumbs/3445_en.jpg".
    if (!relPath) return null;
    const rel = normPath(relPath);
    const bundled = rel.startsWith("thumbs/") ? bundledThumbIds : bundledIds;
    if (bundled.has(String(id))) return "/" + rel;
    const fileName = fileNameOf(rel);
    const local = await cachedUrl(fileName);
    if (local) return local;
    const base = B.updateBase();
    if (!base) return "/" + rel;                 // best effort: bundled path or 404
    const remote = base + "/" + rel.split("/").map(encodeURIComponent).join("/");
    if (navigator.onLine !== false) cacheRemote(fileName, remote);   // fire and forget
    return remote;
  }

  // ---------------------------------------------------------------- serializers (mirror app/main.py)
  async function entryPublic(e) {
    const ex = [];
    for (const x of extras[String(e.id)] || []) {
      ex.push({ lang: x.lang, page: x.page, url: await resolveImage(e.id, "source_data/" + e.id + "/" + x.file) });
    }
    return {
      id: e.id, date: e.date, weekday: e.weekday,
      topic_en: e.topic_en, topic_hi: e.topic_hi,
      body_en: e.body_en, body_hi: e.body_hi,
      disp_en: e.disp_en, disp_hi: e.disp_hi,
      has_en: !!(e.body_en || e.img_en_path),
      has_hi: !!(e.body_hi || e.img_hi_path),
      img_en_url: e.img_en_path ? await resolveImage(e.id, "source_data/" + normPath(e.img_en_path)) : null,
      img_hi_url: e.img_hi_path ? await resolveImage(e.id, "source_data/" + normPath(e.img_hi_path)) : null,
      thumb_url: e.thumb_path ? await resolveImage(e.id, normPath(e.thumb_path)) : null,
      extras: ex,
    };
  }
  async function card(e) {
    return {
      id: e.id, date: e.date, weekday: e.weekday,
      topic_en: e.topic_en, topic_hi: e.topic_hi,
      preview_en: (e.body_en || "").slice(0, 140),
      preview_hi: (e.body_hi || "").slice(0, 140),
      thumb_url: e.thumb_path ? await resolveImage(e.id, normPath(e.thumb_path)) : null,
      thumb_en_url: e.thumb_en_path ? await resolveImage(e.id, normPath(e.thumb_en_path)) : null,
      thumb_hi_url: e.thumb_hi_path ? await resolveImage(e.id, normPath(e.thumb_hi_path)) : null,
    };
  }
  const cards = async (rows) => { const out = []; for (const r of rows) out.push(await card(r)); return out; };

  // ---------------------------------------------------------------- search (mirror app/search.py)
  function sanToken(t) { return t.replace(/[^0-9A-Za-zऀ-ॿ]/g, ""); }
  async function runSearch(query) {
    const qy = (query || "").trim();
    if (!qy) return [];
    const tokens = qy.split(/\s+/);
    const single = tokens.length === 1;
    const exactExpr = '"' + qy.replace(/"/g, '""') + '"';
    const seen = new Set();
    const results = [];
    const run = (ftsExpr, tier) => {
      let rows = [];
      try {
        rows = q(
          "SELECT e.* FROM entries_fts JOIN entries e ON e.id = entries_fts.id " +
          "WHERE entries_fts MATCH ? " +
          "ORDER BY (e.date IS NULL), e.date DESC, e.id DESC LIMIT ?",
          [ftsExpr, 9999]
        );
      } catch { return; }
      for (const e of rows) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        results.push({
          id: e.id, date: e.date, weekday: e.weekday,
          topic_en: e.topic_en, topic_hi: e.topic_hi,
          body_en: e.body_en, body_hi: e.body_hi,
          thumb_path: e.thumb_path, tier,
        });
      }
    };
    run(exactExpr, "exact");
    if (single) {
      const tok = sanToken(tokens[0]);
      if (tok) run(tok + "*", "prefix");
    }
    for (const r of results) r.thumb_url = r.thumb_path ? await resolveImage(r.id, normPath(r.thumb_path)) : null;
    return results;
  }

  // ---------------------------------------------------------------- API handlers
  function pyToOrdinal(d) {
    // Python date.toordinal(): days since 0001-01-01 (which is 1).
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 719163;
  }

  async function handleApi(pathname, params, method) {
    let m;

    if (pathname === "/api/search") {
      const query = params.get("q") || "";
      const results = await runSearch(query);
      return jsonResponse({ query, count: results.length, results });
    }

    if (pathname === "/api/vocab") {
      // Mirror app/main.py api_vocab: distinct Devanagari words from body_hi
      // with entry counts, for the Hindi typing suggestions. Extracted from
      // the text, not the FTS index (unicode61 splits Devanagari at matras).
      if ((params.get("lang") || "hi") !== "hi") return detail("lang must be 'hi'", 400);
      const rows = q("SELECT body_hi FROM entries WHERE body_hi IS NOT NULL");
      const freq = new Map();
      for (const r of rows) {
        const seen = new Set(String(r.body_hi).match(/[ऀ-ॣॱ-ॿ]{2,}/g) || []);
        for (const w of seen) freq.set(w, (freq.get(w) || 0) + 1);
      }
      const terms = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      return jsonResponse({ lang: "hi", count: terms.length, terms });
    }

    if ((m = pathname.match(/^\/api\/entry\/([^/]+)\/neighbors$/))) {
      const rows = q(
        "WITH ordered AS (SELECT id, " +
        " LAG(id)  OVER (ORDER BY (date IS NULL), date DESC, id DESC) AS newer_id, " +
        " LEAD(id) OVER (ORDER BY (date IS NULL), date DESC, id DESC) AS older_id " +
        "FROM entries) SELECT newer_id, older_id FROM ordered WHERE id = ?",
        [decodeURIComponent(m[1])]
      );
      if (!rows.length) return detail("Wisdom not found", 404);
      return jsonResponse({ older_id: rows[0].older_id ?? null, newer_id: rows[0].newer_id ?? null });
    }

    if ((m = pathname.match(/^\/api\/entry\/([^/]+)$/))) {
      const rows = q("SELECT * FROM entries WHERE id = ?", [decodeURIComponent(m[1])]);
      if (!rows.length) return detail("Wisdom not found", 404);
      return jsonResponse(await entryPublic(rows[0]));
    }

    if (pathname === "/api/latest") {
      const limit = parseInt(params.get("limit") || "12", 10) || 12;
      const rows = q("SELECT * FROM entries ORDER BY (date IS NULL), date DESC, id DESC LIMIT ?", [limit]);
      return jsonResponse({ results: await cards(rows) });
    }

    if (pathname === "/api/daily") {
      const today = new Date();
      const md = String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
      let rows = q("SELECT * FROM entries WHERE substr(date, 6) = ? ORDER BY date DESC LIMIT 1", [md]);
      if (!rows.length) {
        const n = q("SELECT COUNT(*) AS n FROM entries")[0].n;
        if (n) {
          const off = pyToOrdinal(today) % n;
          rows = q("SELECT * FROM entries ORDER BY (date IS NULL), date ASC, id ASC LIMIT 1 OFFSET ?", [off]);
        }
      }
      if (!rows.length) return detail("No wisdom available", 404);
      return jsonResponse(await entryPublic(rows[0]));
    }

    if (pathname === "/api/browse") {
      const group = params.get("group");
      const dateP = params.get("date");
      const fromP = params.get("from");
      const toP = params.get("to");
      const year = params.get("year");
      const month = params.get("month");
      if (group === "year" || group === "month" || group === "date") {
        const expr = { year: "substr(date,1,4)", month: "substr(date,1,7)", date: "date" }[group];
        const rows = q(
          "SELECT " + expr + " AS period, COUNT(*) AS n FROM entries " +
          "WHERE date IS NOT NULL GROUP BY period ORDER BY period DESC"
        );
        return jsonResponse({ group, periods: rows.map((r) => ({ period: r.period, count: r.n })) });
      }
      if (dateP) {
        const rows = q("SELECT * FROM entries WHERE date = ? ORDER BY id DESC", [dateP]);
        return jsonResponse({ results: await cards(rows) });
      }
      if (fromP && toP) {
        const rows = q("SELECT * FROM entries WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC", [fromP, toP]);
        return jsonResponse({ results: await cards(rows) });
      }
      if (year === null) {
        const rows = q(
          "SELECT substr(date,1,7) AS ym, COUNT(*) AS n FROM entries " +
          "WHERE date IS NOT NULL GROUP BY ym ORDER BY ym DESC"
        );
        return jsonResponse({ periods: rows.map((r) => ({ period: r.ym, count: r.n })) });
      }
      const y = String(parseInt(year, 10)).padStart(4, "0");
      let rows;
      if (month === null) {
        rows = q("SELECT * FROM entries WHERE substr(date,1,4) = ? ORDER BY date DESC, id DESC", [y]);
      } else {
        const ym = y + "-" + String(parseInt(month, 10)).padStart(2, "0");
        rows = q("SELECT * FROM entries WHERE substr(date,1,7) = ? ORDER BY date DESC, id DESC", [ym]);
      }
      return jsonResponse({ results: await cards(rows) });
    }

    if (pathname === "/api/random") {
      // Math.random() (device entropy) rather than SQL RANDOM(): guarantees a
      // different pick per tap on every phone ("Guru's unique msg").
      const total = q("SELECT COUNT(*) AS n FROM entries")[0].n;
      const rows = total
        ? q("SELECT * FROM entries LIMIT 1 OFFSET ?", [Math.floor(Math.random() * total)])
        : [];
      if (!rows.length) return detail("No wisdom available", 404);
      return jsonResponse(await entryPublic(rows[0]));
    }

    if (pathname === "/api/version") {
      // Prefer the applied OTA UI version (what's actually running) over the
      // bundled wa-mobile.json version, so About is right after an OTA update.
      return jsonResponse({ version: ls.get("wa:mobile:uiVersion", "") || (manifest && manifest.version) || "mobile" });
    }

    if (pathname === "/api/stats") {
      const total = q("SELECT COUNT(*) AS n FROM entries")[0].n;
      const thisYear = q("SELECT COUNT(*) AS n FROM entries WHERE substr(date,1,4) = ?", [String(new Date().getFullYear())])[0].n;
      const days = q("SELECT COUNT(DISTINCT date) AS n FROM entries WHERE date IS NOT NULL")[0].n;
      return jsonResponse({ total, this_year: thisYear, days_covered: days });
    }

    if (pathname === "/api/sync") {
      if (method === "POST") return jsonResponse(await syncOnce());
      return jsonResponse({ ...lastSync });
    }

    if ((m = pathname.match(/^\/api\/admin\/exists\/([^/]+)$/))) {
      const rows = q("SELECT id, date, topic_en, topic_hi FROM entries WHERE id = ?", [decodeURIComponent(m[1])]);
      if (!rows.length) return jsonResponse({ exists: false });
      const e = rows[0];
      return jsonResponse({ exists: true, id: e.id, date: e.date, topic: e.topic_en || e.topic_hi });
    }

    if (pathname === "/api/admin/import") {
      return detail("Adding Guru's msg is done from the desktop app — new entries reach this app automatically via Sync.", 403);
    }

    return detail("Not found", 404);
  }

  // ---------------------------------------------------------------- content updates
  // Reentrancy guard: a successful sync swaps `db` and closes the instance it
  // replaced, so two overlapping runs can close the live database out from under
  // the app. Every concurrent caller (this file's launch sync, plus app.js's
  // notification-tap / resume syncs) awaits the SAME run. app.js checks
  // WA_NATIVE.syncCoalesced to know it may call sync() freely on this shell.
  let syncing = null;
  function syncOnce() {
    if (!syncing) syncing = syncNow().finally(() => { syncing = null; });
    return syncing;
  }

  async function syncNow() {
    const result = { ok: false, checked_at: Date.now() / 1000, added: [], error: null };
    const base = B.updateBase();
    if (!base) {
      result.ok = true;
      result.error = "not_configured";
      lastSync = result;
      return result;
    }
    try {
      // The frozen shell fetches the manifest, follows any relocation, and
      // proves the signature. It throws rather than returning something
      // unverified, so reaching the next line means the payload is ours.
      const checked = await B.fetchVerifiedManifest(base);
      const live = checked.base;
      const remote = checked.remote;
      if (checked.relocated) result.relocated = checked.relocated;

      // ---- content (wisdom.db + extras.json)
      if (remote.content_version && remote.content_version !== contentVersion()) {
        const dbr = await fetch(live + "/wisdom.db", { cache: "no-store" });
        if (!dbr.ok) throw new Error("wisdom.db HTTP " + dbr.status);
        const bytes = new Uint8Array(await dbr.arrayBuffer());
        // ~1.5 MB over a phone connection is the transfer most likely to be
        // silently truncated. This hash is covered by the manifest signature,
        // so it rejects both a partial download and a swapped file.
        if (checked.signed && remote.db_sha256) {
          const got = await B.sha256Hex(bytes);
          if (got !== remote.db_sha256) throw new Error("wisdom.db hash mismatch");
        }
        const fresh = openFromBytes(bytes);   // validates before anything is replaced

        let freshExtras = extras;
        try {
          const xr = await fetch(live + "/extras.json", { cache: "no-store" });
          if (xr.ok) freshExtras = await xr.json();
        } catch {}

        const before = new Set(q("SELECT id FROM entries").map((r) => r.id));
        const after = fresh.selectObjects("SELECT id FROM entries").map((r) => r.id);
        result.added = after.filter((id) => !before.has(id)).sort();

        const old = db;
        db = fresh;
        extras = freshExtras;
        try { old.close(); } catch {}

        await writePersisted(DB_FILE, bytesToB64(bytes));
        await writePersisted(EXTRAS_FILE, btoa(unescape(encodeURIComponent(JSON.stringify(freshExtras)))));
        ls.set("wa:mobile:contentVersion", remote.content_version);
      }

      // ---- code (styles.css / app.js / wa-supabase.js / supabase.js / this
      // file). Downloaded and hash-checked by the frozen shell, applied on the
      // NEXT launch -- never swapped under a live session.
      const code = await B.downloadCode(live, remote, checked.signed);
      if (code.updated) result.ui_updated = code.updated;
      if (code.blocked) result.ui_blocked = code.blocked;

      result.ok = true;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      result.error = /^signature:/.test(msg) ? msg : "network: " + msg;
    }
    lastSync = result;
    return result;
  }

  // Android hardware/gesture BACK is handled by the mobile shell in app.js
  // (MOBILE_UI registers the Capacitor listener itself). Kept out of this file
  // on purpose: app.js updates over-the-air, so back-button behaviour can be
  // fixed without shipping a new APK.

  // ---------------------------------------------------------------- settings page enhancement
  // Called by app.js at the end of renderInfo("settings") — see the guarded
  // one-liner there. Keeps all mobile-only UI in this file.
  function enhanceSettings() {
    const prose = document.querySelector(".content .prose");
    if (!prose) return;
    // The stock Settings text talks about desktop-only things (reimport.bat,
    // local browser storage) — reword for the phone.
    const firstP = prose.querySelector("p");
    if (firstP) firstP.innerHTML = "Samarpan Upanishad runs fully on this device — the entire archive works offline. Your <strong>favorites</strong> and <strong>notes</strong> are stored privately in this app.";
    const tips = prose.querySelector("ul");
    if (tips) tips.remove();
    // Note: the old fixed-time "Daily Reminder" local notification has been
    // replaced by a real push notification that only fires when a new entry
    // is actually published (app.js initPush(), channel "daily_wisdom") — no
    // settings toggle needed here; it follows the OS's own notification
    // permission like Special Messages and Letterpad already do.
  }

  // ---------------------------------------------------------------- boot + fetch patch
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  (async function boot() {
    try {
      manifest = await B.loadBootManifest();
      bundledIds = new Set((manifest.bundledIds || []).map(String));
      bundledThumbIds = new Set((manifest.bundledThumbIds || manifest.bundledIds || []).map(String));
      // The official SQLite wasm build ships as an ES module; sqlite3.wasm sits
      // next to it in /vendor/ so the module finds it on its own.
      const mod = await import("/vendor/sqlite3.mjs");
      sqlite3 = await mod.default({ print: () => {}, printErr: () => {} });
      db = await loadDatabase();
      extras = await loadExtras();
      await loadCacheIndex();
      readyResolve();
    } catch (e) {
      console.error("wa-native: boot failed", e);
      readyReject(e);
    }

    // Post-boot chores — never block the first page paint.
    if (B.updateBase()) {
      syncOnce().then((r) => {
        if (r.added && r.added.length && typeof window.toast === "function") {
          window.toast("Added " + r.added.length + " new Guru's msg" + (r.added.length === 1 ? "" : "s"));
          // Repaint any home route, INCLUDING "#/?latest=1" — where a daily-
          // message notification tap lands. The old exact-match test skipped it,
          // so the tap kept showing the previous day until a second relaunch.
          if (/^#?\/?(\?.*)?$/.test(location.hash || "")) window.safeRoute && window.safeRoute();
        }
      });
    }
  })();

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let u;
    try {
      const raw = typeof input === "string" ? input : (input && input.url) || String(input);
      u = new URL(raw, location.origin);
    } catch { return realFetch(input, init); }
    if (u.origin !== location.origin || !u.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = ((init && init.method) || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
    return ready.then(
      () => handleApi(u.pathname, u.searchParams, method),
      (e) => detail("The archive could not be opened on this device: " + (e && e.message ? e.message : e), 500)
    ).catch((e) => {
      console.error("wa-native: handler error for", u.pathname, e);
      return detail("Internal error in the offline archive.", 500);
    });
  };

  // ---------------------------------------------------------------- public facade
  window.WA_NATIVE = {
    active: true,
    isNative,
    testMode: B.testMode,
    ready,
    enhanceSettings,
    sync: syncOnce,
    syncCoalesced: true,     // app.js capability probe — see syncOnce() above
    cacheMedia,
    // A function, not a string: the facade is built before boot() has read
    // wa-mobile.json, so a value snapshotted here would always be "". app.js uses
    // it to rebuild a public image URL when an on-device one fails to load, and
    // falls back to fetching wa-mobile.json itself on shells without this.
    updateBase: B.updateBase,
  };
})();
