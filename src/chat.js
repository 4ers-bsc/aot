// ===========================================================================
// Home chat — a broadcast chat box that lives on the landing screen.
//
//   • Everyone (even before sign-in) reads the message stream, the live online
//     count, and the running Yes/No vote tally. Reads are public RLS SELECTs +
//     Realtime Postgres Changes (see migration 20260817_home_chat.sql).
//   • ONLY the host posts messages and opens/closes votes. Both go through the
//     admin-gated f10admin edge function — the browser never writes a message,
//     and the composer + poll controls are revealed only after a `chat_admin`
//     probe confirms the caller is the allow-listed operator.
//   • Any signed-in player casts / changes a Yes or No while a vote is open
//     (cast_chat_vote RPC); the count updates for everyone in real time.
//
// Wiring lives in main.js: it feeds the presence online count in via
// setOnline(), and calls refreshAuth() whenever the session changes so the
// host controls appear/disappear with sign-in/out.
// ===========================================================================
import { escapeHtml } from "./utils.js";
import { APPEARANCE_PRESETS } from "./appearance.js";

const MSG_LIMIT = 60;   // history rows fetched on first paint
const MSG_MAX_DOM = 200; // trim the stream so it can't grow without bound

// Skin int (0xRRGGBB) → CSS hex, for the little per-message avatar dot.
function skinColor(skinId) {
  const preset = APPEARANCE_PRESETS[skinId] || APPEARANCE_PRESETS[1];
  return "#" + (preset.skin >>> 0).toString(16).padStart(6, "0");
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function initHomeChat({ supabase, getUser, getProfile, signIn }) {
  // ---- DOM ------------------------------------------------------------------
  const root        = document.getElementById("homeChat");
  if (!root) return { refreshAuth() {}, setOnline() {} };
  const launcher    = document.getElementById("chatLauncher");
  const badge       = document.getElementById("chatBadge");
  const collapseBtn = document.getElementById("chatCollapse");
  const onlineEl    = document.getElementById("chatOnlineCount");
  const messagesEl  = document.getElementById("chatMessages");
  const emptyEl     = document.getElementById("chatEmpty");
  const composer    = document.getElementById("chatComposer");
  const input       = document.getElementById("chatInput");
  const readonlyEl  = document.getElementById("chatReadonly");
  // Poll (public)
  const pollEl      = document.getElementById("chatPoll");
  const pollQEl     = document.getElementById("chatPollQuestion");
  const yesBtn      = document.getElementById("voteYesBtn");
  const noBtn       = document.getElementById("voteNoBtn");
  const yesCountEl  = document.getElementById("voteYesCount");
  const noCountEl   = document.getElementById("voteNoCount");
  const pollBarEl   = document.getElementById("chatPollBar");
  const pollTotalEl = document.getElementById("chatPollTotal");
  const pollStateEl = document.getElementById("chatPollState");
  // Poll (host controls)
  const adminEl     = document.getElementById("chatAdmin");
  const pollInput   = document.getElementById("chatPollInput");
  const openBtn     = document.getElementById("chatPollOpenBtn");
  const closeBtn    = document.getElementById("chatPollCloseBtn");
  const adminHint   = document.getElementById("chatAdminHint");

  // ---- State ----------------------------------------------------------------
  let isAdmin   = false;
  let poll      = null;   // { id, question, is_open, yes_count, no_count }
  let yourVote  = null;   // true = yes, false = no, null = not voted
  let collapsed = true;
  let unread    = 0;
  const seen    = new Set(); // message ids already in the DOM
  let voting    = false;

  // ---- Collapse / expand ----------------------------------------------------
  try {
    const pref = localStorage.getItem("f10_chat_open");
    collapsed = pref === "1" ? false
              : pref === "0" ? true
              : window.matchMedia("(max-width: 820px)").matches; // default: open on desktop
  } catch { collapsed = false; }

  function applyCollapsed() {
    root.classList.toggle("collapsed", collapsed);
    root.classList.toggle("open", !collapsed);
    if (!collapsed) { unread = 0; renderBadge(); scrollToBottom(); }
  }
  function setCollapsed(v) {
    collapsed = v;
    try { localStorage.setItem("f10_chat_open", v ? "0" : "1"); } catch { /* private mode */ }
    applyCollapsed();
  }
  function renderBadge() {
    if (!badge) return;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.classList.toggle("hidden", unread <= 0 || !collapsed);
  }

  launcher?.addEventListener("click", () => setCollapsed(false));
  collapseBtn?.addEventListener("click", () => setCollapsed(true));

  // ---- Messages -------------------------------------------------------------
  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function messageNode(m) {
    const el = document.createElement("div");
    el.className = "hc-msg";
    el.dataset.id = String(m.id);
    const name = m.author_name || "Host";
    el.innerHTML =
      `<span class="hc-avatar" style="background:${skinColor(m.author_skin)}"></span>` +
      `<div class="hc-msg-body">` +
        `<div class="hc-msg-head">` +
          `<span class="hc-msg-name">${escapeHtml(name)}</span>` +
          `<span class="hc-msg-host">HOST</span>` +
          `<span class="hc-msg-time">${fmtTime(m.created_at)}</span>` +
        `</div>` +
        `<div class="hc-msg-text">${escapeHtml(m.body || "")}</div>` +
      `</div>`;
    return el;
  }

  // Append one message (from history or realtime). `live` marks a realtime
  // arrival, which drives the unread badge while collapsed.
  function appendMessage(m, live) {
    if (!m || m.id == null || seen.has(m.id)) return;
    seen.add(m.id);
    emptyEl?.classList.add("hidden");
    messagesEl?.appendChild(messageNode(m));
    // Trim oldest nodes so the DOM stays bounded.
    while (messagesEl && messagesEl.children.length > MSG_MAX_DOM + 1) {
      const first = messagesEl.querySelector(".hc-msg");
      if (!first) break;
      seen.delete(Number(first.dataset.id));
      first.remove();
    }
    if (live && collapsed) { unread += 1; renderBadge(); }
    if (!collapsed) scrollToBottom();
  }

  // Remove a message the host deleted (realtime DELETE). payload.old carries the
  // primary key, which is enough to find and drop the node.
  function removeMessage(id) {
    if (id == null) return;
    seen.delete(id);
    messagesEl?.querySelector(`.hc-msg[data-id="${id}"]`)?.remove();
    if (messagesEl && !messagesEl.querySelector(".hc-msg")) emptyEl?.classList.remove("hidden");
  }

  async function loadMessages() {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, body, author_id, author_name, author_skin, created_at")
      .order("id", { ascending: false })
      .limit(MSG_LIMIT);
    if (error) { console.error("chat: loadMessages", error); return; }
    const rows = (data || []).slice().reverse(); // oldest → newest
    if (rows.length) emptyEl?.classList.add("hidden");
    for (const m of rows) appendMessage(m, false);
    scrollToBottom();
  }

  // ---- Poll rendering -------------------------------------------------------
  function renderPoll() {
    const open = !!(poll && poll.is_open);
    pollEl?.classList.toggle("hidden", !open);
    if (open) {
      const yes = poll.yes_count || 0;
      const no  = poll.no_count || 0;
      const total = yes + no;
      if (pollQEl) pollQEl.textContent = poll.question || "Yes or No?";
      if (yesCountEl) yesCountEl.textContent = String(yes);
      if (noCountEl)  noCountEl.textContent  = String(no);
      if (pollBarEl)  pollBarEl.style.width  = total ? `${Math.round((yes / total) * 100)}%` : "50%";
      if (pollTotalEl) pollTotalEl.textContent = `${total} vote${total === 1 ? "" : "s"}`;
      if (pollStateEl) pollStateEl.textContent = yourVote == null ? "" : (yourVote ? "You voted YES" : "You voted NO");
      yesBtn?.classList.toggle("chosen", yourVote === true);
      noBtn?.classList.toggle("chosen", yourVote === false);
    }
    renderAdminControls();
  }

  function renderAdminControls() {
    if (!adminEl) return;
    adminEl.classList.toggle("hidden", !isAdmin);
    if (!isAdmin) return;
    const open = !!(poll && poll.is_open);
    openBtn?.classList.toggle("hidden", open);
    closeBtn?.classList.toggle("hidden", !open);
    if (pollInput) pollInput.disabled = open;
  }

  // Merge a chat_poll row from realtime (payload.new carries every column).
  function adoptPollRow(row, isInsert) {
    if (!row) return;
    if (isInsert) {
      // A brand-new poll opened — nobody has voted it yet.
      poll = row;
      yourVote = null;
    } else if (poll && row.id === poll.id) {
      poll = row; // same poll: refreshed counts / open flag
    } else if (row.is_open) {
      // An open poll we didn't know about (e.g. missed the insert).
      poll = row;
      loadPollState().catch(() => {});
    }
    renderPoll();
  }

  // Authoritative snapshot: latest poll + this user's own vote. Used on first
  // paint, on reconnect, and after sign-in — not on every incoming vote.
  async function loadPollState() {
    const { data, error } = await supabase.rpc("get_chat_state");
    if (error) { console.error("chat: get_chat_state", error); return; }
    poll = data?.poll || null;
    yourVote = data?.your_vote ?? null;
    renderPoll();
  }

  // ---- Voting ---------------------------------------------------------------
  async function castVote(choice) {
    if (!getUser()) { signIn(); return; }
    if (!poll || !poll.is_open || voting) return;
    voting = true;
    const prev = yourVote;
    yourVote = choice; // optimistic
    renderPoll();
    try {
      const { data, error } = await supabase.rpc("cast_chat_vote", { p_choice: choice });
      if (error) throw error;
      if (data) {
        poll = { ...poll, yes_count: data.yes_count, no_count: data.no_count, is_open: data.is_open };
        yourVote = data.your_vote;
      }
    } catch (e) {
      console.error("chat: cast_chat_vote", e);
      yourVote = prev; // revert the optimistic flip
      if (/no_open_poll/.test(e?.message || "")) { poll = poll && { ...poll, is_open: false }; }
    } finally {
      voting = false;
      renderPoll();
    }
  }
  yesBtn?.addEventListener("click", () => castVote(true));
  noBtn?.addEventListener("click", () => castVote(false));

  // ---- Host actions (via f10admin) ------------------------------------------
  async function invokeAdmin(body) {
    const { data, error } = await supabase.functions.invoke("f10admin", { body });
    if (error) throw new Error(error.message || "request failed");
    if (!data?.ok) throw new Error(data?.error || "request failed");
    return data;
  }

  async function sendMessage(text) {
    const btn = document.getElementById("chatSendBtn");
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    try {
      await invokeAdmin({ action: "chat_send", text });
      if (input) input.value = "";
      // The realtime INSERT paints the message; nothing else to do here.
    } catch (e) {
      console.error("chat: send", e);
      flashAdminHint(e.message || "Could not send.");
    } finally {
      if (input) { input.disabled = false; input.focus(); }
      if (btn) btn.disabled = false;
    }
  }
  composer?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = (input?.value || "").trim();
    if (text) sendMessage(text);
  });

  async function openPoll() {
    const question = (pollInput?.value || "").trim();
    setAdminBusy(true);
    try {
      const data = await invokeAdmin({ action: "chat_poll", op: "open", question });
      if (data.poll) adoptPollRow(data.poll, true); // reflect immediately
      flashAdminHint("Vote started.");
    } catch (e) {
      console.error("chat: open poll", e);
      flashAdminHint(e.message || "Could not start the vote.");
    } finally {
      setAdminBusy(false);
    }
  }
  async function closePoll() {
    setAdminBusy(true);
    try {
      const data = await invokeAdmin({ action: "chat_poll", op: "close" });
      if (data.poll) { poll = data.poll; renderPoll(); }
      flashAdminHint("Vote closed.");
    } catch (e) {
      console.error("chat: close poll", e);
      flashAdminHint(e.message || "Could not close the vote.");
    } finally {
      setAdminBusy(false);
    }
  }
  openBtn?.addEventListener("click", openPoll);
  closeBtn?.addEventListener("click", closePoll);

  function setAdminBusy(b) {
    if (openBtn) openBtn.disabled = b;
    if (closeBtn) closeBtn.disabled = b;
  }
  let hintTimer = null;
  function flashAdminHint(msg) {
    if (!adminHint) return;
    adminHint.textContent = msg;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (adminHint) adminHint.textContent = ""; }, 4000);
  }

  // ---- Auth-driven UI (composer + host controls) ----------------------------
  function applyAuthUi() {
    composer?.classList.toggle("hidden", !isAdmin);
    readonlyEl?.classList.toggle("hidden", isAdmin);
    renderAdminControls();
  }

  // Called by main.js on every session change. Reloads the caller's own vote,
  // then probes whether they're the host (f10admin returns 403 for everyone
  // else) and reveals the host controls accordingly.
  async function refreshAuth() {
    const user = getUser();
    if (!user) {
      isAdmin = false;
      yourVote = null;
      applyAuthUi();
      renderPoll();
      return;
    }
    await loadPollState(); // picks up this user's existing vote
    let admin = false;
    try {
      const { data, error } = await supabase.functions.invoke("f10admin", { body: { action: "chat_admin" } });
      if (!error && data?.ok && data.is_admin) admin = true;
    } catch { admin = false; } // non-admins get 403 — expected
    isAdmin = admin;
    applyAuthUi();
  }

  // ---- Realtime -------------------------------------------------------------
  function subscribe() {
    supabase
      .channel("home-chat")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => appendMessage(payload.new, true))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" },
        (payload) => removeMessage(payload.old?.id))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_poll" },
        (payload) => adoptPollRow(payload.new, true))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_poll" },
        (payload) => adoptPollRow(payload.new, false))
      .subscribe((status) => {
        // On (re)connect, reconcile in case events were missed while away.
        if (status === "SUBSCRIBED") { loadMessages().catch(() => {}); loadPollState().catch(() => {}); }
      });
  }

  // Catch up after the tab was backgrounded (realtime may have dropped events).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadPollState().catch(() => {});
  });

  // ---- Boot -----------------------------------------------------------------
  applyCollapsed();
  renderBadge();
  applyAuthUi();
  loadMessages().catch((e) => console.error(e));
  loadPollState().catch((e) => console.error(e));
  subscribe();

  return {
    refreshAuth,
    setOnline(count) {
      if (onlineEl && count != null) onlineEl.textContent = String(count);
    },
  };
}
