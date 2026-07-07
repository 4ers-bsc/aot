// ============================================================================
// Internal admin / operations dashboard.
//
// A self-contained overlay that surfaces every operational queue where a real
// user can get stuck — disputed matches, integrity flags, pending / stuck
// payouts, consumed deposits, stale waiting rooms, banned users and manual
// review notes — and lets the operator resolve them, instead of hand-editing
// Supabase tables.
//
// All data and every action go through the admin-gated `f10admin` edge function
// (service role, ADMIN_USER_IDS allowlist). The browser never gets elevated
// access: a non-admin who opens #admin just sees "Not authorized".
//
// Entry points (kept low-key — this is an internal tool):
//   • navigate to  <app>/#admin
//   • press  Ctrl/Cmd + Shift + A
// ============================================================================

import { escapeHtml } from "./utils.js";

const TABS = [
  ["disputed",          "Disputed"],
  ["integrity",         "Integrity flags"],
  ["payout_pending",    "Payout pending"],
  ["payout_failed",     "Payout failed"],
  ["payouts",           "All payouts"],
  ["consumed_deposits", "Consumed deposits"],
  ["stale_waiting",     "Stale rooms"],
  ["banned",            "Banned users"],
  ["notes",             "Review notes"],
];
// Tabs whose badge count is informational (not an action queue) — no red badge.
const INFO_TABS = new Set(["payouts", "consumed_deposits", "notes"]);

const fmtTokens = (raw) => {
  const n = Number(raw || 0) / 1e6; // 6-decimal mint
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} $FIGHT10`;
};
const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
};
const ago = (iso) => {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const shortId = (id) => (id ? `${String(id).slice(0, 8)}…` : "—");
const player = (p) => escapeHtml(p?.display_name || p?.name || shortId(p?.user_id));

// Solscan explorer links so the operator can review a signature / account on-chain.
const solscanTx = (sig) => `https://solscan.io/tx/${encodeURIComponent(sig)}`;
const solscanAddr = (addr) => `https://solscan.io/account/${encodeURIComponent(String(addr).split(":").pop())}`;
const txLink = (sig, label) =>
  sig ? `<a class="admin-link" href="${solscanTx(sig)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(sig)}">${escapeHtml(label || shortId(sig))} ↗</a>` : "—";
const addrLink = (addr, label) =>
  addr ? `<a class="admin-link" href="${solscanAddr(addr)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(addr)}">${escapeHtml(label || shortId(addr))} ↗</a>` : "—";

