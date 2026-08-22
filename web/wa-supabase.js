"use strict";
// ==========================================================================
// Samarpan Upanishad — Supabase community client (Phase 1).
//
// The archive (search, entries, images) stays on the LOCAL FastAPI app. Only
// chat + accounts live in the cloud now, on Supabase. This file creates the
// Supabase client and exposes `window.WA` — a small facade whose methods return
// the SAME shapes the old /api/auth and /api/chat endpoints did, so app.js's
// rendering code barely changes.
//
// The anon (public) key is meant to ship in the app; Row Level Security on the
// Supabase side (see supabase/schema.sql) is what actually protects the data.
// ==========================================================================

const WA_SUPABASE_URL = "https://psdfwpsddjmoqrrhwlns.supabase.co";
const WA_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzZGZ3cHNkZGptb3Fycmh3bG5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NzAzNjgsImV4cCI6MjA5OTI0NjM2OH0.8lwLmyk5LofnHrtWgCldWVi9wn7XPAKIC14L9iB6lS0";

// ---- Admin device binding (Phase 4 — ADMIN_DEVICE_BINDING_PLAN.md) --------
// Proof that this request comes from an enrolled admin device: "<device_id>.<token>",
// obtained from the device-auth Edge Function and read by wa_device_ok() in Postgres.
//
// ⚠ IN MEMORY ONLY, never localStorage. It is a 12h bearer token, and the whole
// point of the feature is that the credential cannot be lifted off the machine.
// Persisting it would put a copy at rest next to a key that deliberately isn't.
// The cost is one challenge/sign round trip per app launch, which the user must
// never see or act on — see _deviceEnsureKey() for why the key is no longer
// bound to a recent screen unlock.
let _deviceHeader = null;

// Single-flight guard for deviceSignIn(). NOT an optimisation — a correctness
// requirement. device-auth keeps ONE outstanding challenge per device and
// DELETEs any earlier one when issuing a new nonce, so two overlapping
// handshakes clobber each other: the first's verify finds no row and fails with
// "Challenge not found", which reads to the user as a broken device.
//
// Overlap is the normal case, not a rare one: startApp() fires deviceSignIn()
// without awaiting it, and the Moderator page calls it again the moment it
// paints. Both callers now share one in-flight promise.
let _deviceSignInFlight = null;

// supabase-js fixes `global.headers` at createClient time, and the header has to
// be able to appear (and change) later. A custom fetch is the supported way to
// do that, and it covers PostgREST, RPC, Storage and Functions in one place.
//
// ⚠ It does NOT cover Realtime, which is a WebSocket and carries no headers.
// See the Realtime note on WA.deviceSignIn().
function _waFetch(input, init) {
  init = init || {};
  const h = new Headers(init.headers || {});
  if (_deviceHeader) h.set("x-wa-device", _deviceHeader);
  return fetch(input, { ...init, headers: h });
}

const _sb = supabase.createClient(WA_SUPABASE_URL, WA_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "wa:sb-session" },
  global: { fetch: _waFetch },
});

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Turn a Supabase Auth error into the plain-English text the old API returned.
function _authMsg(error) {
  const m = (error && error.message) || "Something went wrong.";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/already registered|already exists/i.test(m)) return "An account with that email already exists.";
  if (/email not confirmed/i.test(m)) return "Please verify your email first — we'll send you a new code.";
  if (/token has expired|expired or is invalid|invalid.*token/i.test(m))
    return "That code is wrong or has expired. Tap “Send a new code” to get another.";
  if (/only request this after|rate limit|too many/i.test(m))
    return "Too many attempts. Please wait a minute, then try again.";
  if (/email.*confirm|confirm.*email/i.test(m)) return "Please confirm your email, then sign in.";
  // Offline / DNS / server unreachable — fetch rejects with a bare "Failed to fetch".
  if (/failed to fetch|networkerror|network request failed/i.test(m))
    return "No internet connection. Please connect and try again.";
  return m;
}

// True when a Supabase session is on disk, WITHOUT touching the network.
// The hard startup gate (AUTH_GATE in app.js) needs this: an access token
// expires hourly, so an offline launch must be judged on "is there a stored
// session at all", never on whether it can be refreshed right now. Otherwise a
// signed-in user with no signal gets locked out of fully-cached content.
function _hasStoredSession() {
  try {
    const raw = localStorage.getItem("wa:sb-session");
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && (s.refresh_token || (s.currentSession && s.currentSession.refresh_token)));
  } catch (_) { return false; }
}

// A profile row → the `user` object the UI uses (matches auth.py _public_user).
function _userFromProfile(p) {
  return {
    id: p.id, username: p.username, role: p.role, email: p.email,
    chat_muted: !!p.chat_muted, created: p.created,
    // Samuhik Satsang push preference. Defaults to ON when the column doesn't
    // exist yet (the notifications section of schema.sql hasn't been run), so a
    // partially-applied schema never reads as "the user muted this".
    notify_satsang: p.notify_satsang === undefined ? true : !!p.notify_satsang,
  };
}
// The single row -> message mapper. Every new column lands here, once.
// The reply fields are DENORMALISED on the row (add_satsang_chat.sql §1), so a
// quote renders with no join and survives its parent being removed. They read as
// undefined against a database where the migration hasn't been run yet — the UI
// simply draws no quote, which is the correct pre-migration behaviour.
function _mapMsg(row) {
  return {
    id: row.id, user: row.username, text: row.text, ts: row.created_at,
    replyTo: row.reply_to || null,
    replyUser: row.reply_user || null,
    replySnippet: row.reply_snippet || null,
    deletedAt: row.deleted_at || null,
    attachments: Array.isArray(row.attachments) ? row.attachments : null,
    // Admin Talks system lines ("X was added"). Never set on an ordinary
    // message, and never settable by a client — Postgres blanks it on insert
    // unless admin_talk_system_msg() is the one writing (add_admin_talks.sql §3).
    sys: row.sys || null,
  };
}

// Friendly text when the admin_messages table hasn't been created yet (the
// schema addition must be run once in the Supabase dashboard).
function _tableMissing(error) {
  return /admin_messages.*(does not exist|not find|schema cache)/i.test(error.message || "")
    ? "The message box isn't set up yet. (Admin: run the admin_messages section of supabase/schema.sql.)"
    : null;
}

// The same service for the threaded Msg to Admin (ADMIN_MSG_PLAN.md). A server
// that has the ORIGINAL admin_messages table but has not run
// add_admin_msg_threads.sql answers "function not found" to the four RPCs and
// "column not found" to the reply insert — neither of which anyone outside this
// repo can act on. Name the file instead.
//
// ⚠ Matches on the RPC/COLUMN names rather than on "admin", because
// _tableMissing above already owns the case where the whole table is absent and
// its sentence names a different file.
function _adminMsgErr(error) {
  const m = (error && error.message) || "";
  const missing = /admin_msg_thread|admin_msg_threads_list|admin_msg_unread|set_admin_msg_done|thread_user_id|from_admin/i.test(m)
    && /does not exist|not find|schema cache|column/i.test(m);
  return missing
    ? "Msg to Admin isn't set up on the server yet. (Admin: run supabase/add_admin_msg_threads.sql.)"
    : null;
}

// Friendly text when the user_data backup table hasn't been created yet.
function _userDataMissing(error) {
  return /user_data.*(does not exist|not find|schema cache)/i.test(error.message || "")
    ? "Backup isn't set up yet. (Admin: run the user_data section of supabase/schema.sql.)"
    : null;
}

// Friendly text when the access_requests section hasn't been run yet. Matched on
// the RPC name too: a missing FUNCTION reports "Could not find the function
// public.request_community_access…", which never mentions the table.
function _accessMissing(error) {
  const m = (error && error.message) || "";
  return /access_requests|access_request|community_access/i.test(m) &&
    /does not exist|not find|schema cache/i.test(m)
    ? "Samuhik Satsang access requests aren't set up yet. (Admin: run the access_requests section of supabase/schema.sql.)"
    : null;
}

// Friendly text when the Anubhuti Sharing section hasn't been run yet. Matched
// on the RPC name too, since a missing FUNCTION reports "Could not find the
// function public.list_anubhuti_topics…" and never names the table.
//
// Unlike the Samuhik Satsang index, there is NO client-side fallback to fall
// back to: a sharing's title exists nowhere but this table, so the UI has to
// say so rather than quietly render an empty list.
function _anubhutiMissing(error) {
  const m = (error && error.message) || "";
  return /anubhuti/i.test(m) && /does not exist|not find|schema cache/i.test(m)
    ? "Anubhuti Sharing isn't set up yet. (Admin: run supabase/add_anubhuti.sql.)"
    : null;
}

// ---- Admin Talks ----------------------------------------------------------
// The sutradhar + moderators' private room. ONE fixed thread, so the wid is a
// constant rather than something a caller composes — there is no second room to
// address and nothing to derive it from.
//
// ⚠ This constant is only an address. Nothing here decides who may read or
// write it: `messages_select`/`messages_insert` branch on the 'admin:' prefix in
// Postgres (add_admin_talks.sql §5), which is the only check that survives
// someone calling PostgREST with the anon key instead of loading this file.
// ⚠ Underscored because app.js declares its own ADMIN_TALKS_WID at top level.
// Both files are CLASSIC scripts sharing one lexical global scope, so two
// top-level `const`s of the same name is a SyntaxError that kills the entire
// app on load — not a shadowed variable. Same reason every other helper in
// this file is prefixed. app.js reads the value from WA.ADMIN_TALKS_WID.
const _ADMIN_TALKS_WID = "admin:talks";
// Matches the whole reserved namespace, not just the one room — the RLS
// carve-outs are written against 'admin:%', so any client-side "is this
// private?" test has to cover exactly the same set.
const _isAdminWid = (wid) => /^admin:/.test(String(wid || ""));

// Friendly text when add_admin_talks.sql hasn't been run. Matched on the RPC
// name as well as the table, since a missing FUNCTION reports "Could not find
// the function public.list_admin_talk_members…" and never names a table.
function _adminTalksMissing(error) {
  const m = (error && error.message) || "";
  return /admin_talk/i.test(m) && /does not exist|not find|schema cache/i.test(m)
    ? "Admin Talks isn't set up on the server yet. (Admin: run supabase/add_admin_talks.sql.)"
    : null;
}

// Friendly text when the special_messages table hasn't been created yet.
function _specialMissing(error) {
  return /special_messages.*(does not exist|not find|schema cache)/i.test(error.message || "")
    ? "Special messages aren't set up yet. (Admin: run the special_messages section of supabase/schema.sql.)"
    : null;
}
const _SPECIAL_COLS =
  "id,title_hi,title_en,body_hi,body_en,signature,place_hi,place_en,msg_date,posted_at,published,created_at,updated_at";

// Friendly text when add_broadcast.sql hasn't been run. Matched on the RPC
// names too: a missing FUNCTION reports "Could not find the function
// public.approve_broadcast…" and never names the table.
function _broadcastMissing(error) {
  const m = (error && error.message) || "";
  return /broadcast/i.test(m) && /does not exist|not find|schema cache/i.test(m)
    ? "Important Updates aren't set up on the server yet. (Admin: run supabase/add_broadcast.sql.)"
    : null;
}
// The same service for the Upanishad Ganga suggestions. Everything the member's
// box and the review screen do goes through an RPC, so a server that has not run
// the SQL answers "function not found" to all of them — which is a sentence
// nobody outside this repo can act on. Name the file instead.
//
// ⚠ Matches on the FUNCTION NAMES rather than on the word "ganga", because
// several of these RPCs (wa_recent_thoughts) are not named for the feature and a
// genuine constraint violation mentioning "ganga_declined_has_reason" must be
// shown to the admin as itself, not rewritten into "run the SQL".
function _gangaErr(error) {
  const m = (error && error.message) || "";
  const missing = /submit_ganga|approve_ganga|decline_ganga|add_ganga|list_ganga|my_ganga|ganga_char_limit|ganga_similar/i.test(m)
    && /does not exist|not find|schema cache/i.test(m);
  return missing
    ? "Upanishad Ganga suggestions aren't set up on the server yet. (Admin: run supabase/add_ganga_suggestions.sql.)"
    : m;
}

// ⚠ ONE language, exactly as typed — no _hi/_en pair, deliberately unlike
// _SPECIAL_COLS. See BROADCAST_PLAN.md §2.1; don't "fix" the missing pair.
const _BROADCAST_COLS =
  "id,title,body,attachments,author_id,author_name,approved_by,approver_name,approved_at," +
  "published,posted_at,edited_at,notified_at,notified_devices,notified_sent,created_at,updated_at," +
  "expires_on,declined_at,declined_by,decliner_name,decline_reason";

// Today in IST as YYYY-MM-DD. India is a fixed UTC+5:30 with no DST, so the
// offset is a constant and not worth a timezone library.
//
// ⚠ Used ONLY to ask the server for updates that have not expired. It is a
// coarse, day-level filter: an update expiring today is still delivered, and
// dies at 23:59 IST by the client's own clock (bcExpired in app.js) and by the
// nightly sweep (§11 of add_broadcast.sql). Three cuts of the same moment, and
// the day-level one is deliberately the loosest — a phone whose clock is a few
// hours out must not lose an update a day early.
function _istToday() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}
const _NOT_EXPIRED = () => "expires_on.is.null,expires_on.gte." + _istToday();

