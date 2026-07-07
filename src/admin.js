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
  ["consumed_deposits", "Consumed deposits"],
  ["stale_waiting",     "Stale rooms"],
  ["banned",            "Banned users"],
  ["notes",             "Review notes"],
];

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

export function initAdmin(supabase) {
  let root = null;
  let data = null;
  let activeTab = "disputed";
  let loading = false;
  let errorMsg = "";

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
        <div class="admin-body" id="adminBody"></div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    root.querySelector('[data-admin="close"]').addEventListener("click", close);
    root.querySelector('[data-admin="refresh"]').addEventListener("click", () => load());
    root.querySelector("#adminTabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) { activeTab = t.dataset.tab; render(); }
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

  async function act(action, params, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action, ...params },
      });
      if (error) throw new Error(error.message || "request failed");
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      await load();
    } catch (err) {
      window.alert(`Action failed: ${err?.message || err}`);
    }
  }

  // ---- Row action handler ---------------------------------------------------
  function onAction(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act: a, match, user } = btn.dataset;

    if (a === "note") {
      const note = window.prompt("Review note:");
      if (note && note.trim()) {
        act("add_note", {
          subject_type: btn.dataset.subjectType || "general",
          subject_id: btn.dataset.subjectId || null,
          note: note.trim(),
        });
      }
      return;
    }
    if (a === "resolve_dispute") {
      act("resolve_dispute", { match_id: match, winner_user_id: user },
        `Award this match to ${btn.dataset.name || shortId(user)} and mark it finished? The winner will then be able to claim their payout.`);
      return;
    }
    if (a === "void_match") {
      act("void_match", { match_id: match }, "Void this match with no winner? The pot stays in escrow.");
      return;
    }
    if (a === "close_waiting_room") {
      act("close_waiting_room", { match_id: match }, "Close this stale waiting room?");
      return;
    }
    if (a === "release_payout") {
      act("release_payout", { match_id: match },
        "Release this stuck payout slot so the winner can retry? Only do this if no on-chain payout has landed.");
      return;
    }
    if (a === "mark_payout_resolved") {
      const tx = window.prompt("Paste the on-chain payout tx signature you sent manually:");
      if (tx && tx.trim()) act("mark_payout_resolved", { match_id: match, payout_tx: tx.trim() });
      return;
    }
    if (a === "ban") {
      const reason = window.prompt("Ban reason:", "manual_admin_ban");
      if (reason !== null) act("ban_user", { user_id: user, reason: reason.trim() || "manual_admin_ban" });
      return;
    }
    if (a === "unban") {
      act("unban_user", { user_id: user }, "Unban this user?");
      return;
    }
  }

  // ---- Render ---------------------------------------------------------------
  function render() {
    if (!root) return;
    const tabsEl = root.querySelector("#adminTabs");
    const bodyEl = root.querySelector("#adminBody");
    const counts = data?.counts || {};

    tabsEl.innerHTML = TABS.map(([key, label]) => {
      const c = counts[key] ?? 0;
      const attn = c > 0 && key !== "consumed_deposits" && key !== "notes";
      return `<button class="admin-tab${key === activeTab ? " is-active" : ""}" data-tab="${key}">
        ${escapeHtml(label)}<span class="admin-count${attn ? " attn" : ""}">${c}</span>
      </button>`;
    }).join("");

    if (loading && !data) { bodyEl.innerHTML = `<div class="admin-msg">Loading…</div>`; return; }
    if (errorMsg)         { bodyEl.innerHTML = `<div class="admin-msg admin-err">${escapeHtml(errorMsg)}</div>`; return; }
    if (!data)            { bodyEl.innerHTML = `<div class="admin-msg">No data.</div>`; return; }

    bodyEl.innerHTML = renderTab(activeTab);
  }

  function renderTab(tab) {
    const rows = data[tab] || [];
    if (rows.length === 0) return `<div class="admin-msg">Nothing here — queue is clear. ✓</div>`;
    const meta = data.thresholds || {};
    switch (tab) {
      case "disputed":          return rows.map(disputedCard).join("");
      case "integrity":         return `<table class="admin-table">${thead(["When", "Player", "Kind", "Detail", "Match"])}${rows.map(integrityRow).join("")}</tbody></table>`;
      case "payout_pending":    return `<p class="admin-note">Finished matches with a winner that have not paid out yet.</p>` + rows.map((r) => payoutCard(r, false)).join("");
      case "payout_failed":     return `<p class="admin-note">Payout reservations stuck as 'pending' for over ${meta.payout_stuck_minutes ?? 15} min — likely a payout that half-completed. Verify on-chain before acting.</p>` + rows.map((r) => payoutCard(r, true)).join("");
      case "consumed_deposits": return `<table class="admin-table">${thead(["When", "Player", "Deposit tx", "Match"])}${rows.map(consumedRow).join("")}</tbody></table>`;
      case "stale_waiting":     return rows.map(waitingCard).join("");
      case "banned":            return `<table class="admin-table">${thead(["When", "Wallet", "Reason", "Action"])}${rows.map(bannedRow).join("")}</tbody></table>`;
      case "notes":             return `<table class="admin-table">${thead(["When", "Subject", "Note", "By"])}${rows.map(noteRow).join("")}</tbody></table>`;
      default:                  return "";
    }
  }

  const thead = (cols) => `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>`;

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
        <button class="admin-btn admin-btn-sm" data-act="release_payout" data-match="${m.id}">Release slot (retry)</button>
        <button class="admin-btn admin-btn-sm" data-act="mark_payout_resolved" data-match="${m.id}">Mark paid (tx)</button>
        <button class="admin-btn admin-btn-sm" data-act="note" data-subject-type="payout" data-subject-id="${m.id}">Add note</button>
      </div>
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
      <td class="admin-mono">${escapeHtml(shortId(r.deposit_tx))}</td>
      <td class="admin-nowrap">${shortId(r.match_id)}</td>
    </tr>`;
  }

  function bannedRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td class="admin-mono">${escapeHtml(r.wallet ? shortId(r.wallet) : "—")}</td>
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
