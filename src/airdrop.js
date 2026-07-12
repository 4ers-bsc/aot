// ---------------------------------------------------------------------------
// Airdrop page (/airdrop.html)
//
// A standalone ops tool that transfers an ERC-20 token from one source wallet
// to a list of recipient wallets — one on-chain `transfer` per address. Unlike
// the game (which signs deposits through the injected MetaMask provider), this
// tool signs with a raw private key pasted into the form, so it can run
// unattended against the source wallet without a browser-wallet prompt per tx.
//
// SECURITY: the private key is used only to build an in-memory ethers Wallet on
// this tab. It is never stored, logged, or sent anywhere — every transfer is
// broadcast straight to the Robinhood Chain RPC from the browser.
// ---------------------------------------------------------------------------
import { importEthers } from "./lazy-deps.js";
import { NETWORK, RPC_URL, txExplorerUrl } from "./network.js";

// Minimal ERC-20 surface: transfer to move tokens, decimals/balanceOf/symbol to
// validate the amount and give useful pre-flight feedback.
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const els = {
  network:    document.getElementById("adNetwork"),
  token:      document.getElementById("adToken"),
  privateKey: document.getElementById("adPrivateKey"),
  pkToggle:   document.getElementById("adPkToggle"),
  fromAddr:   document.getElementById("adFromAddress"),
  amount:     document.getElementById("adAmount"),
  wallets:    document.getElementById("adWallets"),
  summary:    document.getElementById("adSummary"),
  submit:     document.getElementById("adSubmit"),
  status:     document.getElementById("adStatus"),
  log:        document.getElementById("adLog"),
};

els.network.textContent = `${NETWORK.name} · chain ${NETWORK.chainId}`;

// Never render user/tx-supplied text as HTML.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "ad-status" + (kind ? " " + kind : "");
}