// ⚠ CACHED, briefly. This is the hottest read in the app: getChat() and
// postMessage() both call it, so before the cache EVERY message sent cost a
// profiles round trip before the insert even started — the single biggest
// part of the delay between tapping Send and seeing the bubble.
//
// Safe to cache because nothing here is a permission check: role and
// chat_muted are enforced by RLS in Postgres (see the messages insert policy
// in schema.sql), and these copies only decide which controls the UI offers.
// A stale copy therefore costs a differently-worded error, never a wrongly
// allowed action. me() — the boot-time role refresh — passes {fresh:true} and
// refills the cache, and logout() drops it.
const PROFILE_TTL_MS = 120000;
let _profCache = null;                   // {uid, at, user}
function _dropProfileCache() { _profCache = null; }
async function _loadProfile(uid, opts) {
  if (!(opts && opts.fresh) && _profCache && _profCache.uid === uid &&
      Date.now() - _profCache.at < PROFILE_TTL_MS) return _profCache.user;
  const { data, error } = await _sb.from("profiles").select("*").eq("id", uid).single();
  if (error) throw new Error(error.message);
  const user = _userFromProfile(data);
  _profCache = { uid, at: Date.now(), user };
  return user;
}
async function _rpc(name, args) {
  const { data, error } = await _sb.rpc(name, args || {});
  if (error) throw new Error(error.message);
  return data;
}

// ---- Device key: one abstraction, two backends ----------------------------
// Android  → the WaDeviceKey Capacitor plugin (Android Keystore).
// Windows  → POST /api/device/* on the local FastAPI app (DPAPI).
// Everything above this line is platform-blind, the same way wa-native.js
// answers /api/* on-device without the rest of the app knowing.
//
// ⚠ NATIVE CODE NEVER SHIPS OTA. publish_update.py sends only app.js/styles.css/
// wa-supabase.js/vendor, so an already-installed APK has NO WaDeviceKey plugin
// and will not get one until a new APK. This file therefore has to treat a
// missing plugin as a normal state and say "update the app", not throw.
function _devicePlugin() {
  const c = window.Capacitor;
  return (c && c.Plugins && c.Plugins.WaDeviceKey) || null;
}
function _isNative() {
  const c = window.Capacitor;
  return !!(c && typeof c.isNativePlatform === "function" && c.isNativePlatform());
}

// Friendly text when this shell simply cannot hold a key.
function _noSignerMessage() {
  return _isNative()
    ? "This version of the app can't register a device yet. Please update the app from the Play Store."
    : "Device registration isn't available here. On a computer, open the app from the Samarpan Upanishad desktop program (Windows only).";
}

