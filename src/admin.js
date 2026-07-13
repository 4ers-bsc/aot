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
import { txExplorerUrl, addrExplorerUrl } from "./network.js";

const TABS = [
  ["disputed",          "Disputed"],
  ["integrity",         "Integrity flags"],
  ["payout_pending",    "Payout pending"],
  ["payout_failed",     "Payout failed"],
  ["payouts",           "All payouts"],
  ["cashflow",          "Cash flow"],
  ["consumed_deposits", "Consumed deposits"],
  ["stale_waiting",     "Stale rooms"],
  ["banned",            "Banned users"],
  ["notes",             "Review notes"],
  ["db",                "Database"],
  ["functions",         "Edge functions"],
  ["constants",         "Constants"],
];
// Tabs whose badge count is informational (not an action queue) — no red badge.
const INFO_TABS = new Set(["payouts", "consumed_deposits", "notes"]);
// Tabs that render their own body (own filters / layout) instead of the shared
// free-text search + row table. Each loads its data lazily on first open and
// keeps its own loading / error state.
const CUSTOM_TABS = new Set(["cashflow", "db", "functions", "constants"]);

// Raw on-chain units → whole $FIGHT10. ERC-20 default is 18 decimals
// (override with VITE_FIGHT10_DECIMALS); pass decimals 0 for values already
// stored in whole tokens (matches.pot_tokens).
const TOKEN_DECIMALS = Number(import.meta.env?.VITE_FIGHT10_DECIMALS ?? 18);
const fmtTokens = (raw, decimals = TOKEN_DECIMALS) => {
  const n = Number(raw || 0) / 10 ** decimals;
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
const fmtBytes = (b) => {
  const n = Number(b || 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
};
const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtDuration = (secs) => {
  const s = Number(secs || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
};
const player = (p) => escapeHtml(p?.display_name || p?.name || shortId(p?.user_id));

// Blockscout explorer links (network-aware via network.js) so the operator
// can review a transaction / address on-chain.
const txLink = (sig, label) =>
  sig ? `<a class="admin-link" href="${txExplorerUrl(sig)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(sig)}">${escapeHtml(label || shortId(sig))} ↗</a>` : "—";
const addrLink = (addr, label) =>
  addr ? `<a class="admin-link" href="${addrExplorerUrl(addr)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(addr)}">${escapeHtml(label || shortId(addr))} ↗</a>` : "—";

export function initAdmin(supabase) {
  let root = null;
  let data = null;
  let activeTab = "disputed";
  let loading = false;
  let errorMsg = "";
  let query = ""; // per-tab free-text filter (searches every column)
  let integrityKind = ""; // Integrity tab: narrow to a single signal kind ("" = all)

  // Cash-flow tab keeps its own state: filters are applied server-side (so the
  // totals span every row, not just the first page), fetched on demand.
  let cashflow = null;
  let cashflowLoading = false;
  let cashflowError = "";
  let cashflowFilters = { from: "", to: "", wallet: "" };

  // Monitoring / config tabs — each fetched on demand, own loading + error state.
  let dbstats = null,  dbstatsLoading = false,  dbstatsError = "";
  let fnhealth = null, fnhealthLoading = false, fnhealthError = "";
  let config = null,   configLoading = false,   configError = "";

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
            <span class="admin-refreshed" id="adminRefreshed" title="Time of the data currently shown"></span>
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
    root.querySelector('[data-admin="refresh"]').addEventListener("click", refreshActive);
    root.querySelector("#adminTabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t && t.dataset.tab !== activeTab) {
        activeTab = t.dataset.tab;
        query = "";
        integrityKind = "";
        const s = root.querySelector("#adminSearch");
        if (s) s.value = "";
        render();
        // Custom tabs (cash flow / monitoring / constants) fetch lazily the
        // first time they're opened.
        lazyLoadFor(activeTab);
      }
    });
    // Live free-text filter — re-renders only the body so the input keeps focus.
    root.querySelector("#adminSearch").addEventListener("input", (e) => {
      query = e.target.value.trim().toLowerCase();
      renderBody();
    });
    root.querySelector("#adminBody").addEventListener("click", onAction);
    // Enter inside a cash-flow filter field applies the filters.
    root.querySelector("#adminBody").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.closest("#cfFilters")) {
        e.preventDefault();
        root.querySelector('[data-act="cf_apply"]')?.click();
      }
    });
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

  // Cash-flow tab: fetch totals + rows for the current filters (server-side, so
  // the totals cover every matching row rather than just the first page).
  async function loadCashflow() {
    cashflowLoading = true; cashflowError = "";
    if (activeTab === "cashflow") renderBody();
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action: "cashflow", ...cashflowFilters },
      });
      if (error) throw new Error(error.message || "request failed");
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      cashflow = resp;
    } catch (err) {
      cashflowError = String(err?.message || err);
      cashflow = null;
    } finally {
      cashflowLoading = false;
      if (activeTab === "cashflow") renderBody();
    }
  }

  // Refresh whatever the active tab shows (each source is independent).
  function refreshActive() {
    switch (activeTab) {
      case "cashflow":  return loadCashflow();
      case "db":        return loadDbStats();
      case "functions": return loadFunctions();
      case "constants": return loadConfig();
      default:          return load();
    }
  }
  // Kick off a custom tab's first fetch when it's opened (once).
  function lazyLoadFor(tab) {
    if (tab === "cashflow"  && !cashflow  && !cashflowLoading)  loadCashflow();
    if (tab === "db"        && !dbstats   && !dbstatsLoading)   loadDbStats();
    if (tab === "functions" && !fnhealth  && !fnhealthLoading)  loadFunctions();
    if (tab === "constants" && !config    && !configLoading)    loadConfig();
  }

  // Generic on-demand fetch for a monitoring / config action. Sets the given
  // loading flag, stores the result, and re-renders the body if its tab is open.
  async function fetchInto(action, params, tab, set) {
    set({ loading: true, error: "" });
    if (activeTab === tab) renderBody();
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action, ...(params || {}) },
      });
      if (error) throw new Error(error.message || "request failed");
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      set({ data: resp });
    } catch (err) {
      set({ data: null, error: String(err?.message || err) });
    } finally {
      set({ loading: false });
      if (activeTab === tab) renderBody();
    }
  }
  const loadDbStats = () => fetchInto("db_stats", null, "db", (s) => {
    if ("data" in s)    dbstats = s.data;
    if ("loading" in s) dbstatsLoading = s.loading;
    if ("error" in s)   dbstatsError = s.error;
  });
  const loadFunctions = () => fetchInto("functions_health", null, "functions", (s) => {
    if ("data" in s)    fnhealth = s.data;
    if ("loading" in s) fnhealthLoading = s.loading;
    if ("error" in s)   fnhealthError = s.error;
  });
  const loadConfig = () => fetchInto("get_config", null, "constants", (s) => {
    if ("data" in s)    config = s.data;
    if ("loading" in s) configLoading = s.loading;
    if ("error" in s)   configError = s.error;
  });

  // Save an edited static constant, then reload the constants tab.
  async function saveConfig(params) {
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action: "set_config", ...params },
      });
      if (error) {
        let reason = error.message || "request failed";
        try { const b = await error.context?.json?.(); if (b?.error) reason = b.error; } catch (_) {}
        throw new Error(reason);
      }
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      toast("Saved ✓");
      await loadConfig();
    } catch (err) {
      toast(`Save failed: ${err?.message || err}`, true);
    }
  }

  // Trigger a client-side download of a JS object as a pretty-printed .json file.
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Export one table (or the whole schema when `table` is null) and download it.
  async function dbExport(table) {
    toast(table ? `Exporting ${table}…` : "Building snapshot…");
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action: "db_export", ...(table ? { table } : {}) },
      });
      if (error) throw new Error(error.message || "request failed");
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      if (table) {
        downloadJson(`${table}-${stamp()}.json`,
          { table, generated_at: resp.generated_at, rows: resp.rows });
        toast(`Downloaded ${table} (${(resp.rows || []).length} rows) ✓`);
      } else {
        const tables = resp.tables || {};
        const total = Object.values(tables).reduce((n, r) => n + (r?.length || 0), 0);
        downloadJson(`fight10-snapshot-${stamp()}.json`,
          { generated_at: resp.generated_at, tables });
        toast(`Downloaded snapshot — ${Object.keys(tables).length} tables, ${total} rows ✓`);
      }
    } catch (err) {
      toast(`Export failed: ${err?.message || err}`, true);
    }
  }

  // Wipe one table (or every table when `table` is null). `confirm` is the typed
  // phrase the backend re-checks before truncating.
  async function dbWipe(table, confirm) {
    try {
      const { data: resp, error } = await supabase.functions.invoke("f10admin", {
        body: { action: "db_wipe", confirm, ...(table ? { table } : {}) },
      });
      if (error) {
        let reason = error.message || "request failed";
        try { const b = await error.context?.json?.(); if (b?.error) reason = b.error; } catch (_) {}
        throw new Error(reason);
      }
      if (!resp?.ok) throw new Error(resp?.error || "request failed");
      toast(table
        ? `Wiped ${table} (${resp.rows_removed} rows removed) ✓`
        : `Wiped ${resp.tables?.length ?? 0} tables (${resp.rows_removed} rows removed) ✓`);
      await loadDbStats();
    } catch (err) {
      toast(`Wipe failed: ${err?.message || err}`, true);
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
  // Destructive-action guard: the operator must type `expected` verbatim.
  const askExact = (label, expected, okText = "Confirm", placeholder = "") =>
    modal({ label, placeholder, okText }).then((v) => v != null && String(v).trim() === expected);

  // ---- Row action handler ---------------------------------------------------
  async function onAction(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act: a, match, user } = btn.dataset;

    if (a === "cf_apply") {
      cashflowFilters = {
        from:   root.querySelector("#cfFrom")?.value.trim() || "",
        to:     root.querySelector("#cfTo")?.value.trim() || "",
        wallet: root.querySelector("#cfWallet")?.value.trim() || "",
      };
      loadCashflow();
      return;
    }
    if (a === "cf_clear") {
      cashflowFilters = { from: "", to: "", wallet: "" };
      loadCashflow();
      return;
    }
    if (a === "integrity_kind") {
      integrityKind = btn.dataset.kind || "";
      renderBody();
      return;
    }
    if (a === "db_download") {
      dbExport(btn.dataset.table);
      return;
    }
    if (a === "db_download_all") {
      dbExport(null);
      return;
    }
    if (a === "db_wipe") {
      const t = btn.dataset.table;
      const n = Number(btn.dataset.rows || 0);
      if (await askExact(
        `Permanently delete every row in “${t}”${n ? ` (~${fmtInt(n)} rows)` : ""}? This TRUNCATEs the table (CASCADE — rows referencing it go too) and cannot be undone. Type the table name to confirm.`,
        t, "Wipe table", t)) {
        dbWipe(t, t);
      }
      return;
    }
    if (a === "db_wipe_all") {
      if (await askExact(
        `⚠ DELETE EVERY ROW IN EVERY TABLE. This empties the entire database (matches, payouts, deposits, profiles, config — everything) and cannot be undone. Download a snapshot first. Type WIPE ALL to confirm.`,
        "WIPE ALL", "Wipe everything", "WIPE ALL")) {
        dbWipe(null, "WIPE ALL");
      }
      return;
    }
    if (a === "cfg_save_pvp") {
      const params = { target: "pvp_config" };
      const cap  = root.querySelector("#cfgPlayerCap")?.value.trim();
      const fee  = root.querySelector("#cfgEntryFee");
      const bps  = root.querySelector("#cfgWinnerShare")?.value.trim();
      if (cap !== "") params.player_cap = cap;
      // Skip the entry fee when it's locked (input disabled) so the guard trigger
      // never sees an unwanted change attempt.
      if (fee && !fee.disabled && fee.value.trim() !== "") params.entry_fee_tokens = fee.value.trim();
      if (bps !== "") params.winner_share_bps = bps;
      saveConfig(params);
      return;
    }
    if (a === "cfg_save_match") {
      const rows = [...root.querySelectorAll("[data-mc-row]")].map((el) => ({
        max_players: Number(el.dataset.mcRow),
        duration_seconds: el.querySelector(".cfg-mc-input")?.value.trim(),
      }));
      saveConfig({ target: "match_config", rows });
      return;
    }
    if (a === "cfg_maint") {
      const value = btn.dataset.value; // 'y' to turn on, 'n' to turn off
      const on = value === "y";
      if (await askConfirm(
        on
          ? "Turn maintenance mode ON? New joins are blocked game-wide (in-flight matches still settle and pay out)."
          : "Turn maintenance mode OFF and resume normal play?",
        on ? "Turn ON" : "Turn OFF")) {
        saveConfig({ target: "maintain", value });
      }
      return;
    }
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
    renderRefreshed();
    renderTabs();
    renderBody();
  }

  // "as of …" indicator so the operator knows how fresh the queues are.
  function renderRefreshed() {
    const el = root.querySelector("#adminRefreshed");
    if (!el) return;
    if (loading)              { el.textContent = "refreshing…"; el.title = ""; return; }
    if (!data?.generated_at)  { el.textContent = ""; el.title = ""; return; }
    el.textContent = `as of ${ago(data.generated_at)}`;
    el.title = fmtTime(data.generated_at);
  }

  // Rows for a tab after every active filter (shared free-text search + any
  // per-tab structured filter) so the on-screen table and the count agree.
  function tabRows(tab) {
    let rows = (data?.[tab] || []).filter(rowMatches);
    if (tab === "integrity" && integrityKind) rows = rows.filter((r) => r.kind === integrityKind);
    return rows;
  }

  function renderTabs() {
    const counts = data?.counts || {};
    root.querySelector("#adminTabs").innerHTML = TABS.map(([key, label]) => {
      // Custom tabs (e.g. cash flow) have no queue count — render without a badge.
      if (CUSTOM_TABS.has(key)) {
        return `<button class="admin-tab${key === activeTab ? " is-active" : ""}" data-tab="${key}">${escapeHtml(label)}</button>`;
      }
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
    // Custom tabs own their body and hide the shared free-text search bar.
    const searchbar = root.querySelector(".admin-searchbar");
    if (searchbar) searchbar.style.display = CUSTOM_TABS.has(activeTab) ? "none" : "";
    if (activeTab === "cashflow")  { bodyEl.innerHTML = renderCashflow(); return; }
    if (activeTab === "db")        { bodyEl.innerHTML = renderDbStats(); return; }
    if (activeTab === "functions") { bodyEl.innerHTML = renderFunctions(); return; }
    if (activeTab === "constants") { bodyEl.innerHTML = renderConstants(); return; }
    if (countEl) countEl.textContent = "";
    if (loading && !data) { bodyEl.innerHTML = `<div class="admin-msg">Loading…</div>`; return; }
    if (errorMsg)         { bodyEl.innerHTML = `<div class="admin-msg admin-err">${escapeHtml(errorMsg)}</div>`; return; }
    if (!data)            { bodyEl.innerHTML = `<div class="admin-msg">No data.</div>`; return; }
    if (countEl) {
      const total = (data[activeTab] || []).length;
      const shown = tabRows(activeTab).length;
      const filtered = query || (activeTab === "integrity" && integrityKind);
      countEl.textContent = filtered ? `${shown} of ${total}` : `${total} row${total === 1 ? "" : "s"}`;
    }
    bodyEl.innerHTML = renderTab(activeTab);
  }

  function renderTab(tab) {
    const rows = tabRows(tab);
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
    // Integrity keeps its per-kind filter chips visible even when the current
    // selection is empty, so the operator can switch kinds without clearing.
    if (tab === "integrity") {
      const searched = (data.integrity || []).filter(rowMatches);
      const kinds = [...new Set(searched.map((r) => r.kind).filter(Boolean))].sort();
      const chip = (key, label, n, active) =>
        `<button class="admin-chip${active ? " is-active" : ""}" data-act="integrity_kind" data-kind="${escapeHtml(key)}">${escapeHtml(label)}<span class="admin-chip-n">${n}</span></button>`;
      const chips = kinds.length > 1
        ? `<div class="admin-chips">${chip("", "All", searched.length, !integrityKind)}${
            kinds.map((k) => chip(k, k, searched.filter((r) => r.kind === k).length, integrityKind === k)).join("")}</div>`
        : "";
      const table = rows.length
        ? `<table class="admin-table">${thead(["When", "Player", "Wallet", "Kind", "Detail", "Match"])}${rows.map(integrityRow).join("")}</tbody></table>`
        : `<div class="admin-msg">${integrityKind ? `No “${escapeHtml(integrityKind)}” flags${query ? " match this search" : ""}.` : (query ? `No flags match “${escapeHtml(query)}”.` : "Nothing here — queue is clear. ✓")}</div>`;
      return chips + table;
    }
    if (rows.length === 0) return emptyMsg;
    switch (tab) {
      case "disputed":          return rows.map(disputedCard).join("");
      case "payout_pending":    return `<p class="admin-note">Finished matches with a winner that have not paid out yet.</p>` + rows.map((r) => payoutCard(r, false)).join("");
      case "payout_failed":     return `<p class="admin-note">Payout reservations stuck as 'pending' for over ${meta.payout_stuck_minutes ?? 15} min — likely a payout that half-completed. Verify on-chain before acting.</p>` + rows.map((r) => payoutCard(r, true)).join("");
      case "payouts":           return `<p class="admin-note">Completed payouts (from the payouts ledger). Every column is searchable above.</p><table class="admin-table">${thead(["When", "Match", "Winner", "Wallet", "Amount", "Players", "Tx"])}${rows.map(payoutRow).join("")}</tbody></table>`;
      case "consumed_deposits": return `<table class="admin-table">${thead(["When", "Player", "Wallet", "Deposit tx", "Match"])}${rows.map(consumedRow).join("")}</tbody></table>`;
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
      <td class="admin-mono">${r.winner_wallet ? addrLink(r.winner_wallet) : "—"}</td>
      <td class="admin-nowrap">${amt}</td>
      <td class="admin-nowrap">${r.num_players ?? "—"}</td>
      <td class="admin-mono">${txLink(r.payout_tx)}</td>
    </tr>`;
  }

  const thead = (cols) => `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>`;

  // ---- Cash flow (total incoming vs outgoing) -------------------------------
  function renderCashflow() {
    const f = cashflowFilters;
    const bar = `
      <div class="cf-filters" id="cfFilters">
        <label class="cf-field">From
          <input id="cfFrom" class="cf-input" type="date" value="${escapeHtml(f.from)}" />
        </label>
        <label class="cf-field">To
          <input id="cfTo" class="cf-input" type="date" value="${escapeHtml(f.to)}" />
        </label>
        <label class="cf-field cf-field-grow">Wallet
          <input id="cfWallet" class="cf-input" type="text" placeholder="wallet address (any part)…" value="${escapeHtml(f.wallet)}" autocomplete="off" />
        </label>
        <button class="admin-btn admin-btn-sm admin-primary" data-act="cf_apply">Apply</button>
        <button class="admin-btn admin-btn-sm" data-act="cf_clear">Clear</button>
      </div>`;

    let content;
    if (cashflowLoading && !cashflow) content = `<div class="admin-msg">Loading…</div>`;
    else if (cashflowError)           content = `<div class="admin-msg admin-err">${escapeHtml(cashflowError)}</div>`;
    else if (!cashflow)               content = `<div class="admin-msg">No data.</div>`;
    else                              content = renderCashflowData();
    return bar + content;
  }

  function renderCashflowData() {
    const cf = cashflow;
    const inc = cf.incoming, out = cf.outgoing;
    const netNeg = Number(cf.net_raw) < 0;
    const plural = (n, s) => `${Number(n).toLocaleString()} ${s}${Number(n) === 1 ? "" : "s"}`;

    const scope = (cf.filters.from || cf.filters.to || cf.filters.wallet)
      ? [
          cf.filters.from ? `from ${escapeHtml(cf.filters.from)}` : "",
          cf.filters.to ? `to ${escapeHtml(cf.filters.to)}` : "",
          cf.filters.wallet ? `wallet ~ <span class="admin-mono">${escapeHtml(cf.filters.wallet)}</span>` : "",
        ].filter(Boolean).join(" · ")
      : "All time, all wallets";

    const cards = `
      <div class="cf-summary">
        <div class="cf-card cf-in">
          <div class="cf-card-label">Total incoming</div>
          <div class="cf-card-amt">${fmtTokens(inc.total_raw)}</div>
          <div class="cf-card-sub">${plural(inc.count, "deposit")}</div>
        </div>
        <div class="cf-card cf-out">
          <div class="cf-card-label">Total outgoing</div>
          <div class="cf-card-amt">${fmtTokens(out.total_raw)}</div>
          <div class="cf-card-sub">${plural(out.count, "payout")}${out.truncated ? " · sum capped" : ""}</div>
        </div>
        <div class="cf-card cf-net">
          <div class="cf-card-label">Net retained</div>
          <div class="cf-card-amt${netNeg ? " cf-neg" : ""}">${fmtTokens(cf.net_raw)}</div>
          <div class="cf-card-sub">incoming − outgoing</div>
        </div>
      </div>
      <p class="admin-note">${scope}. Incoming = player entry-fee deposits recorded on seats; outgoing = winner payouts.${out.truncated ? " ⚠ Outgoing total is summed over the most recent payouts only — narrow the date range for an exact figure." : ""}</p>`;

    const inTable = inc.rows.length
      ? `<h3 class="cf-h">Incoming deposits <span class="admin-dim">showing ${inc.rows.length} of ${Number(inc.count).toLocaleString()}</span></h3>
         <table class="admin-table">${thead(["When", "Player", "Wallet", "Amount", "Deposit tx"])}${inc.rows.map(cfInRow).join("")}</tbody></table>`
      : `<h3 class="cf-h">Incoming deposits</h3><div class="admin-msg">No deposits match these filters.</div>`;

    const outTable = out.rows.length
      ? `<h3 class="cf-h">Outgoing payouts <span class="admin-dim">showing ${out.rows.length} of ${Number(out.count).toLocaleString()}</span></h3>
         <table class="admin-table">${thead(["When", "Winner", "Wallet", "Players", "Amount", "Payout tx"])}${out.rows.map(cfOutRow).join("")}</tbody></table>`
      : `<h3 class="cf-h">Outgoing payouts</h3><div class="admin-msg">No payouts match these filters.</div>`;

    return cards + inTable + outTable;
  }

  function cfInRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.joined_at)}">${ago(r.joined_at)}</td>
      <td>${escapeHtml(r.display_name || shortId(r.user_id))}</td>
      <td class="admin-mono">${r.deposit_wallet ? addrLink(r.deposit_wallet) : "—"}</td>
      <td class="admin-nowrap">${fmtTokens(r.amount_raw)}</td>
      <td class="admin-mono">${txLink(r.deposit_tx)}</td>
    </tr>`;
  }

  function cfOutRow(r) {
    return `<tr>
      <td class="admin-nowrap" title="${fmtTime(r.created_at)}">${ago(r.created_at)}</td>
      <td>${escapeHtml(r.winner_name || shortId(r.winner_user_id))}</td>
      <td class="admin-mono">${r.winner_wallet ? addrLink(r.winner_wallet) : "—"}</td>
      <td class="admin-nowrap">${r.num_players ?? "—"}</td>
      <td class="admin-nowrap">${fmtTokens(r.amount_raw, r.decimals ?? TOKEN_DECIMALS)}</td>
      <td class="admin-mono">${txLink(r.payout_tx)}</td>
    </tr>`;
  }

  // ---- Database monitoring --------------------------------------------------
  function renderDbStats() {
    if (dbstatsLoading && !dbstats) return `<div class="admin-msg">Loading…</div>`;
    if (dbstatsError)              return `<div class="admin-msg admin-err">${escapeHtml(dbstatsError)}</div>`;
    if (!dbstats)                  return `<div class="admin-msg">No data.</div>`;

    const c = dbstats.connections || {};
    const cache = dbstats.cache_hit_ratio;
    const cachePct = cache != null ? `${(Number(cache) * 100).toFixed(2)}%` : "—";
    // Cache hit ratio below ~99% on an OLTP workload is worth a second look.
    const cacheWarn = cache != null && Number(cache) < 0.99;
    const oldest = Number(dbstats.oldest_query_seconds || 0);
    const oldestWarn = oldest > 30;

    const cards = `
      <div class="mon-grid">
        <div class="mon-card">
          <div class="mon-label">Database size</div>
          <div class="mon-val">${fmtBytes(dbstats.db_bytes)}</div>
          <div class="mon-sub">${fmtInt((dbstats.tables || []).length)} tables</div>
        </div>
        <div class="mon-card">
          <div class="mon-label">Connections</div>
          <div class="mon-val">${fmtInt(c.total)}<span class="mon-of"> / ${fmtInt(c.max)}</span></div>
          <div class="mon-sub">${fmtInt(c.active)} active · ${fmtInt(c.idle)} idle${c.idle_in_transaction ? ` · ${fmtInt(c.idle_in_transaction)} idle-in-txn` : ""}</div>
        </div>
        <div class="mon-card">
          <div class="mon-label">Cache hit ratio</div>
          <div class="mon-val${cacheWarn ? " mon-warn" : ""}">${cachePct}</div>
          <div class="mon-sub">heap blocks from cache</div>
        </div>
        <div class="mon-card">
          <div class="mon-label">Longest query</div>
          <div class="mon-val${oldestWarn ? " mon-warn" : ""}">${oldest > 0 ? fmtDuration(Math.round(oldest)) : "—"}</div>
          <div class="mon-sub">running now (excl. idle)</div>
        </div>
      </div>`;

    const rows = (dbstats.tables || []).map((t) => `<tr>
      <td>${escapeHtml(t.name)}</td>
      <td class="admin-nowrap admin-right-txt">${fmtInt(t.rows)}</td>
      <td class="admin-nowrap admin-right-txt">${t.dead_rows ? fmtInt(t.dead_rows) : "—"}</td>
      <td class="admin-nowrap admin-right-txt">${fmtBytes(t.total_bytes)}</td>
      <td class="admin-nowrap">${t.last_analyze ? ago(t.last_analyze) : "—"}</td>
      <td class="admin-nowrap">
        <button class="admin-btn admin-btn-xs" data-act="db_download" data-table="${escapeHtml(t.name)}" title="Download this table as JSON">⬇ JSON</button>
        <button class="admin-btn admin-btn-xs admin-danger" data-act="db_wipe" data-table="${escapeHtml(t.name)}" data-rows="${t.rows ?? 0}" title="Delete every row in this table">Wipe</button>
      </td>
    </tr>`).join("");

    const table = rows
      ? `<table class="admin-table mon-table">${thead(["Table", "Rows (est.)", "Dead", "Size", "Analyzed", "Actions"])}${rows}</tbody></table>`
      : `<div class="admin-msg">No user tables reported.</div>`;

    // Snapshot / wipe toolbar. Downloads run client-side from the returned JSON;
    // wipes require a typed confirmation (handled in onAction).
    const toolbar = `<div class="db-toolbar">
      <button class="admin-btn admin-btn-sm admin-primary" data-act="db_download_all">⬇ Download snapshot (all tables)</button>
      <button class="admin-btn admin-btn-sm admin-danger" data-act="db_wipe_all">⚠ Wipe ALL tables</button>
    </div>`;

    return cards + toolbar +
      `<p class="admin-note">Row counts are the planner's live estimates (refreshed by autovacuum/analyze). A high dead-row count or a low cache-hit ratio can indicate a table that needs vacuuming. <b>Wipe</b> permanently deletes every row (TRUNCATE … CASCADE) — snapshot first.</p>` +
      table;
  }

  // ---- Edge-function monitoring ---------------------------------------------
  function renderFunctions() {
    if (fnhealthLoading && !fnhealth) return `<div class="admin-msg">Pinging functions…</div>`;
    if (fnhealthError)               return `<div class="admin-msg admin-err">${escapeHtml(fnhealthError)}</div>`;
    if (!fnhealth)                   return `<div class="admin-msg">No data.</div>`;

    const cards = (fnhealth.functions || []).map((f) => {
      const cfg = f.config || {};
      const detail = Object.entries(cfg).map(([k, v]) => {
        let val;
        if (v === true)  val = `<span class="fn-ok">yes</span>`;
        else if (v === false || v == null) val = `<span class="fn-bad">no</span>`;
        else if (typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v)) val = `<span class="admin-mono">${addrLink(v)}</span>`;
        else val = `<span class="admin-mono">${escapeHtml(String(v))}</span>`;
        return `<div class="fn-kv"><span class="fn-k">${escapeHtml(k)}</span>${val}</div>`;
      }).join("");
      const latWarn = f.ok && Number(f.latency_ms) > 2000;
      return `<div class="fn-card ${f.ok ? "fn-up" : "fn-down"}">
        <div class="fn-head">
          <span class="fn-dot"></span>
          <b class="fn-name">${escapeHtml(f.name)}</b>
          <span class="fn-status">${f.ok ? "reachable" : "unreachable"}</span>
          <span class="admin-dim admin-right">${f.status ? `HTTP ${f.status} · ` : ""}<span class="${latWarn ? "mon-warn" : ""}">${fmtInt(f.latency_ms)} ms</span></span>
        </div>
        ${f.error ? `<div class="fn-err">${escapeHtml(f.error)}</div>` : ""}
        ${detail ? `<div class="fn-detail">${detail}</div>` : ""}
      </div>`;
    }).join("");

    return `<p class="admin-note">Each function's unauthenticated health probe, pinged just now. “Config” reports whether required secrets are wired up — booleans and public addresses only, never a secret value. Watch for a mismatched escrow wallet / token across functions.</p>` +
      (cards || `<div class="admin-msg">No functions reported.</div>`);
  }

  // ---- Static constants editor ----------------------------------------------
  function renderConstants() {
    if (configLoading && !config) return `<div class="admin-msg">Loading…</div>`;
    if (configError)              return `<div class="admin-msg admin-err">${escapeHtml(configError)}</div>`;
    if (!config)                  return `<div class="admin-msg">No data.</div>`;

    const pvp = config.pvp_config || {};
    const locked = !!config.entry_fee_locked;
    const shareBps = pvp.winner_share_bps;
    const sharePct = shareBps != null ? (Number(shareBps) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "";

    const pvpCard = `
      <div class="cfg-card">
        <h3 class="cfg-h">Global PvP tunables <span class="admin-dim">pvp_config</span></h3>
        <div class="cfg-fields">
          <label class="cfg-field">Player cap
            <input id="cfgPlayerCap" class="cfg-input" type="number" min="1" max="100000" step="1" value="${escapeHtml(String(pvp.player_cap ?? ""))}" />
            <span class="cfg-hint">Max concurrent players game-wide.</span>
          </label>
          <label class="cfg-field">Entry fee ($FIGHT10)
            <input id="cfgEntryFee" class="cfg-input" type="number" min="1" max="100000000" step="1" value="${escapeHtml(String(pvp.entry_fee_tokens ?? ""))}"${locked ? " disabled" : ""} />
            <span class="cfg-hint">${locked
              ? `🔒 Locked — ${fmtInt(config.live_matches)} match${config.live_matches === 1 ? "" : "es"} waiting/active.`
              : "Whole tokens per seat. Verified on-chain."}</span>
          </label>
          <label class="cfg-field">Winner share (bps)
            <input id="cfgWinnerShare" class="cfg-input" type="number" min="0" max="10000" step="1" value="${escapeHtml(String(shareBps ?? ""))}" />
            <span class="cfg-hint">10000 = 100%. Currently ${sharePct}% of the pot.</span>
          </label>
        </div>
        <div class="cfg-actions">
          <button class="admin-btn admin-btn-sm admin-primary" data-act="cfg_save_pvp">Save tunables</button>
        </div>
      </div>`;

    const mcRows = (config.match_config || []).map((r) => `
      <div class="cfg-mc-row" data-mc-row="${r.max_players}">
        <span class="cfg-mc-label">${r.max_players}-player lobby</span>
        <input class="cfg-input cfg-mc-input" type="number" min="30" max="3600" step="1" value="${escapeHtml(String(r.duration_seconds ?? ""))}" />
        <span class="cfg-hint">seconds (${fmtDuration(r.duration_seconds)})</span>
      </div>`).join("");
    const matchCard = `
      <div class="cfg-card">
        <h3 class="cfg-h">Match durations <span class="admin-dim">match_config</span></h3>
        ${mcRows || `<div class="admin-msg">No lobby sizes configured.</div>`}
        <div class="cfg-actions">
          <button class="admin-btn admin-btn-sm admin-primary" data-act="cfg_save_match">Save durations</button>
        </div>
      </div>`;

    const maintOn = config.maintain === "y";
    const maintCard = `
      <div class="cfg-card">
        <h3 class="cfg-h">Maintenance mode <span class="admin-dim">maintain</span></h3>
        <div class="cfg-maint">
          <span class="cfg-maint-state ${maintOn ? "is-on" : "is-off"}">${maintOn ? "● ON — new joins blocked" : "● OFF — normal play"}</span>
          <button class="admin-btn admin-btn-sm ${maintOn ? "" : "admin-danger"}" data-act="cfg_maint" data-value="${maintOn ? "n" : "y"}">
            ${maintOn ? "Turn OFF" : "Turn ON"}
          </button>
        </div>
        <span class="cfg-hint">In-flight matches still settle &amp; pay out; only new seats are blocked.</span>
      </div>`;

    return `<p class="admin-note">Edit the static constants that otherwise live only in the Supabase table editor. Changes take effect immediately and are recorded as review notes.</p>` +
      pvpCard + matchCard + maintCard;
  }

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
        <span class="admin-mono">${p.deposit_wallet ? addrLink(p.deposit_wallet) : "—"}</span>
        <span class="admin-phP">HP ${p.final_hp ?? "—"}</span>
        ${flags.join("")}
        ${award}
      </div>`;
    }).join("");
    return `<div class="admin-card">
      <div class="admin-card-head">
        <b>Match #${m.match_no ?? shortId(m.id)}</b>
        <span class="admin-dim">${m.max_players}-player · pot ${fmtTokens(m.pot_tokens, 0)} · reason: ${reason}</span>
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
        <span class="admin-dim">winner ${escapeHtml(m.winner_name || shortId(m.winner_user_id))}${m.winner_wallet ? ` · <span class="admin-mono">${addrLink(m.winner_wallet)}</span>` : ""} · pot ${fmtTokens(m.pot_tokens, 0)}</span>
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
    const players = (m.players || []).map((p) =>
      `#${p.seat} ${player(p)}${p.deposit_wallet ? ` <span class="admin-mono">${addrLink(p.deposit_wallet)}</span>` : ""}`).join(", ");
    return `<div class="admin-card">
      <div class="admin-card-head">
        <b>Match #${m.match_no ?? shortId(m.id)}</b>
        <span class="admin-dim">${m.seats_filled}/${m.max_players} seats · open ${m.open_minutes}m · pot ${fmtTokens(m.pot_tokens, 0)}</span>
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
      <td class="admin-mono">${r.user_wallet ? addrLink(r.user_wallet) : "—"}</td>
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
      <td class="admin-mono">${r.user_wallet ? addrLink(r.user_wallet) : "—"}</td>
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
      <td class="admin-nowrap">${escapeHtml(r.author_name || shortId(r.author_id))}${r.author_wallet ? ` <span class="admin-mono">${addrLink(r.author_wallet)}</span>` : ""}</td>
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