// Split a free-form recipient blob into addresses. Any mix of newlines, commas
// and whitespace works; blanks are dropped and exact duplicates collapsed
// (keeping first-seen order) so nobody is paid twice in one run.
function parseWallets(raw) {
  const seen = new Set();
  const out = [];
  for (const tok of String(raw || "").split(/[\s,;]+/)) {
    const t = tok.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Lazy ethers loader shared by validation and the send loop.
let _ethers = null;
async function ethersLib() {
  if (!_ethers) _ethers = await importEthers();
  return _ethers;
}

// Show/hide the private key.
els.pkToggle.addEventListener("click", () => {
  const showing = els.privateKey.type === "text";
  els.privateKey.type = showing ? "password" : "text";
  els.pkToggle.textContent = showing ? "Show" : "Hide";
});

// Live recipient count so the operator sees how many transfers a run implies.
function updateSummary() {
  const list = parseWallets(els.wallets.value);
  const amt = els.amount.value.trim();
  const parts = [`<span>Recipients: <b>${list.length}</b></span>`];
  if (amt) parts.push(`<span>Per wallet: <b>${esc(amt)}</b></span>`);
  els.summary.innerHTML = list.length ? parts.join("") : "";
}
els.wallets.addEventListener("input", updateSummary);
els.amount.addEventListener("input", updateSummary);

// Render one row per recipient; returns the row elements keyed by index so the
// send loop can flip each to sent/done/fail as it progresses.
function buildLog(addresses) {
  els.log.innerHTML = "";
  const rows = addresses.map((addr, i) => {
    const row = document.createElement("div");
    row.className = "ad-log-row pending";
    row.innerHTML =
      `<span class="addr">${i + 1}. ${esc(addr)}</span>` +
      `<span class="state">Pending</span>`;
    els.log.appendChild(row);
    return row;
  });
  els.log.classList.add("show");
  return rows;
}

function setRow(row, cls, stateText, txHash) {
  row.className = "ad-log-row " + cls;
  const stateEl = row.querySelector(".state");
  if (txHash) {
    stateEl.innerHTML =
      `<a href="${txExplorerUrl(txHash)}" target="_blank" rel="noopener noreferrer">${esc(stateText)}</a>`;
  } else {
    stateEl.textContent = stateText;
  }
}

let running = false;

async function runAirdrop() {
  if (running) return;

  // ---- Gather + validate inputs -----------------------------------------
  const ethers = await ethersLib().catch(() => null);
  if (!ethers) {
    setStatus("Could not load the Ethereum libraries — check your connection and retry.", "err");
    return;
  }

  const tokenRaw = els.token.value.trim();
  const pkRaw = els.privateKey.value.trim();
  const fromRaw = els.fromAddr.value.trim();
  const amountRaw = els.amount.value.trim();
  const addresses = parseWallets(els.wallets.value);

  let token, fromAddr;
  try { token = ethers.getAddress(tokenRaw); }
  catch { return setStatus("Token contract address is not a valid address.", "err"); }

  if (!pkRaw) return setStatus("Enter the source wallet private key.", "err");
  let signer;
  try {
    signer = new ethers.Wallet(pkRaw.startsWith("0x") ? pkRaw : "0x" + pkRaw);
  } catch {
    return setStatus("Private key is invalid — expected 64 hex characters.", "err");
  }

  try { fromAddr = ethers.getAddress(fromRaw); }
  catch { return setStatus("Source wallet address is not a valid address.", "err"); }

  if (signer.address.toLowerCase() !== fromAddr.toLowerCase()) {
    return setStatus(
      `The private key controls ${signer.address}, not the source address you entered. ` +
      "Fix one of them before sending.", "err");
  }

  if (!amountRaw || !(Number(amountRaw) > 0)) {
    return setStatus("Enter a positive amount per wallet.", "err");
  }

  if (!addresses.length) return setStatus("Add at least one recipient wallet.", "err");

  // Flag any malformed recipient up-front rather than mid-run.
  const bad = [];
  const clean = [];
  for (const a of addresses) {
    try { clean.push(ethers.getAddress(a)); }
    catch { bad.push(a); }
  }
  if (bad.length) {
    return setStatus(`${bad.length} recipient address(es) are invalid, e.g. "${esc(bad[0])}". Fix the list and retry.`, "err");
  }

  // ---- Pre-flight: connect, read token, check balance -------------------
  running = true;
  els.submit.disabled = true;
  setStatus("Connecting to the network…");

  let decimals, symbol, perWallet, total, balance;
  const provider = new ethers.JsonRpcProvider(RPC_URL, NETWORK.chainId, { staticNetwork: true });
  const wallet = signer.connect(provider);
  const contract = new ethers.Contract(token, ERC20_ABI, wallet);

  try {
    decimals = Number(await contract.decimals());
  } catch {
    running = false; els.submit.disabled = false;
    return setStatus("Could not read the token contract — check the CA and that it's an ERC-20 on this network.", "err");
  }
  try { symbol = await contract.symbol(); } catch { symbol = "tokens"; }

  try {
    perWallet = ethers.parseUnits(amountRaw, decimals);
  } catch {
    running = false; els.submit.disabled = false;
    return setStatus(`Amount "${esc(amountRaw)}" is not valid for a token with ${decimals} decimals.`, "err");
  }
  total = perWallet * BigInt(clean.length);

  try {
    balance = await contract.balanceOf(fromAddr);
  } catch {
    balance = null; // non-fatal — we'll still let the operator proceed
  }
  if (balance !== null && balance < total) {
    running = false; els.submit.disabled = false;
    return setStatus(
      `Source wallet holds ${ethers.formatUnits(balance, decimals)} ${symbol}, ` +
      `but this run needs ${ethers.formatUnits(total, decimals)} ${symbol} ` +
      `(${amountRaw} × ${clean.length}). Top up or reduce the list.`, "err");
  }

  // ---- Confirm ----------------------------------------------------------
  const confirmMsg =
    `Send ${amountRaw} ${symbol} to each of ${clean.length} wallet(s) ` +
    `(${ethers.formatUnits(total, decimals)} ${symbol} total) from ${fromAddr}?\n\n` +
    "Each recipient is a separate on-chain transaction and cannot be undone.";
  if (!window.confirm(confirmMsg)) {
    running = false; els.submit.disabled = false;
    return setStatus("Cancelled — nothing was sent.");
  }

  // ---- Send loop --------------------------------------------------------
  const rows = buildLog(clean);
  // Manage the nonce explicitly and sequentially: each transfer uses the next
  // nonce and we wait for the RPC to accept it before moving on. This keeps the
  // ordering deterministic and avoids "nonce too low"/replacement races that a
  // fire-all-at-once approach hits on most RPCs.
  let nonce = await provider.getTransactionCount(fromAddr, "pending");
  let ok = 0, failed = 0;

  for (let i = 0; i < clean.length; i++) {
    const to = clean[i];
    setStatus(`Sending ${i + 1} of ${clean.length}… (${ok} confirmed, ${failed} failed)`);
    setRow(rows[i], "sent", "Submitting…");
    try {
      const tx = await contract.transfer(to, perWallet, { nonce });
      nonce += 1;
      setRow(rows[i], "sent", "Sent · confirming", tx.hash);
      const receipt = await tx.wait();
      if (receipt && receipt.status === 0) {
        failed++;
        setRow(rows[i], "fail", "Reverted", tx.hash);
      } else {
        ok++;
        setRow(rows[i], "done", "Confirmed", tx.hash);
      }
    } catch (err) {
      failed++;
      const msg = (err && (err.shortMessage || err.reason || err.message)) || "Failed";
      setRow(rows[i], "fail", "Failed");
      rows[i].querySelector(".addr").title = String(msg);
      // A nonce error means our local counter drifted (e.g. a tx landed after a
      // timeout) — resync from the chain before the next send so one hiccup
      // doesn't cascade into failing the whole remaining list.
      if (/nonce/i.test(String(msg))) {
        try { nonce = await provider.getTransactionCount(fromAddr, "pending"); } catch (_) {}
      }
    }
  }

  running = false;
  els.submit.disabled = false;
  const done = failed === 0;
  setStatus(
    `Done — ${ok} of ${clean.length} transfer(s) confirmed` +
    (failed ? `, ${failed} failed (see the list below).` : "."),
    done ? "ok" : "err");
}

els.submit.addEventListener("click", () => {
  runAirdrop().catch((e) => {
    console.error("[airdrop]", e);
    running = false;
    els.submit.disabled = false;
    setStatus(e?.message || "Airdrop failed unexpectedly.", "err");
  });
});

updateSummary();