async function _localDevice(path, body) {
  const r = await fetch("/api/device/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.detail) || "The desktop app could not reach its device key.");
  return j;
}

// {supported, hasKey, platform, label} — what the enrol screen needs to decide
// what to show. Never throws: "can't" is an answer, not an error.
async function _deviceCapabilities() {
  const p = _devicePlugin();
  if (p) {
    try {
      const a = await p.isAvailable();
      const k = await p.hasKey();
      return {
        supported: true, platform: "android",
        hasKey: !!k.hasKey, strongBox: !!a.strongBox,
        // A Keystore key that requires user authentication cannot even be
        // CREATED without a screen lock, so the UI must say so up front rather
        // than let the user meet a bare failure.
        secureLockScreen: !!a.secureLockScreen, label: null,
      };
    } catch (e) {
      return { supported: false, hasKey: false, reason: (e && e.message) || String(e) };
    }
  }
  if (_isNative()) return { supported: false, hasKey: false, reason: _noSignerMessage() };
  try {
    const s = await _localDevice("status");
    return {
      supported: !!s.supported, platform: "windows",
      hasKey: !!s.hasKey, label: s.label || null,
      secureLockScreen: true, strongBox: false,
      reason: s.reason || null,
    };
  } catch (_) {
    return { supported: false, hasKey: false, reason: _noSignerMessage() };
  }
}

// Create the keypair if absent; return its public half. Idempotent on both
// platforms — neither backend ever replaces a key the Sutradhar already approved.
//
// ⚠ requireAuth:false IS DELIBERATE, and it is the fix for "the app asks me to
// confirm this device on every single launch".
//
// The plugin's default is requireAuth:true with a 60-SECOND validity window
// (WaDeviceKeyPlugin.DEFAULT_AUTH_VALIDITY_SECONDS). That window is measured
// from the phone's last UNLOCK, not from app launch, so it is expired by the
// time anyone who unlocked their phone and then did something else opens this
// app. Signing then throws UserNotAuthenticated → AUTH_REQUIRED, the silent
// boot handshake fails, and the Moderator page falls back to its "Unlock to
// continue / Try again" card. Every launch. The card's own retry only works
// because tapping it happens to land inside a fresh window.
//
// What we give up: the key is no longer tied to a RECENT unlock. What we keep
// is the thing the whole design rests on — the private key is generated inside
// the Android Keystore, is unexportable, and is scoped to this app's UID, so it
// cannot be copied to another phone no matter what. That, not the unlock timer,
// is what makes a device a device.
//
// What we give up is also close to nothing in practice: reaching this app at all
// already requires getting past the phone's lock screen AND a stored Supabase
// session, so an attacker who could use the key without the timer could equally
// have used it within the 60s window they just created by unlocking.
//
// The "admin phones must have a screen lock" POLICY is kept — it just moves to
// the JS side, where paintDeviceBox() refuses to offer enrolment when
// caps.secureLockScreen is false. Do not remove that check thinking this line
// replaced it; the native guard it used to ride on only runs when requireAuth
// is true.
//
// ⚠ This only affects keys created from here on. A key already on a phone has
// its 60s window baked in at generation time and cannot be re-parameterised —
// that device must delete its key and enrol again (WA.deleteDeviceKey()).
async function _deviceEnsureKey() {
  const p = _devicePlugin();
  if (p) {
    const r = await p.generateKey({ requireAuth: false });
    return { publicKey: r.publicKey, platform: "android", label: null };
  }
  if (_isNative()) throw new Error(_noSignerMessage());
  const r = await _localDevice("enroll", {});
  return { publicKey: r.publicKey, platform: "windows", label: r.label || null };
}

// Destroy this machine's key. The ONLY way back from a key that can no longer
// be used — a 60s-window key from before the fix above, or one Android
// invalidated when the screen lock changed (KEY_INVALIDATED).
//
// ⚠ IRREVERSIBLE, and it costs a Sutradhar approval to undo: the new key has a
// new public half, so the server no longer recognises this device and it must
// go through enrolment again. Callers must revoke the stale admin_devices row
// first — wa_device_cap() bounds an account at 3 devices, and abandoned rows
// count towards it.
async function _deviceDeleteKey() {
  const p = _devicePlugin();
  if (p) { await p.deleteKey(); return; }
  if (_isNative()) throw new Error(_noSignerMessage());
  await _localDevice("delete", {});
}

// The actual handshake behind WA.deviceSignIn(). Kept out of the WA object so
// the public method can stay a thin single-flight wrapper — see
// _deviceSignInFlight for why sharing one in-flight run is mandatory and not
// merely tidy.
async function _deviceSignIn() {
  let caps;
  try { caps = await _deviceCapabilities(); } catch (_) { return false; }
  if (!caps.supported || !caps.hasKey) return false;

  // Which of this account's active devices is THIS one? We don't ask — we try
  // each in turn and let the signature settle it. list_my_devices() doesn't
  // return public keys (deliberately: no reason to hand them out), and a
  // device id cached in localStorage would be a guess that outlives the key
  // it names. Trying is cheap and self-verifying: signing a challenge issued
  // for another device produces a signature that fails against that device's
  // stored key, which is exactly the right answer. wa_device_cap() bounds the
  // loop at 3.
  let mine;
  try { mine = await _rpc("list_my_devices"); } catch (_) { return false; }
  const rows = (mine && mine.devices) || [];
  const active = rows.filter((d) => d.status === "active");
  if (!active.length) return false;

  for (const d of active) {
    try {
      const ch = await _sb.functions.invoke("device-auth", {
        body: { action: "challenge", device_id: d.id },
      });
      if (ch.error || !ch.data || !ch.data.ok) continue;
      // Sign what the function handed back, never a locally rebuilt string —
      // the format must match byte for byte or verification silently fails.
      const signature = await _deviceSign(ch.data.sign_this);
      const vr = await _sb.functions.invoke("device-auth", {
        body: { action: "verify", device_id: d.id, nonce: ch.data.nonce, signature },
      });
      if (vr.error || !vr.data || !vr.data.ok) continue;
      _deviceHeader = vr.data.header;
      return true;
    } catch (e) {
      // AUTH_REQUIRED (phone not unlocked recently enough) and KEY_INVALIDATED
      // are the two the caller must be able to act on; everything else is just
      // "this device didn't work".
      //
      // AUTH_REQUIRED should now be unreachable for keys created after the
      // requireAuth:false change in _deviceEnsureKey(). It stays because keys
      // generated by the old code still exist on already-enrolled phones, and
      // for them this message is the one accurate thing we can say.
      const code = (e && (e.code || e.message)) || "";
      if (/AUTH_REQUIRED|unlock your phone/i.test(code)) {
        throw new Error("Please unlock your phone, then try again.");
      }
      if (/KEY_INVALIDATED|no longer valid/i.test(code)) {
        throw new Error("This device's key is no longer valid. Please register it again.");
      }
    }
  }
  return false;
}

async function _deviceSign(payload) {
  const p = _devicePlugin();
  if (p) {
    const r = await p.sign({ payload });
    return r.signature;
  }
  if (_isNative()) throw new Error(_noSignerMessage());
  const r = await _localDevice("sign", { payload });
  return r.signature;
}

// ---- Admin chat polling fallback ------------------------------------------
// WHY THIS EXISTS: Phase 6 shipped as "Option B" — moderators and the Sutradhar
// need an approved device to READ the community, not just to write to it. The
// device proof is an HTTP header, and Supabase Realtime is a WebSocket, which
// carries no headers. So `request.headers` is unset when Postgres evaluates RLS
// for a postgres_changes subscription and every gated row is filtered out.
//
// The effect on an admin, once enforcement is on: messages, reactions and pin
// changes never arrive live. Typing and presence still do (they ride
// `broadcast`/`presence`, which RLS never sees), so the thread would show
// "X is typing…" and then nothing — reading as broken rather than as slow.
//
// This poller closes that hole by re-fetching over PostgREST, which DOES carry
// the header. It runs alongside Realtime rather than replacing it: double
// delivery is already harmless because the UI dedupes on `data-mid`, and
// keeping both means the thread behaves identically whether enforcement is on
// or off, with no flag day.
//
// ⚠ Deliberately a SNAPSHOT DIFF, not a "created_at > since" query. Deleting a
// message is an UPDATE that stamps `deleted_at` (there is no `updated_at`
// column), so a since-query would deliver new messages but never tombstones.
// Diffing the recent window catches both with one fetch.
// How many messages a chat holds at a time, and how many one scroll-up adds.
// Small enough that a months-old satsang opens as fast as a new one; large
// enough that a phone screen is full and the reader is not paging constantly.
const CHAT_PAGE_SIZE = 30;
const CHAT_POLL_MS = 6000;
const CHAT_POLL_WINDOW = 60;

function _startChatPoll(wid, h) {
  let stopped = false, busy = false, primed = false;
  const msgs = new Map();     // id  -> deleted_at (null when live)
  const reacts = new Map();   // key -> {mid, user, emoji}
  let pin;                    // undefined = not yet known, null = nothing pinned

  async function tick() {
    // `primed` is what stops the first pass replaying the whole thread as if it
    // had just arrived: pass one records what is already on screen and fires
    // nothing.
    if (stopped || busy) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    busy = true;
    try {
      // Selects `*` for the same reason communityRecent() does — naming
      // deleted_at errors on a project where that migration hasn't run.
      const { data: rows } = await _sb.from("messages").select("*")
        .eq("wisdom_id", wid).order("created_at", { ascending: false })
        .limit(CHAT_POLL_WINDOW);
      if (rows) {
        // Oldest first, so a burst lands in the order it was sent and message
        // grouping resolves the same way a reload would.
        rows.slice().reverse().forEach((r) => {
          const now = r.deleted_at || null;
          if (!msgs.has(r.id)) {
            msgs.set(r.id, now);
            if (primed && h.onMessage) h.onMessage(_mapMsg(r));
          } else if (msgs.get(r.id) !== now) {
            msgs.set(r.id, now);
            if (h.onUpdate) h.onUpdate(_mapMsg(r));
          }
        });
      }

      const { data: rx } = await _sb.from("message_reactions")
        .select("message_id,username,emoji").eq("wisdom_id", wid);
      if (rx) {
        const seen = new Set();
        rx.forEach((r) => {
          const k = `${r.message_id}|${r.username}|${r.emoji}`;
          seen.add(k);
          if (!reacts.has(k)) {
            const ev = { mid: r.message_id, user: r.username, emoji: r.emoji };
            reacts.set(k, ev);
            if (primed && h.onReact) h.onReact(ev);
          }
        });
        // Stored as objects, not parsed back out of the key: message_id is a
        // uuid today but splitting a composite key to rebuild an event is the
        // kind of thing that breaks silently if that ever changes.
        Array.from(reacts.keys()).forEach((k) => {
          if (seen.has(k)) return;
          const ev = reacts.get(k);
          reacts.delete(k);
          if (primed && h.onUnreact) h.onUnreact(ev);
        });
      }

      const { data: pr } = await _sb.from("thread_pins")
        .select("message_id").eq("wisdom_id", wid).maybeSingle();
      const cur = (pr && pr.message_id) || null;
      if (pin !== undefined && cur !== pin && h.onPin) h.onPin(cur);
      pin = cur;

      primed = true;
    } catch (_) {
      // Offline or a transient failure — say nothing and try again next tick.
      // Never surface this: the thread is still perfectly readable.
    }
    busy = false;
  }

  // Coming back from the background should feel instant, not wait out the
  // interval — a phone resumed after an hour is exactly when there is most to
  // catch up on.
  const onVis = () => { if (document.visibilityState === "visible") tick(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);

  tick();
  const timer = setInterval(tick, CHAT_POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  };
}

// Friendly text when add_admin_devices.sql hasn't been run on this project yet.
function _devicesMissing(error) {
  const m = (error && error.message) || "";
  return /admin_device|enroll_device|device_request/i.test(m) &&
    /does not exist|not find|schema cache/i.test(m)
    ? "Device registration isn't set up yet. (Admin: run supabase/add_admin_devices.sql.)"
    : null;
}

// Fire-and-forget notification fan-out through the send-push Edge Function
// (which authenticates this call and works out the audience — see its header).
// Deliberately never awaited and never allowed to throw into the caller: a
// notification that fails to send must not make a sent message look unsent.
//
// ⚠ The trade-off: if the sender's app is killed in the moment between the
// INSERT and this call, nobody gets notified about that message. A Supabase
// Database Webhook on `messages` would be immune to that, at the cost of
// dashboard configuration. Move to one if dropped notifications show up.
// ⚠ The send-push RESPONSE is recorded to localStorage (`wa:push:lastfire`), not
// just console.warn'd. On a phone there is no console: a push that silently
// returns {sent:0,"no devices"} or 403 looked identical to one that worked, and
// that is exactly what made "chat notifications don't arrive" so hard to place.
// Settings → Notification diagnostics reads this back.
function _lastFire(patch) {
  try {
    localStorage.setItem("wa:push:lastfire",
      JSON.stringify(Object.assign({ at: new Date().toISOString() }, patch)));
  } catch (_) {}
}

function _firePush(payload) {
  try {
    _lastFire({ kind: payload && payload.kind, state: "sending" });
    _sb.functions.invoke("send-push", { body: payload })
      .then((r) => {
        if (r && r.error) {
          console.warn("send-push:", r.error.message || r.error);
          // supabase-js hides the HTTP body on non-2xx; dig it out so the reason
          // ("no devices" / "not your message") survives, not just "non-2xx".
          const ctx = r.error.context;
          if (ctx && typeof ctx.text === "function") {
            ctx.text().then((t) => _lastFire({ kind: payload.kind, state: "error",
                                               status: ctx.status, body: String(t).slice(0, 300) }))
                      .catch(() => _lastFire({ kind: payload.kind, state: "error",
                                               error: r.error.message || String(r.error) }));
          } else {
            _lastFire({ kind: payload.kind, state: "error", error: r.error.message || String(r.error) });
          }
        } else {
          _lastFire({ kind: payload.kind, state: "ok", reply: r && r.data });
        }
      })
      .catch((e) => {
        console.warn("send-push failed:", e);
        _lastFire({ kind: payload && payload.kind, state: "threw", error: (e && e.message) || String(e) });
      });
  } catch (e) {
    console.warn("send-push failed:", e);
    _lastFire({ kind: payload && payload.kind, state: "threw", error: (e && e.message) || String(e) });
  }
}

// The AWAITED sibling of _firePush. Everything else in this app treats a
// notification as fire-and-forget, on the principle that a push which fails to
// send must not make a sent message look unsent. Important Updates is the one
// place where the caller genuinely needs the answer:
//
//   • the delivery result ({devices, sent}) is written back onto the row, which
//     is the only way to answer "did it actually go out?" afterwards;
//   • the Resend button exists precisely for the case where this call FAILED
//     while the row published — so the failure has to be visible, not swallowed.
//
// Still records wa:push:lastfire, so Settings → Notification diagnostics reads
// this the same as every other push. Throws with the server's own reason text
// rather than supabase-js's "non-2xx", which hides the body.
async function _awaitPush(payload) {
  _lastFire({ kind: payload && payload.kind, state: "sending" });
  let r;
  try {
    r = await _sb.functions.invoke("send-push", { body: payload });
  } catch (e) {
    _lastFire({ kind: payload.kind, state: "threw", error: (e && e.message) || String(e) });
    throw e;
  }
  if (r && r.error) {
    let detail = r.error.message || String(r.error);
    const ctx = r.error.context;
    if (ctx && typeof ctx.text === "function") {
      try {
        const t = await ctx.text();
        const j = JSON.parse(t);
        if (j && j.error) detail = j.error;
        _lastFire({ kind: payload.kind, state: "error", status: ctx.status, body: String(t).slice(0, 300) });
      } catch (_) {
        _lastFire({ kind: payload.kind, state: "error", error: detail });
      }
    } else {
      _lastFire({ kind: payload.kind, state: "error", error: detail });
    }
    throw new Error(detail);
  }
  _lastFire({ kind: payload.kind, state: "ok", reply: r && r.data });
  return (r && r.data) || {};
}

const WA = {
  // ----- Auth -----------------------------------------------------------
  async login(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({ email: (email || "").trim(), password });
    if (error) throw new Error(_authMsg(error));
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  // With "Confirm email" ON (mandatory since the hard gate — AUTH_GATE_PLAN.md),
  // sign-up yields NO session: Supabase mails a 6-digit code that verifyOtp()
  // exchanges for one. So the normal return here is {needsVerification: true},
  // not a signed-in user — the caller must show the code screen.
  async register(username, email, password) {
    username = (username || "").trim();
    email = (email || "").trim();
    if (!USERNAME_RE.test(username)) throw new Error("Username must be 3–20 letters, numbers, or underscores.");
    if (!EMAIL_RE.test(email)) throw new Error("Please enter a valid email address.");
    if ((password || "").length < 6) throw new Error("Password must be at least 6 characters.");
    const { data, error } = await _sb.auth.signUp({ email, password, options: { data: { username } } });
    if (error) throw new Error(_authMsg(error));

    // ⚠ Supabase's email-enumeration protection means signing up with an
    // ALREADY-CONFIRMED address returns success with an obfuscated user and NO
    // error — and sends no mail. The only tell is an empty `identities` array.
    // Without this check the user would sit on the code screen forever waiting
    // for a mail that was never sent.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error("An account with that email already exists. Please sign in instead.");
    }
    // An existing but UNCONFIRMED address takes the normal path below: Supabase
    // re-sends the code, which is exactly what that person needs.
    if (!data.session) return { needsVerification: true, email };
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  // Exchange the 6-digit code from the sign-up email for a real session.
  async verifyEmailCode(email, code) {
    email = (email || "").trim();
    code = (code || "").replace(/\D/g, "");
    if (code.length !== 6) throw new Error("Enter the 6-digit code from your email.");
    const { data, error } = await _sb.auth.verifyOtp({ email, token: code, type: "signup" });
    if (error) throw new Error(_authMsg(error));
    if (!data.session) throw new Error("Could not verify that code. Please request a new one.");
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  // Re-send the sign-up code (codes expire; the button must always be reachable).
  async resendEmailCode(email) {
    const { error } = await _sb.auth.resend({ type: "signup", email: (email || "").trim() });
    if (error) throw new Error(_authMsg(error));
    return { ok: true };
  },

  // ----- Password reset (same 6-digit-code mechanism, type 'recovery') ----
  async requestPasswordReset(email) {
    email = (email || "").trim();
    if (!EMAIL_RE.test(email)) throw new Error("Please enter a valid email address.");
    const { error } = await _sb.auth.resetPasswordForEmail(email);
    if (error) throw new Error(_authMsg(error));
    return { ok: true };
  },
  // Verifying a recovery code signs the user in; then set the new password.
  async resetPassword(email, code, newPassword) {
    code = (code || "").replace(/\D/g, "");
    if (code.length !== 6) throw new Error("Enter the 6-digit code from your email.");
    if ((newPassword || "").length < 6) throw new Error("Password must be at least 6 characters.");
    const { data, error } = await _sb.auth.verifyOtp({
      email: (email || "").trim(), token: code, type: "recovery",
    });
    if (error) throw new Error(_authMsg(error));
    if (!data.session) throw new Error("Could not verify that code. Please request a new one.");
    const { error: upErr } = await _sb.auth.updateUser({ password: newPassword });
    if (upErr) throw new Error(_authMsg(upErr));
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  // Dropping the device proof here (not only in signOutToGate) means every
  // sign-out path clears it, including ones added later — the next person on
  // this machine starts from nothing even though the KEY is still installed.
  async logout() {
    _deviceHeader = null;
    _dropProfileCache();
    try { await _sb.auth.signOut(); } catch (_) {}
  },

  // Sync, no network: is a session stored on this device? The startup gate's
  // offline-grace check — see _hasStoredSession().
  hasStoredSession() { return _hasStoredSession(); },

  // Current session + fresh profile (used on boot to refresh role/state).
  async me() {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw new Error("Not signed in.");
    return { token: session.access_token, user: await _loadProfile(session.user.id, { fresh: true }) };
  },

  async authConfig() {
    const { data } = await _sb.from("app_settings").select("value").eq("key", "signup_enabled").maybeSingle();
    return { signup_enabled: !data || data.value === "1" };
  },

  // Today's preloader "guru reveal" photo — picked once daily, server-side,
  // by the reveal-pick Edge Function (supabase/add_daily_reveal.sql), so every
  // device shows the same one. Called pre-auth, before sign-in even resolves —
  // this is a splash image, not community content. Returns the public Storage
  // URL, or null if the table's empty/missing (fresh project, migration not
  // run yet) so the caller can silently keep the bundled fallback photo.
  async dailyRevealPhoto() {
    const { data, error } = await _sb.from("daily_reveal")
      .select("filename").order("reveal_date", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return `${WA_SUPABASE_URL}/storage/v1/object/public/reveal-photos/${encodeURIComponent(data.filename)}`;
  },

  // ----- Conclusions ----------------------------------------------------
  getConclusion(wid) { return _rpc("get_conclusion", { wid: String(wid) }); },
  saveConclusion(wid, text, visibility) {
    return _rpc("save_conclusion", { wid: String(wid), body_text: text, vis: visibility || "public" });
  },

  // ----- Chat -----------------------------------------------------------
  // Returns {messages, can_moderate, can_delete, me, is_muted} or throws an Error
  // tagged with .code = "AUTH" (not signed in) / "FORBIDDEN" (not a member).
  //
  // ⚠ can_moderate and can_delete are NOT the same thing (2026-08-06). Removing a
  // message is SUTRADHAR-ONLY — moderators keep every other power but lost this
  // one. Postgres enforces it (`messages_delete` uses wa_is_sutradhar(), see
  // supabase/add_satsang_chat.sql); this flag only decides whether the UI offers
  // an action that would be rejected anyway. Anything reading can_moderate to
  // decide "may delete" is now wrong.
  //
  // ⚠ WINDOWED. This returns the NEWEST `limit` messages, not the thread. A
  // satsang that has been running for months is thousands of rows, and pulling
  // every one of them was both the longest wait on opening a busy discussion
  // and thousands of bubbles to build before the first could be read — on a
  // phone, seconds of it. `has_more` says whether anything older exists;
  // getChatBefore() walks back from there as the reader scrolls up.
  //
  // Still returned OLDEST FIRST, which is the order the renderer wants.
  async getChat(wid, limit) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in."), { code: "AUTH" });
    const user = await _loadProfile(session.user.id);
    const isMod = user.role === "moderator" || user.role === "sutradhar";
    if (!(isMod || user.role === "member")) {
      throw Object.assign(new Error("Members only."), { code: "FORBIDDEN" });
    }
    const take = limit || CHAT_PAGE_SIZE;
    const { data, error } = await _sb.from("messages").select("*")
      .eq("wisdom_id", String(wid)).order("created_at", { ascending: false }).limit(take);
    if (error) throw new Error(error.message);
    const rows = (data || []).slice().reverse();
    const res = { messages: rows.map(_mapMsg), has_more: (data || []).length >= take,
                  can_moderate: isMod, me: user.username,
                  can_delete: user.role === "sutradhar" };
    if (!isMod) res.is_muted = !!user.chat_muted;
    return res;
  },

  // One page older than `beforeIso`, oldest first. Rides the same
  // (wisdom_id, created_at) index the window above does.
  //
  // ⚠ `lte`, not `lt`: two messages sharing a timestamp to the microsecond
  // would otherwise fall down the gap between two pages and be lost from the
  // conversation forever. The boundary row therefore comes back every time and
  // the caller drops the ids it already holds — a duplicate is free, a missing
  // message is not.
  //
  // No session read: this is only ever called from inside a chat that already
  // loaded, and RLS is what actually decides who may read it.
  async getChatBefore(wid, beforeIso, limit) {
    const take = limit || CHAT_PAGE_SIZE;
    const { data, error } = await _sb.from("messages").select("*")
      .eq("wisdom_id", String(wid)).lte("created_at", beforeIso)
      .order("created_at", { ascending: false }).limit(take);
    if (error) throw new Error(error.message);
    return { messages: (data || []).slice().reverse().map(_mapMsg),
             has_more: (data || []).length >= take };
  },

  // Returns {message}; throws Error.code MUTED. Members post without limit —
  // message credits were removed (membership is capped by invitation instead),
  // so muting is the only thing that can block a post.
  //
  // `reply` is {id, user, text} of the message being answered. It is stored
  // DENORMALISED (reply_user / reply_snippet) so the quote needs no join and
  // still reads after the sutradhar removes the parent.
  async postMessage(wid, text, reply, attachments) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in."), { code: "AUTH" });
    const me = await _loadProfile(session.user.id);
    const isMod = me.role === "moderator" || me.role === "sutradhar";
    if (!isMod && me.chat_muted) throw Object.assign(new Error("You have been muted."), { code: "MUTED" });
    // `reply.id` is only set for a reply within THIS thread. A forward carries
    // the same user/snippet as provenance but no reply_to: the original lives in
    // another discussion, so a quote pointing at it could never be jumped to.
    const row = { wisdom_id: String(wid), text: text };
    if (reply && (reply.id || reply.user)) {
      if (reply.id) row.reply_to = reply.id;
      row.reply_user = reply.user || null;
      row.reply_snippet = String(reply.text || "").slice(0, 160);
    }
    if (attachments && attachments.length) row.attachments = attachments;
    let { data, error } = await _sb.from("messages").insert(row).select("*").single();
    // Replying/attaching against a database where add_satsang_chat.sql hasn't
    // been run: send the words rather than losing what the member typed. An
    // attachment can't survive that fallback, so it is reported, not dropped
    // silently — the uploaded object is left for the sweep.
    if (error && row.attachments && /attachments|column|schema cache/i.test(error.message || "")) {
      throw new Error("Sharing isn't set up yet. (Admin: run supabase/add_satsang_chat.sql.)");
    }
    if (error && row.reply_to && /reply_to|reply_user|reply_snippet|column|schema cache/i.test(error.message || "")) {
      ({ data, error } = await _sb.from("messages")
        .insert({ wisdom_id: String(wid), text: text }).select("*").single());
    }
    if (error) throw new Error(error.message);
    // Notify the other members (send-push kind "chat" verifies we're the author).
    // ⚠ Admin Talks takes a DIFFERENT kind. "chat" addresses every approved
    // member, so reusing it here would put a private admin line in the
    // notification shade of the whole community — the one place RLS cannot
    // protect it, because the push is composed server-side after the read.
    _firePush({ kind: wid === _ADMIN_TALKS_WID ? "admintalks" : "chat", id: data.id });
    return { message: _mapMsg(data) };
  },

  // SOFT delete: stamp deleted_at and let the row stay. A hard DELETE can only
  // tell open clients "this row vanished", which loses the moderation record and
  // leaves replies quoting nothing; the tombstone repaints in place instead.
  // Postgres blanks the text and files the original in message_audit (the
  // before-update trigger), so this sends nothing but the timestamp.
  //
  // ⚠ SUTRADHAR-ONLY — RLS rejects everyone else. Falls back to the old hard
  // delete when the column isn't there yet (migration not yet run), so the
  // control keeps working during the changeover.
  async deleteMessage(wid, mid) {
    const { error } = await _sb.from("messages")
      .update({ deleted_at: new Date().toISOString() }).eq("id", mid);
    if (!error) return { ok: true };
    if (/deleted_at|column|schema cache/i.test(error.message || "")) {
      const { error: e2 } = await _sb.from("messages").delete().eq("id", mid);
      if (e2) throw new Error(e2.message);
      return { ok: true, hard: true };
    }
    throw new Error(error.message);
  },

  // ----- Attachments (phase D) -------------------------------------------
  // Images and PDFs only. VIDEO AND AUDIO ARE NEVER ALLOWED — the bucket's
  // allowed_mime_types rejects them server-side, the messages trigger rejects
  // them again, and this list is the third gate. Don't widen it.
  MEDIA_MIMES: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"],

  // Upload one file and return the attachment record to store on the message.
  //
  // ⚠ Upload FIRST, insert the message second (the caller does this): a row
  // pointing at a missing object is unrecoverable, an orphaned object is just
  // garbage a sweep can collect.
  //
  // The path is <wid>/<random>.<ext>, with the wid SANITISED — thread ids like
  // "special:2564" carry a colon, which is not safe in a storage key.
  async uploadChatMedia(wid, blob, name, extra) {
    const mime = blob.type || "application/octet-stream";
    if (!WA.MEDIA_MIMES.includes(mime)) {
      throw new Error("Only images and PDF files can be shared here.");
    }
    const safeWid = String(wid).replace(/[^A-Za-z0-9_-]/g, "_");
    const ext = (mime === "application/pdf") ? "pdf" : (mime.split("/")[1] || "bin");
    const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    const path = `${safeWid}/${rand}.${ext}`;
    const { error } = await _sb.storage.from("satsang-media")
      .upload(path, blob, { contentType: mime, upsert: false });
    if (error) {
      if (/Bucket not found|not found/i.test(error.message || "")) {
        throw new Error("Sharing isn't set up yet. (Admin: run section 10 of supabase/add_satsang_chat.sql.)");
      }
      throw new Error(error.message);
    }
    return Object.assign({ path, mime, bytes: blob.size, name: name || "" }, extra || {});
  },

  // The bucket is PRIVATE, so rendering needs short-lived signed URLs. Batched —
  // one round trip per screenful, not one per image. Returns {path: url}.
  async signedMediaUrls(paths, seconds) {
    if (!paths || !paths.length) return {};
    const { data, error } = await _sb.storage.from("satsang-media")
      .createSignedUrls(paths, seconds || 3600);
    if (error) throw new Error(error.message);
    const out = {};
    (data || []).forEach((d) => { if (d && d.path && d.signedUrl) out[d.path] = d.signedUrl; });
    return out;
  },

  // ----- Reactions (phase C) --------------------------------------------
  // Every reaction in one thread, in a single round trip. Reactions live in
  // their OWN table (not a counter on the message) so two people tapping the
  // same emoji can't clobber each other, and so a member never needs write
  // access to a message row — which is what keeps deletion sutradhar-only.
  //
  // Returns {reactions:[{mid, user, emoji}]}; an empty list where the migration
  // hasn't been run, so the chat renders normally instead of failing.
  async listReactions(wid) {
    const { data, error } = await _sb.from("message_reactions")
      .select("message_id,username,emoji").eq("wisdom_id", String(wid));
    if (error) {
      if (/message_reactions|does not exist|not find|schema cache/i.test(error.message || "")) {
        return { reactions: [], missing: true };
      }
      throw new Error(error.message);
    }
    return { reactions: (data || []).map((r) => ({ mid: r.message_id, user: r.username, emoji: r.emoji })) };
  },

  // wisdom_id / user_id / username are stamped server-side by the table's
  // before-insert trigger — the client sends only what it is allowed to choose.
  // A duplicate (same person, same emoji, same message) is the primary key
  // doing its job, not an error worth surfacing.
  async addReaction(mid, emoji) {
    const { error } = await _sb.from("message_reactions")
      .insert({ message_id: mid, emoji: emoji });
    if (error && !/duplicate key|23505/i.test(error.message || "")) throw new Error(error.message);
    return { ok: true };
  },

  async removeReaction(mid, emoji) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in."), { code: "AUTH" });
    const { error } = await _sb.from("message_reactions").delete()
      .eq("message_id", mid).eq("emoji", emoji).eq("user_id", session.user.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // (clearChat was REMOVED 2026-08-06. It deleted every message in a thread, had
  // no caller anywhere in the app, and was reachable from any member's console.
  // Removing a whole discussion is a sutradhar act — if it's ever wanted, it
  // belongs behind an RPC with a role check, not a raw table delete.)

  // Live chat via Supabase Realtime (replaces the SSE stream). Returns a handle
  // with .close(). onMessage / onUpdate / onDelete fire on inserts / updates /
  // deletes.
  //
  // ⚠ UPDATE is what carries a soft delete (and, from phase C, anything else that
  // edits a row in place). Without it a tombstone only appears on reload.
  // Reactions ride the SAME channel, so `closeChatStream()` still tears
  // everything down in one call and a thread costs one connection, not two.
  // ⚠ That is only possible because message_reactions carries its own
  // `wisdom_id`: a postgres_changes filter is a single-column equality, so
  // without it every device would receive every reaction in the archive.
  // ----- Pinned message (phase F) -----------------------------------------
  // ⚠ Lives in its OWN table, not a column on messages. Pinning would otherwise
  // be an UPDATE to a message row, and `messages_update` is sutradhar-only on
  // purpose — a moderator with UPDATE could blank any message's text and delete
  // it by another name. See supabase/add_satsang_pin.sql.
  //
  // Returns {mid, by, at} or null. Silent when the table doesn't exist, so the
  // chat opens normally before the migration is run.
  async getPin(wid) {
    const { data, error } = await _sb.from("thread_pins")
      .select("message_id,pinned_by,pinned_at").eq("wisdom_id", String(wid)).maybeSingle();
    if (error || !data) return null;
    return { mid: data.message_id, by: data.pinned_by, at: data.pinned_at };
  },

  // One pin per thread — enforced by the primary key, so this is an upsert and
  // no caller has to remember to clear the previous one.
  async setPin(wid, mid) {
    const { error } = await _sb.from("thread_pins")
      .upsert({ wisdom_id: String(wid), message_id: mid }, { onConflict: "wisdom_id" });
    if (error) {
      if (/thread_pins|does not exist|not find|schema cache/i.test(error.message || "")) {
        throw new Error("Pinning isn't set up yet. (Admin: run supabase/add_satsang_pin.sql.)");
      }
      throw new Error(error.message);
    }
    return { ok: true };
  },

  async clearPin(wid) {
    const { error } = await _sb.from("thread_pins").delete().eq("wisdom_id", String(wid));
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // ----- Read state: "Seen by N" (phase F) --------------------------------
  // ONE row per member per thread, never one per message — per-message receipts
  // would be members x messages rows for a line of small print.
  //
  // Silent by design: a missing table (migration not run) isn't worth an error
  // in someone's face for a cosmetic feature.
  async markThreadRead(wid) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return { ok: false };
    const { error } = await _sb.from("thread_reads")
      .upsert({ user_id: session.user.id, wisdom_id: String(wid), last_read_at: new Date().toISOString() },
              { onConflict: "user_id,wisdom_id" });
    return { ok: !error };
  },

  // How many OTHER members have read as far as `sinceIso` (the timestamp of your
  // own latest message). Returns -1 when it can't tell, so the caller shows
  // nothing rather than a wrong "Seen by 0".
  async threadReadCount(wid, sinceIso) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session || !sinceIso) return -1;
    const { data, error } = await _sb.from("thread_reads")
      .select("user_id").eq("wisdom_id", String(wid)).gte("last_read_at", sinceIso);
    if (error) return -1;
    return (data || []).filter((r) => r.user_id !== session.user.id).length;
  },

  // `me` is the username presence announces and the typing broadcast carries.
  //
  // ⚠ Typing and presence ride the chat's EXISTING channel — no second socket.
  // Concurrent Realtime connections are the scarcest free-tier resource, so a
  // thread must never cost more than the one connection it already opens.
  // `broadcast: {self: false}` keeps your own typing off your own screen.
  // `poll` turns on the admin polling fallback — see _startChatPoll(). Callers
  // pass isModerator(); everyone else rides Realtime alone as before.
  subscribeChat(wid, { me, poll, onMessage, onUpdate, onDelete, onReact, onUnreact, onTyping, onPresence, onPin }) {
    const filter = "wisdom_id=eq." + String(wid);
    const ch = _sb.channel("wa-chat-" + wid, { config: { broadcast: { self: false } } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter },
          (p) => { if (onMessage) onMessage(_mapMsg(p.new)); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter },
          (p) => { if (onUpdate && p.new) onUpdate(_mapMsg(p.new)); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages", filter },
          (p) => { if (onDelete && p.old) onDelete(p.old.id); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions", filter },
          (p) => { if (onReact && p.new) onReact({ mid: p.new.message_id, user: p.new.username, emoji: p.new.emoji }); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions", filter },
          (p) => { if (onUnreact && p.old) onUnreact({ mid: p.old.message_id, user: p.old.username, emoji: p.old.emoji }); })
      // Pin changes are INSERT (first pin), UPDATE (moved to another message) or
      // DELETE (unpinned) — all three mean "repaint the banner", so one handler
      // takes the lot. `wisdom_id` is this table's primary key, so the same
      // single-column Realtime filter works.
      .on("postgres_changes", { event: "*", schema: "public", table: "thread_pins", filter },
          (p) => { if (onPin) onPin(p.new && p.new.message_id ? p.new.message_id : null); })
      .on("broadcast", { event: "typing" },
          (p) => { if (onTyping && p.payload && p.payload.user) onTyping(p.payload.user); })
      .on("presence", { event: "sync" }, () => {
        if (!onPresence) return;
        const state = ch.presenceState();
        const users = [];
        Object.keys(state).forEach((k) => (state[k] || []).forEach((v) => {
          if (v && v.user && users.indexOf(v.user) < 0) users.push(v.user);
        }));
        onPresence(users);
      })
      .subscribe((status) => {
        // track() must wait for SUBSCRIBED — calling it earlier is a no-op and
        // the member silently never appears as present.
        if (status === "SUBSCRIBED" && me) { try { ch.track({ user: me }); } catch (_) {} }
      });
    const stopPoll = poll
      ? _startChatPoll(wid, { onMessage, onUpdate, onReact, onUnreact, onPin })
      : null;

    return {
      close() {
        if (stopPoll) stopPoll();
        try { _sb.removeChannel(ch); } catch (_) {}
      },
      // Fire-and-forget: a dropped typing ping is not worth a retry or an error.
      sendTyping(user) {
        try { ch.send({ type: "broadcast", event: "typing", payload: { user: user } }); } catch (_) {}
      },
    };
  },

  // Recent messages across all wisdoms (members+ only; guests get an empty list
  // because RLS hides messages from non-members). Shape: {messages:[{user,wid,text,ts}]}.
  //
  // ⚠ Selects `*` rather than a column list so it can drop soft-deleted rows
  // (`!r.deleted_at`) on BOTH sides of the migration: naming deleted_at would
  // error where the column doesn't exist yet, and omitting it would let
  // tombstones through once it does.
  async communityRecent(limit) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 20, 50));
    const { data, error } = await _sb.from("messages")
      .select("*")
      .order("created_at", { ascending: false }).limit(n);
    if (error || !data) return { messages: [] };
    // ⚠ 'admin:' threads are filtered here as well as in RLS. RLS already hides
    // them from members, but a MODERATOR passes that check — and "recent
    // community activity" is a public-facing summary, not a place for the
    // private room's last line to surface.
    return { messages: data.filter((r) => !r.deleted_at && !_isAdminWid(r.wisdom_id))
      .map((r) => ({ user: r.username, wid: r.wisdom_id, text: r.text, ts: r.created_at })) };
  },

  // Every discussion that actually HAS messages, newest activity first — the
  // data behind the grouped Samuhik Satsang index. Shape:
  // {threads:[{wid, count, last_at, last_user, last_text}]}.
  //
  // Prefers the list_satsang_threads RPC (one small round trip). Falls back to
  // grouping raw messages in the browser when that section of schema.sql hasn't
  // been run, so the feature works the moment the UI ships — just at the cost of
  // pulling recent rows over mobile data. RLS keeps both paths members-only.
  async listSatsangThreads() {
    try {
      const d = await _rpc("list_satsang_threads");
      return { threads: (d && d.threads) || [] };
    } catch (e) {
      if (!/list_satsang_threads|schema cache|does not exist|not find/i.test(e.message || "")) throw e;
    }
    // `*` + a JS filter, not a deleted_at column list — see communityRecent.
    const { data, error } = await _sb.from("messages")
      .select("*")
      .order("created_at", { ascending: false }).limit(4000);
    if (error) throw new Error(error.message);
    // Rows arrive newest-first, so the FIRST row seen for a thread is its latest.
    const byWid = new Map();
    for (const r of data || []) {
      if (r.deleted_at) continue;      // a removed message is not a thread's last line
      if (_isAdminWid(r.wisdom_id)) continue;   // Admin Talks is not a satsang
      const t = byWid.get(r.wisdom_id);
      if (t) { t.count++; continue; }
      byWid.set(r.wisdom_id, {
        wid: r.wisdom_id, count: 1, last_at: r.created_at,
        last_user: r.username, last_text: (r.text || "").slice(0, 160),
      });
    }
    return { threads: [...byWid.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1)) };
  },

  // ----- Anubhuti Sharing (2026-08-07) ------------------------------------
  // An open sharing space with no Guru's message behind it. Topics live in
  // `anubhuti_topics`; each one's conversation is an ordinary `messages` thread
  // under wisdom_id = "anubhuti:<id>", so every chat method above already works
  // on it unchanged. See supabase/add_anubhuti.sql.
  //
  // Shape: {topics:[{id, wid, title, body, author, created_at,
  //                  count, last_at, last_user, last_text}]}
  //
  // ⚠ A sharing with ZERO replies is still a topic — the RPC starts from the
  // topics table, not from messages, precisely so it appears the moment it is
  // written. Don't "optimise" this into listSatsangThreads.
  // Tagged .code = "SETUP" when the SQL hasn't been run, so the UI can show the
  // admin notice without string-matching the message text.
  async listAnubhutiTopics() {
    try {
      const d = await _rpc("list_anubhuti_topics");
      return { topics: (d && d.topics) || [] };
    } catch (e) {
      const setup = _anubhutiMissing(e);
      if (setup) throw Object.assign(new Error(setup), { code: "SETUP" });
      throw e;
    }
  },

  // ⚠ One sharing, with its FULL body. listAnubhutiTopics() returns `preview`
  // (240 chars) so the index stays small over mobile data — the detail page has
  // to come here, or every long sharing renders silently truncated.
  //
  // Returns {topic} with topic === null when the row is gone (RLS-filtered or
  // removed). A network failure THROWS instead, so the caller can tell "deleted"
  // from "offline" and fall back to its cached row only in the second case.
  async getAnubhutiTopic(id) {
    const { data, error } = await _sb.from("anubhuti_topics")
      .select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(_anubhutiMissing(error) || error.message);
    return { topic: data || null };
  },

  // Any approved member may start one; RLS enforces that (and blocks a muted
  // member). Author identity comes from the before-insert trigger, never from
  // here, so it cannot be spoofed.
  async createAnubhutiTopic(title, body) {
    const t = (title || "").trim();
    const b = (body || "").trim();
    if (!t) throw new Error("Please give your sharing a title.");
    if (t.length > 140) throw new Error("Title is too long (max 140 characters).");
    if (b.length > 4000) throw new Error("Sharing is too long (max 4000 characters).");
    const { data, error } = await _sb.from("anubhuti_topics")
      .insert({ title: t, body: b || null }).select("*").single();
    if (error) throw new Error(_anubhutiMissing(error) || error.message);
    // Announce it (send-push kind "anubhuti" verifies we're the author). Replies
    // inside the sharing notify via the "chat" kind from postMessage(); this is
    // the sharing itself, which has no message and would otherwise be silent.
    _firePush({ kind: "anubhuti", id: data.id });
    return { topic: data };
  },

  // Moderators + sutradhar (RLS: wa_is_mod). The after-delete trigger removes
  // the thread's messages too — see the note in add_anubhuti.sql.
  async deleteAnubhutiTopic(id) {
    const { error } = await _sb.from("anubhuti_topics").delete().eq("id", id);
    if (error) throw new Error(_anubhutiMissing(error) || error.message);
    return { ok: true };
  },

  // ----- Admin Talks -----------------------------------------------------
  // The private room shared by the sutradhar and the moderators. Its
  // conversation is an ordinary `messages` thread, so postMessage /
  // subscribeChat / reactions / pinning all take ADMIN_TALKS_WID and need
  // nothing of their own here.
  ADMIN_TALKS_WID: _ADMIN_TALKS_WID,

  // Who is in the room, sutradhar first: [{id, username, role, joined_at}],
  // plus `me` — the caller's own roster row, or null if they are not in it.
  //
  // ⚠ `me` is the answer the UI should trust, not the cached role in
  // localStorage. A moderator whose roster row is missing (demoted in another
  // session, or a project where the migration hasn't run) must see the door
  // closed rather than a chat that errors on send.
  async adminTalkMembers() {
    try {
      const d = await _rpc("list_admin_talk_members");
      return { me: (d && d.me) || null, members: (d && d.members) || [] };
    } catch (e) {
      const m = _adminTalksMissing(e);
      if (m) throw Object.assign(new Error(m), { code: "NO_TABLE" });
      throw e;
    }
  },

  // How many messages in the room are newer than `sinceIso` and not our own —
  // the drawer badge, and nothing else. A HEAD request with an exact count, so
  // the rows themselves never cross the wire for a number.
  //
  // Returns 0 rather than throwing on any failure: an offline launch must leave
  // the cached badge alone, not clear it or break the boot path.
  // System announcements are counted — being added to the room IS news.
  async adminTalkUnread(sinceIso, me) {
    try {
      let q = _sb.from("messages").select("id", { count: "exact", head: true })
        .eq("wisdom_id", _ADMIN_TALKS_WID).is("deleted_at", null);
      if (sinceIso) q = q.gt("created_at", sinceIso);
      if (me) q = q.neq("username", me);
      const { count, error } = await q;
      return error ? 0 : (count || 0);
    } catch (_) { return 0; }
  },

  // ----- Push notifications (Phase 4) ------------------------------------
  // Register this device's FCM token so the send-push Edge Function can reach
  // it when a new Special Message publishes. Anonymous devices are allowed
  // (the archive works signed-out) — device_tokens permits anon INSERT, and
  // nothing is readable back (RLS). Idempotent on the unique token via upsert.
  // Preferred path is the register_device_token RPC (SECURITY DEFINER), which
  // UPSERTS and re-stamps the owner. That matters now that Samuhik Satsang
  // pushes are addressed to people: push registration runs at launch, BEFORE the
  // startup gate is passed, so a fresh install's token would otherwise keep
  // user_id NULL forever and never receive a chat notification.
  //
  // Falls back to the original plain INSERT when the RPC isn't there yet (the
  // notifications section of schema.sql not run): anon devices have the INSERT
  // grant but NOT the privileges PostgREST's upsert path requires, and the
  // unique `token` column makes a repeat registration a harmless 23505.
  // Rotated/stale tokens are pruned server-side by send-push on FCM 404.
  // `lang` ("hi"/"en") and `wantThought` are the Upanishad Gyan preferences, and
  // both are OPTIONAL — null leaves whatever the device already chose alone.
  // Launch-time registration passes the language (so a device that has never
  // opened Settings still gets its own language) but NOT the on/off flag, which
  // only the Settings card is allowed to change; passing a default there would
  // silently re-enable notifications someone had switched off.
  //
  // `shell` is the APK version this phone is running (wa-boot's shellVersion) and
  // is NOT a preference — it is a fact about the running app, so it is sent on
  // every launch and always overwrites. send-push needs it to decide the SHAPE of
  // the Upanishad Gyan push (see THOUGHT_TIMEOUT_MIN_SHELL): a shell that can
  // dismiss a notification by itself is sent a data-only message, an older one the
  // ordinary kind it can actually display. A device that never reports a shell is
  // treated as old, which is the safe direction.
  //
  // ⚠ Three call shapes, oldest last: the full RPC, the 2-argument RPC
  // (this OTA reached the phone before add_guru_thoughts.sql was run on the
  // server), then a plain insert (no RPC at all). Registration must never fail
  // just because the newest server section is missing — a device that does not
  // register receives nothing at all, forever. The window/shell arguments ride on
  // the first shape only: a server without add_gyan_window.sql rejects them, and
  // the retry below is what keeps such a phone registered anyway.
  async registerDeviceToken(token, platform, lang, wantThought, winFrom, winTo, shell) {
    if (!token) return { ok: false };
    const plat = platform || "android";
    // Remembered so app.js can re-register after sign-in without waiting for
    // FCM to hand out the token again (it only fires once per install).
    try { localStorage.setItem("wa:push:token", token); } catch (_) {}
    const missing = (e) => /register_device_token|schema cache|does not exist|not find/i.test(e.message || "");

    const args = { tok: token, plat };
    if (lang === "hi" || lang === "en") args.lang = lang;
    if (wantThought === true || wantThought === false) args.want_thought = wantThought;
    if (Number.isFinite(winFrom) && Number.isFinite(winTo)) {
      args.win_from = Math.round(winFrom);
      args.win_to = Math.round(winTo);
    }
    if (shell) args.shell_ver = String(shell);
    if (args.lang || args.want_thought !== undefined
        || args.win_from !== undefined || args.shell_ver !== undefined) {
      const { error: newErr } = await _sb.rpc("register_device_token", args);
      if (!newErr) return { ok: true };
      // ⚠ A server without add_gyan_window.sql answers "function not found" for
      // the whole call, window and language alike. Retry WITHOUT the new
      // arguments before giving up, or this OTA would leave every such phone
      // unregistered — the exact failure the 2-argument fallback below exists to
      // prevent, one section further on.
      if (missing(newErr) && (args.win_from !== undefined || args.shell_ver !== undefined)) {
        const older = { tok: token, plat };
        if (args.lang) older.lang = args.lang;
        if (args.want_thought !== undefined) older.want_thought = args.want_thought;
        const { error: olderErr } = await _sb.rpc("register_device_token", older);
        if (!olderErr) return { ok: true, window: false };
        if (!missing(olderErr)) throw new Error(olderErr.message);
      } else if (!missing(newErr)) {
        throw new Error(newErr.message);
      }
    }

    const { error } = await _sb.rpc("register_device_token", { tok: token, plat });
    if (!error) return { ok: true, thoughtPrefs: false };
    if (!missing(error)) {
      throw new Error(error.message);
    }
    const { data: { session } } = await _sb.auth.getSession();
    const row = { token, platform: plat, user_id: session ? session.user.id : null };
    const { error: insErr } = await _sb.from("device_tokens").insert(row);
    if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
    return { ok: true, legacy: true };
  },

  // The FCM token this device last registered (see above), or "".
  storedPushToken() { try { return localStorage.getItem("wa:push:token") || ""; } catch (_) { return ""; } },

  // ----- Upanishad Gyan (the hourly thought) ----------------------------
  // Both preferences live on THIS DEVICE's token row, not on the account —
  // these notifications reach phones that never signed in, so an account-level
  // switch would leave most of the audience unable to turn them off or pick a
  // language. See the header of supabase/add_guru_thoughts.sql.
  // ⚠ Every argument is OPTIONAL and an omitted one means "leave the stored value
  // alone" — the Settings card changes one thing at a time and must not carry the
  // other two along on the way. The window is the pair (winFrom, winTo) and is
  // sent only when BOTH are numbers: set_thought_prefs rejects half a window
  // rather than guessing at the other end.
  async setThoughtPrefs(lang, wantThought, winFrom, winTo) {
    const tok = this.storedPushToken();
    if (!tok) throw new Error("This device isn't registered for notifications yet. Open the app once with notifications allowed, then try again.");
    const args = { tok };
    if (lang === "hi" || lang === "en") args.lang = lang;
    if (wantThought === true || wantThought === false) args.want_thought = wantThought;
    if (Number.isFinite(winFrom) && Number.isFinite(winTo)) {
      args.win_from = Math.round(winFrom);
      args.win_to = Math.round(winTo);
    }
    const { error } = await _sb.rpc("set_thought_prefs", args);
    if (error) {
      // Two different "not set up" cases, and the message has to name the right
      // file or the admin runs the wrong one: the whole feature missing (the old
      // 3-argument function absent) vs. the window missing (the 5-argument one).
      const missing = /set_thought_prefs|schema cache|does not exist|not find/i.test(error.message || "");
      throw new Error(missing
        ? (args.win_from !== undefined
            ? "Choosing your own hours isn't set up on the server yet. (Admin: run supabase/add_gyan_window.sql.)"
            : "Upanishad Gyan isn't set up on the server yet. (Admin: run supabase/add_guru_thoughts.sql.)")
        : error.message);
    }
    return { ok: true };
  },

  // The thoughts already sent, newest first — what the Upanishad Gyan screen
  // shows. Reads the SLOTS, not the pool: an unsent thought is not yet the
  // guru's word for any hour, and showing the whole pool would turn a quiet
  // hourly gift into a scrollable list of everything coming.
  //
  // ⚠ THROUGH AN RPC, not a table read (2026-08-20), and the reason is the one
  // field the table read cannot give safely: `name`, the member who suggested the
  // line. The operator's rule is that only a moderator or the sutradhar ever sees
  // it, and a client-side `if (isModerator())` is a decoration — anybody can read
  // the network. wa_recent_thoughts() asks Postgres who is calling and returns an
  // empty string to everyone else. See add_ganga_suggestions.sql section 9.
  //
  // ⚠ `limit` is a number of SLOTS to look back over, NOT the number shown. The
  // screen keeps the last GYAN_KEEP (three since 2026-08-22, five before) that
  // fall inside this device's chosen hours, so it asks for a couple of days'
  // worth and filters. Asking for three would show one thought to somebody whose
  // window is an hour wide.
  //
  // ⚠ created_at still comes back as `ts`. It is no longer an expiry clock (the
  // eighteen-minute rule was withdrawn 2026-08-20) but it is still what "2 hours
  // ago" is measured from, and it is the moment the push actually went out rather
  // than the top of the hour — cron can be ten minutes late.
  //
  // The rows are NOT deleted server-side and must never be. thought_slots'
  // primary key (slot_date, slot) is the only thing stopping the every-ten-minutes
  // cron from re-picking and re-sending an hour it has already served, so "only
  // the last three" is a rule about what is SHOWN.
  async recentThoughts(limit) {
    const n = Math.min(Math.max(limit || 24, 1), 100);
    const { data, error } = await _sb.rpc("wa_recent_thoughts", { n: n });
    if (error) {
      // ⚠ ORDERING INSURANCE. An app that updated before the SQL was run would
      // otherwise show "couldn't reach the server" on a screen whose thoughts are
      // sitting right there. Fall back to the old table read, which loses only
      // the admin credit line.
      if (/wa_recent_thoughts|schema cache|does not exist|not find/i.test(error.message || "")) {
        const r2 = await _sb.from("thought_slots")
          .select("slot_date,slot,created_at,thoughts(id,text_hi,text_en)")
          .order("slot_date", { ascending: false })
          .order("slot", { ascending: false })
          .limit(n);
        if (r2.error) throw new Error(r2.error.message);
        return (r2.data || []).map((r) => ({
          date: r.slot_date, slot: r.slot, ts: r.created_at || "",
          hi: (r.thoughts && r.thoughts.text_hi) || "",
          en: (r.thoughts && r.thoughts.text_en) || "",
          name: "",
        })).filter((t) => t.hi || t.en);
      }
      throw new Error(error.message);
    }
    return (data || []).map((r) => ({
      date: r.slot_date, slot: r.slot, ts: r.ts || "",
      hi: r.text_hi || "", en: r.text_en || "",
      name: r.suggested_name || "",
    })).filter((t) => t.hi || t.en);
  },

  // ---- Upanishad Ganga: the members' own suggestions (2026-08-20) --------
  // A member writes one short line, the admins approve or return it, and an
  // approved line jumps to the front of the hourly queue. Every rule that
  // matters — the daily cap, the character limit, who may decide — lives in
  // Postgres (supabase/add_ganga_suggestions.sql); these are the doors.
  //
  // ⚠ Every one of them can be called against a server where the SQL has not
  // been run yet, and "function not found" is a useless thing to show a member.
  // _gangaErr turns it into a sentence naming the file the operator must run.
  async gangaCharLimit() {
    const { data, error } = await _sb.rpc("ganga_char_limit");
    if (error) return 100;               // a missing RPC must not disable the box
    const n = parseInt(data, 10);
    return n >= 1 ? n : 100;
  },
  async setGangaCharLimit(n) {
    const { error } = await _sb.rpc("set_ganga_char_limit", { n: n });
    if (error) throw new Error(_gangaErr(error));
    return { ok: true, limit: n };
  },

  // The member's send. Returns the new row's id, which is what the caller hands
  // to notifyGangaPending.
  async submitGangaSuggestion(text) {
    const { data, error } = await _sb.rpc("submit_ganga_suggestion", { t: text });
    if (error) throw new Error(_gangaErr(error));
    return data || {};
  },
  // Every moderator and the sutradhar. Fire-and-forget, like every other ping in
  // this file: the row is already in the queue, and a lost notification only
  // means it is seen when they next open the review screen.
  notifyGangaPending(id) {
    _firePush({ kind: "ganga_pending", id: id });
  },

  // The member's own record: pending / accepted / returned-with-a-reason, and
  // once it has gone out, the hour it went.
  async myGangaSuggestions(limit) {
    const { data, error } = await _sb.rpc("my_ganga_suggestions",
      { n: Math.min(Math.max(limit || 20, 1), 100) });
    if (error) throw new Error(_gangaErr(error));
    return data || [];
  },

  // ---- the admins' side -------------------------------------------------
  async listGangaSuggestions(status, limit) {
    const { data, error } = await _sb.rpc("list_ganga_suggestions",
      { want_status: status || "pending", n: Math.min(Math.max(limit || 100, 1), 500) });
    if (error) throw new Error(_gangaErr(error));
    return data || [];
  },
  // `finalText` is the typo fix — null keeps the member's words exactly.
  async approveGangaSuggestion(id, finalText) {
    const { data, error } = await _sb.rpc("approve_ganga_suggestion",
      { sid: id, final_text: finalText || null });
    if (error) throw new Error(_gangaErr(error));
    return data || {};
  },
  async declineGangaSuggestion(id, reason) {
    const { data, error } = await _sb.rpc("decline_ganga_suggestion",
      { sid: id, reason: reason });
    if (error) throw new Error(_gangaErr(error));
    return data || {};
  },
  // Tell the member. Fire-and-forget for the same reason as every other decision
  // ping — the decision is already written, and the screen shows it either way.
  notifyGangaDecision(id, approved) {
    _firePush({ kind: approved ? "ganga_approved" : "ganga_declined", id: id });
  },

  // The admin's own line, straight into the pool. `origin` is 'member' (someone
  // suggested it outside the app — it jumps the queue) or 'admin' (joins the
  // rotation). See add_ganga_suggestions.sql section 7.
  async addGangaThought(text, origin) {
    const { data, error } = await _sb.rpc("add_ganga_thought",
      { t: text, origin: origin === "member" ? "member" : "admin" });
    if (error) throw new Error(_gangaErr(error));
    return data || {};
  },
  // Lines already in the pool that look like this one — an advisory warning
  // before approving, never a block.
  async gangaSimilarThoughts(text) {
    const { data, error } = await _sb.rpc("ganga_similar_thoughts", { t: text });
    if (error) return [];                // a warning that fails is simply no warning
    return data || [];
  },

  // Samuhik Satsang notifications on/off for THIS ACCOUNT (all their devices).
  // Throws with a plain-English message when the schema section is missing, so
  // the Settings switch can say so instead of silently doing nothing.
  async setNotifyPref(enabled) {
    const { error } = await _sb.rpc("set_notify_pref", { kind: "satsang", enabled: !!enabled });
    if (error) {
      throw new Error(/set_notify_pref|schema cache|does not exist|not find/i.test(error.message || "")
        ? "Notification settings aren't set up on the server yet. (Admin: run the notifications section of supabase/schema.sql.)"
        : error.message);
    }
    return { ok: true };
  },

  // ----- Msg to Admin — a private admin ↔ member conversation ------------
  // Table: admin_messages, threaded by `thread_user_id` (see
  // supabase/add_admin_msg_threads.sql and ADMIN_MSG_PLAN.md). Every rule that
  // matters lives in Postgres: who a row belongs to (the insert trigger), who
  // may read it (admin_messages_select), whether a thread is done
  // (admin_msg_threads, moderator-only), and whether the replying admin's NAME
  // is visible at all (admin_msg_thread).
  //
  // ⚠ Sending is a plain INSERT, not an RPC, deliberately: shells older than
  // this release insert {text} and nothing else, and the trigger files those
  // into the sender's own thread so they keep working untouched.
  async sendAdminMessage(text) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Please sign in first."), { code: "AUTH" });
    const body = (text || "").trim();
    if (!body) throw new Error("Please write a message.");
    if (body.length > 2000) throw new Error("Message is too long (max 2000 characters).");
    const { data, error } = await _sb.from("admin_messages")
      .insert({ text: body }).select("*").single();
    if (error) throw new Error(_tableMissing(error) || error.message);
    return { id: data.id, text: data.text, ts: data.created_at };
  },
  // An admin answering one member. `threadUserId` is the MEMBER — the trigger
  // reads it, checks wa_is_mod() for itself, and only then marks the row
  // from_admin. A member sending this exact call has it filed as their own
  // ordinary message instead, which is the intended failure.
  async replyAdminMessage(threadUserId, text) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Please sign in first."), { code: "AUTH" });
    if (!threadUserId) throw new Error("Which conversation?");
    const body = (text || "").trim();
    if (!body) throw new Error("Please write a reply.");
    if (body.length > 2000) throw new Error("Reply is too long (max 2000 characters).");
    const { data, error } = await _sb.from("admin_messages")
      .insert({ text: body, thread_user_id: threadUserId }).select("*").single();
    if (error) throw new Error(_adminMsgErr(error) || error.message);
    return { id: data.id, text: data.text, ts: data.created_at };
  },
  // One conversation, newest first — the only door to a thread's messages, for
  // both sides. `uid` null = my own. `author` is the moderator who wrote a
  // reply and is returned EMPTY to anybody but an admin (see §3 of the SQL).
  async adminMsgThread(uid, limit) {
    const { data, error } = await _sb.rpc("admin_msg_thread",
      { uid: uid || null, n: Math.min(Math.max(limit || 200, 1), 500) });
    if (error) throw new Error(_adminMsgErr(error) || error.message);
    const rows = (data || []).map((r) => ({
      id: r.id, text: r.body, fromAdmin: !!r.from_admin,
      author: r.author_name || "", ts: r.created_at,
      threadName: r.thread_name || "",
    }));
    // Carried on the array as well as on every row: an EMPTY thread still has a
    // name the page needs for its title, and a notification tap is exactly the
    // case where the caller has nothing but the uuid.
    rows.threadName = (rows[0] && rows[0].threadName) || "";
    return rows;
  },
  // Is this conversation marked done, and when? Moderator-only by RLS — a member
  // reading this table gets nothing at all, which is what makes Done invisible
  // to them rather than merely un-drawn. Never throws: a missing table (the SQL
  // not yet run) reads as "not done", and the page still works.
  async adminMsgDoneState(uid) {
    if (!uid) return { doneAt: null, doneName: "" };
    const { data, error } = await _sb.from("admin_msg_threads")
      .select("done_at,done_name").eq("user_id", uid).maybeSingle();
    if (error || !data) return { doneAt: null, doneName: "" };
    return { doneAt: data.done_at || null, doneName: data.done_name || "" };
  },
  // The admins' inbox: one row per member. `want` is "pending" | "replied" |
  // "all"; pending means "the newest message is the member's and nobody has
  // marked it done since", computed in Postgres so the client cannot disagree.
  async adminMsgThreads(want, limit) {
    const { data, error } = await _sb.rpc("admin_msg_threads_list",
      { want: want || "pending", n: Math.min(Math.max(limit || 200, 1), 500) });
    if (error) throw new Error(_adminMsgErr(error) || error.message);
    return (data || []).map((r) => ({
      userId: r.user_id, username: r.username || "A member",
      lastText: r.last_text || "", lastAt: r.last_at,
      // ⚠ Number(), not `|| 0`: msg_count is a Postgres bigint, and a driver
      // that hands bigints back as STRINGS would make the row say "1 msgs"
      // (`"1" === 1` is false). Cheaper to coerce than to depend on it.
      lastFromAdmin: !!r.last_from_admin, count: Number(r.msg_count) || 0,
      doneAt: r.done_at || null, doneName: r.done_name || "",
      status: r.status || "pending",
    }));
  },
  // Moderator-only, and invisible to the member by construction — the table it
  // writes has no policy a member can pass.
  async setAdminMsgDone(uid, done) {
    const { data, error } = await _sb.rpc("set_admin_msg_done",
      { uid: uid, done: !!done });
    if (error) throw new Error(_adminMsgErr(error) || error.message);
    return data || {};
  },
  // The badge. Two different numbers behind one name: an admin gets the count of
  // PENDING THREADS (`since` ignored), a member the count of admin replies newer
  // than `since`. Returns 0 rather than throwing — a badge is not worth an error
  // on a screen that has nothing to do with it.
  async adminMsgUnread(since) {
    const { data, error } = await _sb.rpc("admin_msg_unread", { since: since || null });
    if (error) return 0;
    const n = parseInt(data, 10);
    return n > 0 ? n : 0;
  },
  // Member → every admin. Fire-and-forget, like every other ping in this file:
  // the message is already stored, and a lost notification only means it is seen
  // when an admin next opens the inbox.
  notifyAdminMsg(id) {
    _firePush({ kind: "admin_msg", id: id });
  },
  // Admin → the one member. Same contract.
  notifyAdminMsgReply(id) {
    _firePush({ kind: "admin_msg_reply", id: id });
  },

  // ----- Special Messages (Baba Swami's Telegram posts) -------------------
  // Table: special_messages (see supabase/schema.sql + SPECIAL_MESSAGES_PLAN.md).
  // Published rows are world-readable — no sign-in needed. The offline cache in
  // app.js delta-syncs on updated_at (NOT id): the English translation arrives
  // days later as an UPDATE to an existing row, which an id delta would miss.
  async listSpecialMessages(limit) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 500, 1000));
    const { data, error } = await _sb.from("special_messages").select(_SPECIAL_COLS)
      .eq("published", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(n);
    if (error) throw new Error(_specialMissing(error) || error.message);
    return { messages: data || [] };
  },

  // Delta fetch for the offline cache: published rows changed since `sinceIso`
  // (pass ""/null for everything), PLUS the full list of live ids so the cache
  // can drop rows retracted on the server. Returns {messages, ids, lastSync}.
  // Paged in chunks of 1000 (Supabase's REST cap) — the first-ever sync pulls
  // the whole backfilled history; later syncs are a page of zero or few rows.
  async syncSpecialMessages(sinceIso) {
    const PAGE = 1000, msgs = [];
    for (let off = 0; off < 20000; off += PAGE) {
      let q = _sb.from("special_messages").select(_SPECIAL_COLS)
        .eq("published", true).order("updated_at", { ascending: true })
        .order("id", { ascending: true }).range(off, off + PAGE - 1);
      if (sinceIso) q = q.gt("updated_at", sinceIso);
      const { data, error } = await q;
      if (error) throw new Error(_specialMissing(error) || error.message);
      msgs.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    const ids = [];
    for (let off = 0; off < 40000; off += PAGE) {
      const { data, error } = await _sb.from("special_messages")
        .select("id").eq("published", true).order("id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) throw new Error(error.message);
      ids.push(...(data || []).map((r) => r.id));
      if (!data || data.length < PAGE) break;
    }
    return {
      messages: msgs,
      ids,
      lastSync: msgs.length ? msgs[msgs.length - 1].updated_at : "",
    };
  },

  // Live updates while the Special Messages screen is open (foreground only —
  // Realtime connections are the scarce free-tier resource). We can't filter
  // UPDATE events server-side by `published`, so this just signals "something
  // changed" and the caller re-runs the cheap delta sync. Returns {close()}.
  subscribeSpecial({ onChange }) {
    const ch = _sb.channel("wa-special")
      .on("postgres_changes", { event: "*", schema: "public", table: "special_messages" },
          () => { if (onChange) onChange(); })
      .subscribe();
    return { close() { try { _sb.removeChannel(ch); } catch (_) {} } };
  },

  // Admin (moderator/sutradhar — enforced by RLS): manual post / edit / retract.
  // The automated Telegram pipeline (Phases 2–3) uses the service key instead.
  async postSpecialMessage(fields) {
    const { data, error } = await _sb.from("special_messages")
      .insert(fields).select(_SPECIAL_COLS).single();
    if (error) throw new Error(_specialMissing(error) || error.message);
    return { message: data };
  },
  async updateSpecialMessage(id, fields) {
    const { data, error } = await _sb.from("special_messages")
      .update(fields).eq("id", id).select(_SPECIAL_COLS).single();
    if (error) throw new Error(_specialMissing(error) || error.message);
    return { message: data };
  },
  async deleteSpecialMessage(id) {
    const { error } = await _sb.from("special_messages").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  // ----- Important Updates ("broadcast") ---------------------------------
  // Table: broadcasts (see supabase/add_broadcast.sql + BROADCAST_PLAN.md).
  //
  // ⚠ THE NAME IS NOT THE IDENTIFIER. Displayed as "Important Updates"
  // (महत्वपूर्ण सूचना); every identifier stays `broadcast`, because "update" in
  // this repo already means the OTA update machinery.
  //
  // ⚠ Published rows are readable by AUTHENTICATED ONLY — unlike Special
  // Messages, which are world-readable. The audience is signed-in accounts, and
  // the anon key is sitting in this very file.
  //
  // The two-person rule is in Postgres, not here. Nothing in this file can
  // approve an update, and nothing here should try to pre-judge whether a
  // button will be accepted — call the RPC and show its error.

  async listBroadcasts(limit) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 300, 1000));
    const { data, error } = await _sb.from("broadcasts").select(_BROADCAST_COLS)
      .eq("published", true).or(_NOT_EXPIRED())
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(n);
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { messages: data || [] };
  },

  // Delta fetch for the offline cache: published rows changed since `sinceIso`
  // (pass ""/null for everything), PLUS the full list of live ids so the cache
  // can drop rows retracted on the server.
  //
  // ⚠ Delta on updated_at, NOT id. An edit — and a retraction — is an UPDATE to
  // an existing row, and an id-based delta would never see it.
  // ⚠ Both halves filter out EXPIRED updates, and the `ids` half is the load-
  // bearing one: it is what makes an expired update disappear from a phone that
  // already has it cached, by the same reconciliation that handles a retraction.
  // Filter the rows but not the ids and an expired update would live on every
  // device that had already synced it, forever.
  async syncBroadcasts(sinceIso) {
    const PAGE = 1000, msgs = [];
    for (let off = 0; off < 10000; off += PAGE) {
      let q = _sb.from("broadcasts").select(_BROADCAST_COLS)
        .eq("published", true).or(_NOT_EXPIRED()).order("updated_at", { ascending: true })
        .order("id", { ascending: true }).range(off, off + PAGE - 1);
      if (sinceIso) q = q.gt("updated_at", sinceIso);
      const { data, error } = await q;
      if (error) throw new Error(_broadcastMissing(error) || error.message);
      msgs.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    const ids = [];
    for (let off = 0; off < 20000; off += PAGE) {
      const { data, error } = await _sb.from("broadcasts")
        .select("id").eq("published", true).or(_NOT_EXPIRED())
        .order("id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) throw new Error(error.message);
      ids.push(...(data || []).map((r) => r.id));
      if (!data || data.length < PAGE) break;
    }
    return { messages: msgs, ids, lastSync: msgs.length ? msgs[msgs.length - 1].updated_at : "" };
  },

  // The approval queue. Drafts are invisible to everyone but moderators — that
  // is the `published or wa_is_mod()` half of the select policy, not a filter
  // applied here. A member calling this gets an empty list from Postgres.
  async listPendingBroadcasts() {
    const { data, error } = await _sb.from("broadcasts").select(_BROADCAST_COLS)
      .eq("published", false).order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { messages: data || [] };
  },

  // Write a draft. author_id / author_name are stamped by the before-insert
  // trigger, and every approval + delivery field is force-blanked there — the
  // client sends only the three things it is allowed to choose.
  //
  // ⚠ Upload attachments FIRST, insert second (the caller does this): a row
  // pointing at a missing object is unrecoverable, an orphaned object is just
  // garbage a sweep can collect.
  // `expiresOn` = "YYYY-MM-DD" or null (never expires — the default). The
  // trigger refuses a date that is already past.
  async postBroadcast({ title, body, attachments, expiresOn }) {
    const { data, error } = await _sb.from("broadcasts")
      .insert({ title: title || null, body: String(body || ""),
                attachments: attachments || [],
                expires_on: expiresOn || null })
      .select(_BROADCAST_COLS).single();
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { message: data };
  },

  // ⚠ Editing the text of an unsent update SILENTLY TEARS UP ITS APPROVAL — the
  // row returns to the queue and a second admin must read it again. That is the
  // whole point (BROADCAST_PLAN.md §4.3: write something benign, get it
  // approved, edit it, send). The trigger does it; callers must TELL THE USER it
  // is about to happen rather than being surprised by the row reappearing in
  // "Awaiting approval".
  async updateBroadcast(id, fields) {
    const { data, error } = await _sb.from("broadcasts")
      .update(fields).eq("id", id).select(_BROADCAST_COLS).single();
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { message: data };
  },

  // Approve AND publish, in one indivisible step. There is deliberately no
  // "approved but not yet sent" state — that window is where a second,
  // unreviewed edit would live.
  //
  // ⚠ An RPC, never a plain UPDATE: approved_by is stamped from auth.uid()
  // server-side, which the caller cannot forge. If this were an UPDATE the
  // author could set it to a colleague's id and self-approve.
  async approveBroadcast(id) {
    const { data, error } = await _sb.rpc("approve_broadcast", { bid: id });
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { message: data };
  },

  // Send a draft back to its author with a reason. The mirror of approve, and
  // an RPC for the same reason: declined_by is stamped from auth.uid().
  //
  // ⚠ Declining DESTROYS NOTHING — the draft returns to its author, who edits
  // and resubmits (any edit clears the decline, in the trigger) or deletes it
  // themselves. Don't "simplify" this into a delete.
  async declineBroadcast(id, reason) {
    const { data, error } = await _sb.rpc("decline_broadcast",
      { bid: id, reason: reason || null });
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { message: data };
  },
  // Tell the author. Fire-and-forget like the approval ping: the decline is
  // already recorded, and a lost notification only means they see it next time
  // they open Important Updates rather than immediately.
  notifyBroadcastDeclined(id) {
    _firePush({ kind: "broadcast_declined", id: id });
  },

  // Retract (sutradhar only, enforced by the update trigger). The cache's `ids`
  // reconciliation makes it vanish from every phone on the next sync. Prefer
  // this to deleteBroadcast — deletion leaves no trace and drops read receipts.
  async retractBroadcast(id) {
    return WA.updateBroadcast(id, { published: false });
  },
  // ⚠ `.select()` is load-bearing, not decoration. RLS turns a forbidden delete
  // into a delete that matches NO ROWS, which PostgREST reports as success —
  // so without asking for the deleted rows back this said "Draft deleted." over
  // a draft that is still there. Deletable: your own unpublished draft, or
  // anything at all if you are the sutradhar (add_broadcast.sql §7).
  async deleteBroadcast(id) {
    const { data, error } = await _sb.from("broadcasts").delete().eq("id", id).select("id");
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      throw new Error("You can only delete your own draft — ask the sutradhar to remove this one.");
    }
    return { ok: true };
  },

  // ---- the send itself --------------------------------------------------
  // AWAITED, unlike every other push in this file, because the answer is the
  // delivery result the confirm screen and the admin list both need, and
  // because a silent failure here is an update that is live in the app with
  // nobody told. Returns {devices, sent, pruned} or {skipped:"already sent"}.
  async sendBroadcastPush(id) {
    return _awaitPush({ kind: "broadcast", id: id });
  },
  // The approval ping to the OTHER admins. Fire-and-forget: a draft that fails
  // to ping is still a draft sitting in the queue, and re-submitting pings
  // again.
  notifyBroadcastPending(id) {
    _firePush({ kind: "broadcast_pending", id: id });
  },
  // How many devices the send would reach — counted the same way send-push
  // resolves the audience, so the confirm screen's number is the real one.
  async broadcastAudienceCount() {
    const { data, error } = await _sb.rpc("broadcast_audience_count");
    if (error) return null;              // a missing RPC must not block the send
    return typeof data === "number" ? data : null;
  },
  // Record what actually happened. The only delivery field the client may
  // write, and only once — the trigger refuses to let it be cleared, because
  // clearing it would unlock editing an update that people have already read.
  async recordBroadcastDelivery(id, devices, sent) {
    return WA.updateBroadcast(id, {
      notified_at: new Date().toISOString(),
      notified_devices: typeof devices === "number" ? devices : null,
      notified_sent: typeof sent === "number" ? sent : null,
    });
  },
  // ⚠ A DELIBERATE ADMIN ACTION, never a side effect of pressing Resend. The
  // sent key is the only thing between a double-tap and hundreds of duplicate
  // notifications; the normal Resend path re-invokes WITHOUT clearing it, so a
  // push that really went out is skipped rather than repeated.
  async clearBroadcastSentKey(id) {
    const { error } = await _sb.rpc("clear_broadcast_sent_key", { bid: id });
    if (error) throw new Error(_broadcastMissing(error) || error.message);
    return { ok: true };
  },

  // ---- read receipts ----------------------------------------------------
  // user_id is stamped by the trigger. A duplicate is the primary key doing its
  // job — swallowed exactly as addReaction() does. Fire-and-forget by contract:
  // never block a render on recording that it happened.
  async markBroadcastRead(id) {
    const { error } = await _sb.from("broadcast_reads").insert({ broadcast_id: id });
    if (error && !/duplicate key|23505/i.test(error.message || "")) throw new Error(error.message);
    return { ok: true };
  },
  // {"<id>": count} for the admin list. An RPC rather than a select so the list
  // doesn't pull one row per reader per update.
  async broadcastReadCounts() {
    const { data, error } = await _sb.rpc("broadcast_read_counts");
    if (error) return {};
    return data || {};
  },

  // ---- attachments ------------------------------------------------------
  // The Satsang picker path pointed at a DIFFERENT bucket. satsang-media's read
  // policy is wa_member_ok(), and an Important Update reaches every signed-in
  // account including visitors — who would be locked out of an attachment on an
  // announcement addressed to them.
  //
  // ⚠ Same three gates as everywhere else: MEDIA_MIMES here, the extension
  // check in app.js, and the bucket's allowed_mime_types. Audio and video are
  // never allowed. Don't widen any of them.
  async uploadBroadcastMedia(blob, name, extra) {
    const mime = blob.type || "application/octet-stream";
    if (!WA.MEDIA_MIMES.includes(mime)) {
      throw new Error("Only images and PDF files can be attached to an update.");
    }
    const ext = (mime === "application/pdf") ? "pdf" : (mime.split("/")[1] || "bin");
    const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    const path = `${rand}.${ext}`;
    const { error } = await _sb.storage.from("broadcast-media")
      .upload(path, blob, { contentType: mime, upsert: false });
    if (error) {
      if (/Bucket not found|not found/i.test(error.message || "")) {
        throw new Error("Attachments aren't set up yet. (Admin: run section 9 of supabase/add_broadcast.sql.)");
      }
      throw new Error(error.message);
    }
    return Object.assign({ path, mime, bytes: blob.size, name: name || "" }, extra || {});
  },

  // The bucket is PRIVATE, so rendering needs signed URLs. ⚠ Batched — sign
  // every image in the update in ONE call before the first paint, or it is a
  // round trip per picture. Returns {path: url}.
  async signedBroadcastUrls(paths, seconds) {
    if (!paths || !paths.length) return {};
    const { data, error } = await _sb.storage.from("broadcast-media")
      .createSignedUrls(paths, seconds || 3600);
    if (error) throw new Error(error.message);
    const out = {};
    (data || []).forEach((d) => { if (d && d.path && d.signedUrl) out[d.path] = d.signedUrl; });
    return out;
  },

  // Live updates while the Important Updates screen is open (foreground only).
  // Can't filter UPDATE events server-side by `published`, so this just signals
  // "something changed" and the caller re-runs the cheap delta sync.
  subscribeBroadcasts({ onChange }) {
    const ch = _sb.channel("wa-broadcast")
      .on("postgres_changes", { event: "*", schema: "public", table: "broadcasts" },
          () => { if (onChange) onChange(); })
      .subscribe();
    return { close() { try { _sb.removeChannel(ch); } catch (_) {} } };
  },

  // ----- Personal data backup (favourites + notes) ------------------------
  // Table: user_data (see supabase/schema.sql). Favourites and notes live only
  // in this device's localStorage, so "Clear storage" or a lost phone destroys
  // them — unlike every other section, which is bundled in the APK or
  // re-syncable. This is their off-device copy. One private row per user.
  async loadUserData() {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return null;                     // signed out — nothing to restore
    const { data, error } = await _sb.from("user_data")
      .select("favorites,notes,updated_at").eq("user_id", session.user.id).maybeSingle();
    if (error) throw new Error(_userDataMissing(error) || error.message);
    if (!data) return { favorites: [], notes: {}, updated_at: null };
    return {
      favorites: Array.isArray(data.favorites) ? data.favorites : [],
      notes: (data.notes && typeof data.notes === "object") ? data.notes : {},
      updated_at: data.updated_at,
    };
  },
  // Writes the MERGED set (app.js merges — see syncUserData there), never a
  // bare local overwrite, so a second device can't wipe the first one's data.
  async saveUserData(favorites, notes) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return { ok: false };
    const row = { user_id: session.user.id, favorites: favorites || [], notes: notes || {} };
    const { error } = await _sb.from("user_data").upsert(row, { onConflict: "user_id" });
    if (error) throw new Error(_userDataMissing(error) || error.message);
    return { ok: true };
  },

  // ----- Community access requests ---------------------------------------
  // Every user now has an account (hard startup gate), but an account is only a
  // BROWSING pass — role 'visitor'. Joining the community is a separate, explicit
  // ask that a moderator approves. See the access_requests section of schema.sql.
  //
  // Returns {ok, already_pending, status, requested_at}. Idempotent server-side,
  // so a double tap can't queue two requests.
  requestAccess(note) { return _rpc("request_community_access", { note_text: note || "" }); },

  // The caller's own state, for the button's label: {role, status, requested_at,
  // decided_at}. `status` is null when they have never asked. Never throws for a
  // missing table — the button just falls back to "not requested".
  async myAccessRequest() {
    try { return await _rpc("my_access_request"); }
    catch (e) {
      if (_accessMissing(e)) return { role: null, status: null, unavailable: true };
      throw e;
    }
  },

  // Moderator side of the queue.
  async listAccessRequests() {
    try { return await _rpc("list_access_requests"); }
    catch (e) {
      const m = _accessMissing(e);
      if (m) throw new Error(m);
      throw e;
    }
  },
  // `userId` (from the request row) is what the decision notification is sent
  // to. Optional so an older caller still works — it just won't notify.
  async approveAccess(id, userId) {
    const d = await _rpc("approve_access_request", { rid: id });
    if (userId) _firePush({ kind: "access", user_id: userId, status: "approved" });
    return d;
  },
  async denyAccess(id, userId) {
    const d = await _rpc("deny_access_request", { rid: id });
    if (userId) _firePush({ kind: "access", user_id: userId, status: "denied" });
    return d;
  },

  // ----- Moderator ------------------------------------------------------
  listUsers() { return _rpc("list_users"); },
  listMembers() { return _rpc("list_members"); },
  // The role dropdown is the other way a moderator settles an access request, so
  // it notifies exactly like Approve/Deny — but ONLY when the person was
  // actually waiting ('pending'). Without that check, routine housekeeping on a
  // visitor who never asked would tell them they'd been turned down.
  async setRole(id, role, prevRole) {
    const d = await _rpc("set_user_role", { uid: id, new_role: role });
    _dropProfileCache();      // an admin may well have just done this to themselves
    if (prevRole === "pending") {
      if (role === "member" || role === "moderator") _firePush({ kind: "access", user_id: id, status: "approved" });
      else if (role === "visitor") _firePush({ kind: "access", user_id: id, status: "denied" });
    }
    return d;
  },
  // Same reason as setRole: these can land on the caller's own row, and the
  // cached copy must not outlive the change that a moderator just made.
  async renameUser(id, username) { const d = await _rpc("rename_user", { uid: id, new_username: username }); _dropProfileCache(); return d; },
  async deleteUser(id) { const d = await _rpc("delete_user", { uid: id }); _dropProfileCache(); return d; },
  async toggleMute(id) { const d = await _rpc("toggle_mute", { uid: id }); _dropProfileCache(); return d; },
  async transferLeadership(id) { const d = await _rpc("transfer_leadership", { uid: id }); _dropProfileCache(); return d; },
  setSignup(enabled) { return _rpc("set_signup", { enabled }); },

  // ----- Admin device binding (ADMIN_DEVICE_BINDING_PLAN.md) --------------
  // Moderator/sutradhar powers only work from a device the Sutradhar approved.
  // NOTHING here is a security check — every decision is made by Postgres
  // (wa_device_ok()), because the anon key ships in this file and anyone can
  // call PostgREST directly without loading the SPA. These methods only decide
  // what to OFFER; the server decides what to allow.
  //
  // ⚠ Ordinary members never touch any of this. Only 'moderator' and
  // 'sutradhar' need a device, so gate the UI on role before calling.

  deviceCapabilities() { return _deviceCapabilities(); },
  deviceIsSignedIn() { return !!_deviceHeader; },

  // Create the key (if needed) and queue this device for the Sutradhar.
  // Returns {id, status, enroll_code} — the code is read aloud so the Sutradhar
  // knows WHICH request they are approving. It is not a secret.
  async enrollDevice(label) {
    label = (label || "").trim();
    if (!label) throw new Error("Please give this device a name.");
    const key = await _deviceEnsureKey();
    let d;
    try {
      d = await _rpc("enroll_device", {
        p_label: label, p_platform: key.platform,
        p_pubkey: key.publicKey, p_machine_note: key.label || null,
      });
    } catch (e) {
      throw new Error(_devicesMissing(e) || e.message);
    }
    // Tell the Sutradhar at once — an enrolment they did not expect is the
    // early-warning signal the whole threat model leans on. Only for a NEW
    // request: `already` means we just handed back an existing row, and
    // re-notifying on every retry would train them to ignore it.
    if (d && !d.already) _firePush({ kind: "device_request", device_id: d.id });
    return d;
  },

  // Prove possession of the key and obtain the 12h session header.
  //
  // Call it after the auth gate clears and before any moderator UI. Returns
  // false rather than throwing when this device simply isn't enrolled — that is
  // the ordinary state for a moderator on a new machine, not an error.
  //
  // ⚠ REALTIME IS NOT COVERED. The header rides a custom fetch, but Realtime is
  // a WebSocket and carries no headers, so `request.headers` is unset when
  // Postgres evaluates RLS for a postgres_changes subscription. Once Phase 6
  // puts wa_member_ok() on messages_select, an admin would keep full access
  // through PostgREST (send, reload, moderate) but stop receiving LIVE updates.
  // Unresolved — see the Phase 6 note in the plan. It does not bite in audit
  // mode, and it does not affect ordinary members at all.
  //
  // ⚠ SINGLE-FLIGHT. Concurrent callers share one handshake rather than racing —
  // see _deviceSignInFlight. Awaiting this from the UI is therefore cheap and
  // safe even while the boot call is still running.
  deviceSignIn() {
    if (_deviceHeader) return Promise.resolve(true);
    if (_deviceSignInFlight) return _deviceSignInFlight;
    _deviceSignInFlight = _deviceSignIn().finally(() => { _deviceSignInFlight = null; });
    return _deviceSignInFlight;
  },

  // Drop the session proof without touching the key — used by sign-out, so the
  // next person on this machine starts from nothing.
  //
  // Clears the in-flight handshake too, so a sign-in by the NEXT person starts a
  // fresh one instead of joining the departing user's.
  deviceSignOut() { _deviceHeader = null; _deviceSignInFlight = null; },

  myDevices() { return _rpc("list_my_devices"); },
  revokeDevice(id) { return _rpc("revoke_device", { p_id: id }); },

  // Throw this machine's key away so the next enrolment generates a fresh one.
  // The escape hatch for a key that can no longer be used: one created before
  // requireAuth:false (so it still demands an unlock inside 60s), or one Android
  // invalidated when the screen lock changed.
  //
  // ⚠ Revokes the server-side row FIRST, then destroys the local key. That order
  // matters: wa_device_cap() caps an account at 3 devices, so leaving the dead
  // row behind would let two re-registrations exhaust the allowance and the
  // third fail with a cap error that looks unrelated to what the user did. If
  // revoke succeeds and the delete then fails, the device is merely revoked —
  // recoverable. The reverse order can strand a row nothing can ever sign for.
  async resetDeviceKey() {
    let mine = { devices: [] };
    try { mine = await _rpc("list_my_devices"); } catch (_) {}
    for (const d of (mine.devices || [])) {
      if (d.status === "active" || d.status === "pending") {
        try { await _rpc("revoke_device", { p_id: d.id }); } catch (_) {}
      }
    }
    await _deviceDeleteKey();

    // Confirm the key is actually gone rather than trusting the call returned.
    // ⚠ Not belt-and-braces — it closes a real dead end. enroll_device() rejects
    // a pubkey whose row is 'revoked' outright ("This device was revoked. Ask
    // the Sutradhar to re-approve it."), so a delete that quietly failed would
    // leave the old key in place and turn the next Register tap into that error,
    // which names neither the cause nor a way out. Failing here instead keeps
    // the user on the one screen that can still fix it, and this reset is safe
    // to run again: the revokes are already done and deleting is idempotent.
    let gone = false;
    try { gone = !(await _deviceCapabilities()).hasKey; } catch (_) { gone = true; }
    if (!gone) {
      throw new Error(
        "This device's key could not be removed. Please close the app completely, " +
        "open it again, and retry.");
    }

    _deviceHeader = null;
    _deviceSignInFlight = null;
  },

  // ----- Sutradhar only ---------------------------------------------------
  listDeviceRequests() { return _rpc("list_device_requests"); },
  listAdminDevices() { return _rpc("list_admin_devices"); },
  approveDevice(id) { return _rpc("approve_device", { p_id: id }); },
  denyDevice(id) { return _rpc("deny_device", { p_id: id }); },
  reinstateDevice(id) { return _rpc("reinstate_device", { p_id: id }); },

  // Returns the 8 plaintext codes ONCE. The caller must show them and warn, in
  // Hindi, against screenshotting: a screenshot puts the codes and the device
  // in the same pocket and defeats the whole feature.
  generateRecoveryCodes() { return _rpc("generate_recovery_codes"); },
  approveWithRecovery(id, code) {
    return _rpc("approve_device_with_recovery", { p_id: id, p_code: code });
  },
};

window.WA = WA;