export function initAdmin(supabase) {
  let root = null;
  let data = null;
  let activeTab = "disputed";
  let loading = false;
  let errorMsg = "";
  let query = ""; // per-tab free-text filter (searches every column)

  // ---- DOM shell (built once, on first open) --------------------------------
  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "adminOverlay";
    root.className = "admin-overlay hidden";
    root.innerHTML = `
      <div class="admin-panel" role="dialog" aria-label="Operations dashboard">
        <header class="admin-head">
          <div class="admin-title">OPS<span>DASHBOARD</span></div>
          <div class="admin-head-actions">
            <button class="admin-btn admin-refresh" type="button" data-admin="refresh">Refresh</button>
            <button class="admin-btn admin-x" type="button" data-admin="close" aria-label="Close">✕</button>
          </div>
        </header>
        <nav class="admin-tabs" id="adminTabs"></nav>
        <div class="admin-searchbar">
          <input id="adminSearch" class="admin-search-input" type="search" placeholder="Search this tab — any column…" autocomplete="off" />
          <span class="admin-search-count" id="adminSearchCount"></span>
        </div>
        <div class="admin-body" id="adminBody"></div>
      </div>
      <div class="admin-modal-host" id="adminModalHost"></div>`;
    document.body.appendChild(root);

    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    root.querySelector('[data-admin="close"]').addEventListener("click", close);
    root.querySelector('[data-admin="refresh"]').addEventListener("click", () => load());
    root.querySelector("#adminTabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t && t.dataset.tab !== activeTab) {
        activeTab = t.dataset.tab;
        query = "";
        const s = root.querySelector("#adminSearch");
        if (s) s.value = "";
        render();
      }
    });
    // Live free-text filter — re-renders only the body so the input keeps focus.
    root.querySelector("#adminSearch").addEventListener("input", (e) => {
      query = e.target.value.trim().toLowerCase();
      renderBody();
    });
    root.querySelector("#adminBody").addEventListener("click", onAction);
    return root;
  }

  // ---- Open / close ---------------------------------------------------------
  function open() {
    ensureRoot();
    root.classList.remove("hidden");
    document.body.classList.add("admin-open");
    if (!data) load();
    else render();
  }
  function close() {
    if (!root) return;
    root.classList.add("hidden");
    document.body.classList.remove("admin-open");
    if (location.hash === "#admin") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
  const isOpen = () => root && !root.classList.contains("hidden");

  // ---- Data -----------------------------------------------------------------
  async function load() {
    loading = true; errorMsg = ""; render();
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action: "overview" },
      });
      if (error) throw new Error(error.message || "request failed");
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      data = resp;
    } catch (err) {
      errorMsg = String(err?.message || err);
      data = null;
    } finally {
      loading = false;
      render();
    }
  }

  // Non-blocking toast (window.alert can be suppressed the same way prompt is).
  function toast(msg, isError = false) {
    const host = root?.querySelector("#adminModalHost");
    if (!host) return;
    const el = document.createElement("div");
    el.className = `admin-toast${isError ? " admin-toast-err" : ""}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3000);
  }

  async function act(action, params) {
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action, ...params },
      });
      // A non-2xx (e.g. 403) surfaces as `error` with the reason in the body.
      if (error) {
        let reason = error.message || "request failed";
        try { const b = await error.context?.json?.(); if (b?.error) reason = b.error; } catch (_) {}
        throw new Error(reason);
      }
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      toast("Done ✓");
      await load();
    } catch (err) {
      toast(`Action failed: ${err?.message || err}`, true);
    }
  }

  // ---- In-overlay prompt / confirm ------------------------------------------
  // Replaces window.prompt/confirm (which some browsers block or ignore inside
  // an overlay — the reason "Add note" appeared dead). Rendered inside the
  // overlay so it always shows and matches the tool's styling.
  function modal({ label, initial = "", placeholder = "", multiline = false, okText = "Save", showInput = true }) {
    const host = root.querySelector("#adminModalHost");
    return new Promise((resolve) => {
      const field = multiline
        ? `<textarea class="admin-input" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(initial)}</textarea>`
        : `<input class="admin-input" type="text" value="${escapeHtml(initial)}" placeholder="${escapeHtml(placeholder)}" />`;
      host.innerHTML = `
        <div class="admin-modal-back">
          <div class="admin-modal" role="dialog" aria-modal="true">
            <div class="admin-modal-label">${escapeHtml(label)}</div>
            ${showInput ? field : ""}
            <div class="admin-modal-actions">
              <button class="admin-btn admin-btn-sm" data-m="cancel">Cancel</button>
              <button class="admin-btn admin-btn-sm admin-primary" data-m="ok">${escapeHtml(okText)}</button>
            </div>
          </div>
        </div>`;
      const inputEl = host.querySelector(".admin-input");
      const done = (val) => { host.innerHTML = ""; resolve(val); };
      host.querySelector('[data-m="cancel"]').onclick = () => done(null);
      host.querySelector('[data-m="ok"]').onclick = () => done(showInput ? (inputEl?.value ?? "") : true);
      host.querySelector(".admin-modal-back").onclick = (e) => { if (e.target.classList.contains("admin-modal-back")) done(null); };
      if (inputEl) {
        inputEl.focus();
        inputEl.select?.();
        if (!multiline) inputEl.onkeydown = (e) => { if (e.key === "Enter") host.querySelector('[data-m="ok"]').click(); };
      }
    });
  }
  const askText = (label, initial = "", opts = {}) =>
    modal({ label, initial, multiline: true, ...opts }).then((v) => (v == null ? null : String(v).trim()));
  const askConfirm = (label, okText = "Confirm") =>
    modal({ label, showInput: false, okText }).then((v) => v === true);

  // ---- Row action handler ---------------------------------------------------
  async function onAction(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act: a, match, user } = btn.dataset;

    if (a === "note") {
      const note = await askText("Review note", "", { placeholder: "What did you check / decide?" });
      if (note) {
        act("add_note", {
          subject_type: btn.dataset.subjectType || "general",
          subject_id: btn.dataset.subjectId || null,
          note,
        });
      }
      return;
    }
    if (a === "resolve_dispute") {
      if (await askConfirm(
        `Award this match to ${btn.dataset.name || shortId(user)} and mark it finished? The winner will then be able to claim their payout.`,
        "Award win")) {
        act("resolve_dispute", { match_id: match, winner_user_id: user });
      }
      return;
    }
    if (a === "void_match") {
      if (await askConfirm("Void this match with no winner? The pot stays in escrow.", "Void match")) {
        act("void_match", { match_id: match });
      }
      return;
    }
    if (a === "close_waiting_room") {
      if (await askConfirm("Close this stale waiting room?", "Close room")) {
        act("close_waiting_room", { match_id: match });
      }
      return;
    }
    if (a === "pay_winner") {
      if (await askConfirm(
        "Pay the winner now from the escrow wallet? This verifies every deposit on-chain, then sends 90% of the pot and records the transaction. Only proceed if no payout has already landed.",
        "Pay winner")) {
        act("admin_pay_winner", { match_id: match });
      }
      return;
    }
    if (a === "release_payout") {
      if (await askConfirm(
        "Release this stuck payout slot so the winner can retry? Only do this if no on-chain payout has landed.",
        "Release slot")) {
        act("release_payout", { match_id: match });
      }
      return;
    }
    if (a === "mark_payout_resolved") {
      const tx = await askText("Paste the on-chain payout tx signature you sent manually", "", { multiline: false });
      if (tx) act("mark_payout_resolved", { match_id: match, payout_tx: tx });
      return;
    }
    if (a === "ban") {
      const reason = await askText("Ban reason", "manual_admin_ban", { multiline: false });
      if (reason !== null) act("ban_user", { user_id: user, reason: reason || "manual_admin_ban" });
      return;
    }
    if (a === "unban") {
      if (await askConfirm("Unban this user?", "Unban")) act("unban_user", { user_id: user });
      return;
    }
    if (a === "del_note") {
      if (await askConfirm("Delete this review note?", "Delete")) act("delete_note", { id: Number(btn.dataset.id) });
      return;
    }
    if (a === "clear_release_notes") {
      const ids = (data?.notes || []).filter((n) => n.action === "release_payout").map((n) => n.id);
      if (ids.length && await askConfirm(`Delete ${ids.length} "release-slot" note${ids.length > 1 ? "s" : ""}? These were the no-op notes from releasing already-unclaimed payouts.`, "Delete all")) {
        act("delete_note", { ids });
      }
      return;
    }
  }

  // ---- Render ---------------------------------------------------------------
  function render() {
    if (!root) return;
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    const counts = data?.counts || {};
    root.querySelector("#adminTabs").innerHTML = TABS.map(([key, label]) => {
      const c = counts[key] ?? 0;
      const attn = c > 0 && !INFO_TABS.has(key);
      return `<button class="admin-tab${key === activeTab ? " is-active" : ""}" data-tab="${key}">
        ${escapeHtml(label)}<span class="admin-count${attn ? " attn" : ""}">${c}</span>
      </button>`;
    }).join("");
  }

  // A row matches when the query appears anywhere in its serialized data — so
  // every column (ids, names, tx signatures, amounts, reasons…) is searchable.
  function rowMatches(row) {
    if (!query) return true;
    try { return JSON.stringify(row).toLowerCase().includes(query); }
    catch { return true; }
  }

  function renderBody() {
    const bodyEl = root.querySelector("#adminBody");
    const countEl = root.querySelector("#adminSearchCount");
    if (!bodyEl) return;
    if (countEl) countEl.textContent = "";
    if (loading && !data) { bodyEl.innerHTML = `<div class="admin-msg">Loading…</div>`; return; }
    if (errorMsg)         { bodyEl.innerHTML = `<div class="admin-msg admin-err">${escapeHtml(errorMsg)}</div>`; return; }
    if (!data)            { bodyEl.innerHTML = `<div class="admin-msg">No data.</div>`; return; }
    if (countEl) {
      const total = (data[activeTab] || []).length;
      const shown = (data[activeTab] || []).filter(rowMatches).length;
      countEl.textContent = query ? `${shown} of ${total}` : `${total} row${total === 1 ? "" : "s"}`;
    }
    bodyEl.innerHTML = renderTab(activeTab);
  }

  function renderTab(tab) {
    const rows = (data[tab] || []).filter(rowMatches);
    const meta = data.thresholds || {};
    const emptyMsg = query
      ? `<div class="admin-msg">No rows match “${escapeHtml(query)}”.</div>`
      : `<div class="admin-msg">Nothing here — queue is clear. ✓</div>`;
    // Notes tab keeps its toolbar (add / bulk-clear) even when empty.
    if (tab === "notes") {
      const noiseCount = (data.notes || []).filter((n) => n.action === "release_payout").length;
      const bar = `<div class="admin-notebar">
        <button class="admin-btn admin-btn-sm admin-primary" data-act="note" data-subject-type="general">＋ Add note</button>
        ${noiseCount ? `<button class="admin-btn admin-btn-sm admin-danger" data-act="clear_release_notes">Clear ${noiseCount} release-slot note${noiseCount > 1 ? "s" : ""}</button>` : ""}
      </div>`;
      const table = rows.length
        ? `<table class="admin-table">${thead(["When", "Subject", "Note", "By", ""])}${rows.map(noteRow).join("")}</tbody></table>`
        : `<div class="admin-msg">${query ? `No notes match “${escapeHtml(query)}”.` : "No notes yet."}</div>`;
      return bar + table;
    }
    if (rows.length === 0) return emptyMsg;
    switch (tab) {
      case "disputed":          return rows.map(disputedCard).join("");
      case "integrity":         return `<table class="admin-table">${thead(["When", "Player", "Kind", "Detail", "Match"])}${rows.map(integrityRow).join("")}</tbody></table>`;
      case "payout_pending":    return `<p class="admin-note">Finished matches with a winner that have not paid out yet.</p>` + rows.map((r) => payoutCard(r, false)).join("");
      case "payout_failed":     return `<p class="admin-note">Payout reservations stuck as 'pending' for over ${meta.payout_stuck_minutes ?? 15} min — likely a payout that half-completed. Verify on-chain before acting.</p>` + rows.map((r) => payoutCard(r, true)).join("");
      case "payouts":           return `<p class="admin-note">Completed payouts (from the payouts ledger). Every column is searchable above.</p><table class="admin-table">${thead(["When", "Match", "Winner", "Amount", "Players", "Tx"])}${rows.map(payoutRow).join("")}</tbody></table>`;
      case "consumed_deposits": return `<table class="admin-table">${thead(["When", "Player", "Deposit tx", "Match"])}${rows.map(consumedRow).join("")}</tbody></table>`;
      case "stale_waiting":     return rows.map(waitingCard).join("");
      case "banned":            return `<table class="admin-table">${thead(["When", "Wallet", "Reason", "Action"])}${rows.map(bannedRow).join("")}</tbody></table>`;
      default:                  return "";
    }
  }

  function payoutRow(r) {
    const amt = r.amount != null
      ? `${r.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} $FIGHT10` : "—";
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td class="admin-nowrap">#${r.match_no ?? shortId(r.match_id)}</td>
      <td>${escapeHtml(r.winner_name || shortId(r.winner_user_id))}</td>
      <td class="admin-nowrap">${amt}</td>
      <td class="admin-nowrap">${r.num_players ?? "—"}</td>
      <td class="admin-mono">${txLink(r.payout_tx)}</td>
    </tr>`;
  }

  const thead = (cols) => `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>`;

  // Notes attached to a given subject (match / payout / user id). The overview
  // already returns the recent notes, so we just group them client-side and show
  // them on the relevant card — that's why a note added on the Payout tab now
  // appears right there instead of only under Review notes.
  function notesFor(subjectId) {
    if (!subjectId || !data?.notes) return [];
    return data.notes.filter((n) => n.subject_id === subjectId);
  }
  function notesBlock(subjectId) {
    const ns = notesFor(subjectId);
    if (!ns.length) return "";
    return `<div class="admin-card-notes">` + ns.map((n) =>
      `<div class="admin-cnote"><span class="admin-dim">${ago(n.created_at)} · ${escapeHtml(n.author_name || shortId(n.author_id))}${n.action && n.action !== "note" ? ` · ${escapeHtml(n.action)}` : ""}</span> ${escapeHtml(n.note)}<button class="admin-note-del" data-act="del_note" data-id="${n.id}" title="Delete note">✕</button></div>`
    ).join("") + `</div>`;
  }

  function disputedCard(m) {
    const reason = m.shadow_meta?.reason ? escapeHtml(m.shadow_meta.reason) : "—";
    const forfeited = new Set(m.forfeited_user_ids || []);
    const players = (m.players || []).map((p) => {
      const flags = [];
      if (forfeited.has(p.user_id)) flags.push(`<span class="admin-flag">forfeited</span>`);
      const award = forfeited.has(p.user_id)
        ? ""
        : `<button class="admin-btn admin-btn-sm" data-act="resolve_dispute" data-match="${m.id}" data-user="${p.user_id}" data-name="${escapeHtml(p.display_name || "")}">Award win</button>`;
      return `<div class="admin-prow">
        <span class="admin-seat">#${p.seat}</span>
        <span class="admin-pname">${player(p)}</span>
        <span class="admin-phP">HP ${p.final_hp ?? "—"}</span>
        ${flags.join("")}
        ${award}
      </div>`;
    }).join("");
    return `<div class="admin-card">
      <div class="admin-card-head">
        <b>Match #${m.match_no ?? shortId(m.id)}</b>
        <span class="admin-dim">${m.max_players}-player · pot ${fmtTokens(m.pot_tokens)} · reason: ${reason}</span>
        <span class="admin-dim admin-right">${fmtTime(m.ended_at)} (${ago(m.ended_at)})</span>
      </div>
      <div class="admin-players">${players || '<span class="admin-dim">no players</span>'}</div>
      <div class="admin-card-actions">
        <button class="admin-btn admin-btn-sm admin-danger" data-act="void_match" data-match="${m.id}">Void (no winner)</button>
        <button class="admin-btn admin-btn-sm" data-act="note" data-subject-type="match" data-subject-id="${m.id}">Add note</button>
      </div>
      ${notesBlock(m.id)}
    </div>`;
  }

  function payoutCard(m, failed) {
    const stuck = m.stuck_minutes != null ? `stuck ${m.stuck_minutes}m` : "";
    const status = m.payout_tx === "pending"
      ? `<span class="admin-flag ${failed ? "admin-flag-red" : ""}">pending ${stuck}</span>`
      : `<span class="admin-flag">unclaimed</span>`;
    return `<div class="admin-card">
      <div class="admin-card-head">
        <b>Match #${m.match_no ?? shortId(m.id)}</b>
        <span class="admin-dim">winner ${escapeHtml(m.winner_name || shortId(m.winner_user_id))} · pot ${fmtTokens(m.pot_tokens)}</span>
        ${status}
        <span class="admin-dim admin-right">${fmtTime(m.ended_at)} (${ago(m.ended_at)})</span>
      </div>
      <div class="admin-card-actions">
        <button class="admin-btn admin-btn-sm admin-primary" data-act="pay_winner" data-match="${m.id}">Pay winner now</button>
        <button class="admin-btn admin-btn-sm" data-act="release_payout" data-match="${m.id}">Release slot (retry)</button>
        <button class="admin-btn admin-btn-sm" data-act="mark_payout_resolved" data-match="${m.id}">Mark paid (tx)</button>
        <button class="admin-btn admin-btn-sm" data-act="note" data-subject-type="payout" data-subject-id="${m.id}">Add note</button>
      </div>
      ${notesBlock(m.id)}
    </div>`;
  }

  function waitingCard(m) {
    const players = (m.players || []).map((p) => `#${p.seat} ${player(p)}`).join(", ");
    return `<div class="admin-card">
      <div class="admin-card-head">
        <b>Match #${m.match_no ?? shortId(m.id)}</b>
        <span class="admin-dim">${m.seats_filled}/${m.max_players} seats · open ${m.open_minutes}m · pot ${fmtTokens(m.pot_tokens)}</span>
        <span class="admin-dim admin-right">${fmtTime(m.created_at)}</span>
      </div>
      <div class="admin-players"><span class="admin-dim">${players || "empty"}</span></div>
      <div class="admin-card-actions">
        <button class="admin-btn admin-btn-sm admin-danger" data-act="close_waiting_room" data-match="${m.id}">Close room</button>
        <button class="admin-btn admin-btn-sm" data-act="note" data-subject-type="waiting" data-subject-id="${m.id}">Add note</button>
      </div>
      ${notesBlock(m.id)}
    </div>`;
  }

  function integrityRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td>${escapeHtml(r.user_name || shortId(r.user_id))}</td>
      <td><span class="admin-flag">${escapeHtml(r.kind || "—")}</span></td>
      <td class="admin-detail">${escapeHtml(r.detail ? JSON.stringify(r.detail) : "—")}</td>
      <td class="admin-nowrap">
        ${shortId(r.match_id)}
        ${r.user_id ? `<button class="admin-btn admin-btn-xs" data-act="ban" data-user="${r.user_id}">Ban</button>` : ""}
      </td>
    </tr>`;
  }

  function consumedRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.consumed_at)}">${ago(r.consumed_at)}</td>
      <td>${escapeHtml(r.user_name || shortId(r.user_id))}</td>
      <td class="admin-mono">${txLink(r.deposit_tx)}</td>
      <td class="admin-nowrap">${shortId(r.match_id)}</td>
    </tr>`;
  }

  function bannedRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td class="admin-mono">${r.wallet ? addrLink(r.wallet) : "—"}</td>
      <td>${escapeHtml(r.reason || "—")}</td>
      <td class="admin-nowrap">
        <button class="admin-btn admin-btn-xs" data-act="unban" data-user="${r.user_id}">Unban</button>
        <button class="admin-btn admin-btn-xs" data-act="note" data-subject-type="user" data-subject-id="${r.user_id}">Note</button>
      </td>
    </tr>`;
  }

  function noteRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td class="admin-nowrap">${escapeHtml(r.subject_type)} ${r.subject_id ? shortId(r.subject_id) : ""}${r.action ? ` <span class="admin-dim">(${escapeHtml(r.action)})</span>` : ""}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(r.author_name || shortId(r.author_id))}</td>
      <td class="admin-nowrap"><button class="admin-btn admin-btn-xs" data-act="del_note" data-id="${r.id}">Delete</button></td>
    </tr>`;
  }

  // ---- Wiring: hash route + keyboard shortcut -------------------------------
  const checkHash = () => { if (location.hash === "#admin") open(); };
  window.addEventListener("hashchange", checkHash);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      isOpen() ? close() : open();
    }
    if (e.key === "Escape" && isOpen()) close();
  });
  checkHash();
}
