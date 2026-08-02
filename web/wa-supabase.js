"use strict";
// ==========================================================================
// Wisdom Archive — Supabase community client (Phase 1).
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

const _sb = supabase.createClient(WA_SUPABASE_URL, WA_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "wa:sb-session" },
});

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Turn a Supabase Auth error into the plain-English text the old API returned.
function _authMsg(error) {
  const m = (error && error.message) || "Something went wrong.";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/already registered|already exists/i.test(m)) return "An account with that email already exists.";
  if (/email.*confirm|confirm.*email/i.test(m)) return "Please confirm your email, then sign in.";
  return m;
}

// A profile row → the `user` object the UI uses (matches auth.py _public_user).
function _userFromProfile(p) {
  return {
    id: p.id, username: p.username, role: p.role, email: p.email,
    chat_muted: !!p.chat_muted, chat_credits: p.chat_credits, created: p.created,
  };
}
function _mapMsg(row) {
  return { id: row.id, user: row.username, text: row.text, ts: row.created_at };
}

// Friendly text when the admin_messages table hasn't been created yet (the
// schema addition must be run once in the Supabase dashboard).
function _tableMissing(error) {
  return /admin_messages.*(does not exist|not find|schema cache)/i.test(error.message || "")
    ? "The message box isn't set up yet. (Admin: run the admin_messages section of supabase/schema.sql.)"
    : null;
}

