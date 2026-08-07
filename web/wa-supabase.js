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
  };
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

// Fire-and-forget notification fan-out through the send-push Edge Function
// (which authenticates this call and works out the audience — see its header).
// Deliberately never awaited and never allowed to throw into the caller: a
// notification that fails to send must not make a sent message look unsent.
//
// ⚠ The trade-off: if the sender's app is killed in the moment between the
// INSERT and this call, nobody gets notified about that message. A Supabase
// Database Webhook on `messages` would be immune to that, at the cost of
// dashboard configuration. Move to one if dropped notifications show up.
function _firePush(payload) {
  try {
    _sb.functions.invoke("send-push", { body: payload })
      .then((r) => { if (r && r.error) console.warn("send-push:", r.error.message || r.error); })
      .catch((e) => console.warn("send-push failed:", e));
  } catch (e) { console.warn("send-push failed:", e); }
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

  async logout() { try { await _sb.auth.signOut(); } catch (_) {} },

  // Sync, no network: is a session stored on this device? The startup gate's
  // offline-grace check — see _hasStoredSession().
  hasStoredSession() { return _hasStoredSession(); },

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
  // Returns {messages, can_moderate, can_delete, me, is_muted} or throws an Error
  // tagged with .code = "AUTH" (not signed in) / "FORBIDDEN" (not a member).
  //
  // ⚠ can_moderate and can_delete are NOT the same thing (2026-08-06). Removing a
  // message is SUTRADHAR-ONLY — moderators keep every other power but lost this
  // one. Postgres enforces it (`messages_delete` uses wa_is_sutradhar(), see
  // supabase/add_satsang_chat.sql); this flag only decides whether the UI offers
  // an action that would be rejected anyway. Anything reading can_moderate to
  // decide "may delete" is now wrong.
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
    const res = { messages: (data || []).map(_mapMsg), can_moderate: isMod, me: user.username,
                  can_delete: user.role === "sutradhar" };
    if (!isMod) res.is_muted = !!user.chat_muted;
    return res;
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
    _firePush({ kind: "chat", id: data.id });
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
  subscribeChat(wid, { me, onMessage, onUpdate, onDelete, onReact, onUnreact, onTyping, onPresence, onPin }) {
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
    return {
      close() { try { _sb.removeChannel(ch); } catch (_) {} },
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
    return { messages: data.filter((r) => !r.deleted_at)
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
      const t = byWid.get(r.wisdom_id);
      if (t) { t.count++; continue; }
      byWid.set(r.wisdom_id, {
        wid: r.wisdom_id, count: 1, last_at: r.created_at,
        last_user: r.username, last_text: (r.text || "").slice(0, 160),
      });
    }
    return { threads: [...byWid.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1)) };
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
  async registerDeviceToken(token, platform) {
    if (!token) return { ok: false };
    const plat = platform || "android";
    // Remembered so app.js can re-register after sign-in without waiting for
    // FCM to hand out the token again (it only fires once per install).
    try { localStorage.setItem("wa:push:token", token); } catch (_) {}
    const { error } = await _sb.rpc("register_device_token", { tok: token, plat });
    if (!error) return { ok: true };
    if (!/register_device_token|schema cache|does not exist|not find/i.test(error.message || "")) {
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
    if (prevRole === "pending") {
      if (role === "member" || role === "moderator") _firePush({ kind: "access", user_id: id, status: "approved" });
      else if (role === "visitor") _firePush({ kind: "access", user_id: id, status: "denied" });
    }
    return d;
  },
  renameUser(id, username) { return _rpc("rename_user", { uid: id, new_username: username }); },
  deleteUser(id) { return _rpc("delete_user", { uid: id }); },
  toggleMute(id) { return _rpc("toggle_mute", { uid: id }); },
  transferLeadership(id) { return _rpc("transfer_leadership", { uid: id }); },
  setSignup(enabled) { return _rpc("set_signup", { enabled }); },
};

window.WA = WA;