// Friendly text when the user_data backup table hasn't been created yet.
function _userDataMissing(error) {
  return /user_data.*(does not exist|not find|schema cache)/i.test(error.message || "")
    ? "Backup isn't set up yet. (Admin: run the user_data section of supabase/schema.sql.)"
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

async function _loadProfile(uid) {
  const { data, error } = await _sb.from("profiles").select("*").eq("id", uid).single();
  if (error) throw new Error(error.message);
  return _userFromProfile(data);
}
async function _rpc(name, args) {
  const { data, error } = await _sb.rpc(name, args || {});
  if (error) throw new Error(error.message);
  return data;
}

const WA = {
  // ----- Auth -----------------------------------------------------------
  async login(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({ email: (email || "").trim(), password });
    if (error) throw new Error(_authMsg(error));
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  async register(username, email, password) {
    username = (username || "").trim();
    email = (email || "").trim();
    if (!USERNAME_RE.test(username)) throw new Error("Username must be 3–20 letters, numbers, or underscores.");
    if (!EMAIL_RE.test(email)) throw new Error("Please enter a valid email address.");
    if ((password || "").length < 6) throw new Error("Password must be at least 6 characters.");
    const { data, error } = await _sb.auth.signUp({ email, password, options: { data: { username } } });
    if (error) throw new Error(_authMsg(error));
    if (!data.session) throw new Error("Account created. Please confirm your email, then sign in.");
    return { token: data.session.access_token, user: await _loadProfile(data.user.id) };
  },

  async logout() { try { await _sb.auth.signOut(); } catch (_) {} },

  // Current session + fresh profile (used on boot to refresh role/state).
  async me() {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw new Error("Not signed in.");
    return { token: session.access_token, user: await _loadProfile(session.user.id) };
  },

  async authConfig() {
    const { data } = await _sb.from("app_settings").select("value").eq("key", "signup_enabled").maybeSingle();
    return { signup_enabled: !data || data.value === "1" };
  },

  // ----- Conclusions ----------------------------------------------------
  getConclusion(wid) { return _rpc("get_conclusion", { wid: String(wid) }); },
  saveConclusion(wid, text, visibility) {
    return _rpc("save_conclusion", { wid: String(wid), body_text: text, vis: visibility || "public" });
  },

  // ----- Chat -----------------------------------------------------------
  // Returns {messages, can_moderate, me, credits_remaining, is_muted} or throws
  // an Error tagged with .code = "AUTH" (not signed in) / "FORBIDDEN" (not a member).
  async getChat(wid) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in."), { code: "AUTH" });
    const user = await _loadProfile(session.user.id);
    const isMod = user.role === "moderator" || user.role === "sutradhar";
    if (!(isMod || user.role === "member")) {
      throw Object.assign(new Error("Members only."), { code: "FORBIDDEN" });
    }
    const { data, error } = await _sb.from("messages").select("*")
      .eq("wisdom_id", String(wid)).order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const res = { messages: (data || []).map(_mapMsg), can_moderate: isMod, me: user.username };
    if (!isMod) { res.credits_remaining = user.chat_credits; res.is_muted = !!user.chat_muted; }
    return res;
  },

  // Returns {message, credits_remaining}; throws Error.code MUTED / NO_CREDITS
  // so the UI can react exactly as it did to the old 403 detail codes.
  async postMessage(wid, text) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in."), { code: "AUTH" });
    const me = await _loadProfile(session.user.id);
    const isMod = me.role === "moderator" || me.role === "sutradhar";
    if (!isMod) {
      if (me.chat_muted) throw Object.assign(new Error("You have been muted."), { code: "MUTED" });
      if (me.role === "member" && me.chat_credits <= 0) throw Object.assign(new Error("No credits."), { code: "NO_CREDITS" });
    }
    const { data, error } = await _sb.from("messages")
      .insert({ wisdom_id: String(wid), text: text }).select("*").single();
    if (error) throw new Error(error.message);
    let credits_remaining = null;
    if (!isMod && me.role === "member") credits_remaining = Math.max(0, me.chat_credits - 1);
    return { message: _mapMsg(data), credits_remaining };
  },

  async deleteMessage(wid, mid) {
    const { error } = await _sb.from("messages").delete().eq("id", mid);
    if (error) throw new Error(error.message);
    return { ok: true };
  },
  async clearChat(wid) {
    const { error } = await _sb.from("messages").delete().eq("wisdom_id", String(wid));
    if (error) throw new Error(error.message);
    return { ok: true };
  },
  requestCredits() { return _rpc("request_credits"); },

  // Live chat via Supabase Realtime (replaces the SSE stream). Returns a handle
  // with .close(). onMessage(msg) / onDelete(id) fire on inserts/deletes.
  subscribeChat(wid, { onMessage, onDelete }) {
    const filter = "wisdom_id=eq." + String(wid);
    const ch = _sb.channel("wa-chat-" + wid)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter },
          (p) => { if (onMessage) onMessage(_mapMsg(p.new)); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages", filter },
          (p) => { if (onDelete && p.old) onDelete(p.old.id); })
      .subscribe();
    return { close() { try { _sb.removeChannel(ch); } catch (_) {} } };
  },

  // Recent messages across all wisdoms (members+ only; guests get an empty list
  // because RLS hides messages from non-members). Shape: {messages:[{user,wid,text,ts}]}.
  async communityRecent(limit) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 20, 50));
    const { data, error } = await _sb.from("messages")
      .select("wisdom_id, username, text, created_at")
      .order("created_at", { ascending: false }).limit(n);
    if (error || !data) return { messages: [] };
    return { messages: data.map((r) => ({ user: r.username, wid: r.wisdom_id, text: r.text, ts: r.created_at })) };
  },

  // ----- Push notifications (Phase 4) ------------------------------------
  // Register this device's FCM token so the send-push Edge Function can reach
  // it when a new Special Message publishes. Anonymous devices are allowed
  // (the archive works signed-out) — device_tokens permits anon INSERT, and
  // nothing is readable back (RLS). Idempotent on the unique token via upsert.
  async registerDeviceToken(token, platform) {
    if (!token) return { ok: false };
    const { data: { session } } = await _sb.auth.getSession();
    const row = { token, platform: platform || "android", user_id: session ? session.user.id : null };
    // Plain INSERT — anon devices have the INSERT grant but NOT the extra
    // privileges PostgREST's upsert / ON CONFLICT path requires (that returned
    // "permission denied for table device_tokens"). The token column is unique,
    // so a repeat registration returns 23505 (unique_violation) which we treat
    // as success (already stored). Rotated/stale tokens are pruned server-side
    // by send-push on an FCM 404/UNREGISTERED.
    const { error } = await _sb.from("device_tokens").insert(row);
    if (error && error.code !== "23505") throw new Error(error.message);
    return { ok: true };
  },

  // ----- Message to admin (mobile "Message to Admin" page) ---------------
  // Table: admin_messages (see supabase/schema.sql). Signed-in users write;
  // they see their own messages, moderators/sutradhar see everyone's.
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
  async myAdminMessages() {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return { messages: [] };
    const { data, error } = await _sb.from("admin_messages").select("*")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw new Error(_tableMissing(error) || error.message);
    return { messages: (data || []).map((r) => ({ id: r.id, text: r.text, ts: r.created_at })) };
  },
  // Moderators/sutradhar: every user's messages, newest first.
  async listAdminMessages() {
    const { data, error } = await _sb.from("admin_messages").select("*")
      .order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(_tableMissing(error) || error.message);
    return { messages: (data || []).map((r) => ({ id: r.id, user: r.username, text: r.text, ts: r.created_at })) };
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

  // ----- Moderator ------------------------------------------------------
  listUsers() { return _rpc("list_users"); },
  listMembers() { return _rpc("list_members"); },
  setRole(id, role) { return _rpc("set_user_role", { uid: id, new_role: role }); },
  renameUser(id, username) { return _rpc("rename_user", { uid: id, new_username: username }); },
  deleteUser(id) { return _rpc("delete_user", { uid: id }); },
  toggleMute(id) { return _rpc("toggle_mute", { uid: id }); },
  setCredits(id, credits) { return _rpc("set_credits", { uid: id, credits }); },
  transferLeadership(id) { return _rpc("transfer_leadership", { uid: id }); },
  setSignup(enabled) { return _rpc("set_signup", { enabled }); },
  listCreditRequests() { return _rpc("list_credit_requests"); },
  approveCreditRequest(id, credits) { return _rpc("approve_credit_request", { rid: id, credits }); },
  denyCreditRequest(id) { return _rpc("deny_credit_request", { rid: id }); },
};

window.WA = WA;
