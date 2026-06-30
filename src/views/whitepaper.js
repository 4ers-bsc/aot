export const html = `
  <!-- Whitepaper / Technical -->
  <div class="overlay" id="whitepaperOverlay">
    <div class="panel panel-wide">
      <div class="panel-head">Whitepaper<button class="close" id="whitepaperClose" type="button">&times;</button></div>
      <div class="tab-body wp-body">

        <p class="wp-intro">
          FIGHT10 is a skill-based, last-one-standing arena where every fighter
          spawns identical and each player stakes an equal entry. The winner takes
          the pot. This paper describes how the system stays fair and custodial-safe.
          Implementation identifiers are intentionally masked.
        </p>

        <div class="wp-section">01 · Economic model</div>
        <p class="wp-text">
          Every player stakes a fixed entry of the in-game token. All entries for a
          match form a single pot. On a verified result the pot is paid to the sole
          survivor, less a small protocol fee. Entries are non-refundable once a
          match is joined — leaving forfeits the stake to the pot.
        </p>

        <div class="wp-section">02 · Custody &amp; escrow</div>
        <p class="wp-text">
          Stakes are transferred on-chain into a program-controlled escrow account.
          The escrow signer is held only by a privileged server process; it is never
          exposed to the browser. Payouts are the only outflow, and they are gated by
          a verified, finished match with a single confirmed winner.
        </p>

        <div class="wp-section">03 · Deposit-before-join (verified admission)</div>
        <p class="wp-text">
          A seat can only be taken <em>after</em> the stake is verified on-chain — the
          browser cannot self-admit. The flow:
        </p>
        <div class="wp-flow">
          <div class="wp-step"><span>1</span> Client signs the stake transfer to escrow.</div>
          <div class="wp-step"><span>2</span> A verification service re-checks the transaction on-chain: confirmed status, exact amount, correct destination, and that the signer matches the player's own wallet.</div>
          <div class="wp-step"><span>3</span> Only then does a privileged admission routine grant the seat.</div>
        </div>
        <p class="wp-text">
          The admission routine is not callable by clients — it is restricted to the
          server role. A fabricated transaction reference therefore fails at step 2
          and never reaches a lobby. One wallet maps to one active match at a time.
        </p>

        <div class="wp-section">04 · Matchmaking &amp; seat allocation</div>
        <p class="wp-text">
          Joiners are matched into the oldest open lobby of the requested size under a
          row lock, so concurrent joins fan out instead of colliding. Seats are
          assigned to the lowest free index rather than a running count, so a player
          leaving a waiting lobby never creates a gap or a duplicate seat. A lobby
          activates the instant its final seat is filled.
        </p>

        <div class="wp-section">05 · Authoritative settlement</div>
        <p class="wp-text">
          The result is decided by the server, never by a client's self-reported
          outcome. Each player reports only the damage <em>they</em> dealt; the server
          derives every fighter's surviving health from what <em>others</em> reported,
          so no client can inflate its own survival. Damage is accepted only within
          physically-plausible ceilings on rate and total output. The highest-health
          eligible fighter is crowned. If the ledger cannot produce a clean winner,
          the match is held for review and nobody is paid.
        </p>

        <div class="wp-section">06 · Anti-manipulation</div>
        <p class="wp-text">The browser and its console are treated as hostile. Enforcement lives on the server in layers:</p>
        <ul class="wp-list">
          <li><strong>Write-time validation.</strong> Impossible or out-of-context combat records (wrong match state, non-participants, bad timing, output above a hard ceiling) are rejected at the moment they are written.</li>
          <li><strong>Rate limiting.</strong> Authoritative actions and the admission service are throttled per player to blunt scripted abuse.</li>
          <li><strong>Forfeit, not void.</strong> A player flagged for impossible output is excluded from winner selection; the best clean player still wins and the cheater forfeits their stake — honest opponents are never punished for someone else's cheating.</li>
          <li><strong>Soft telemetry.</strong> Client-side tamper signals are reported for review only. They never auto-penalize, to avoid false-positive bans on honest players.</li>
        </ul>

        <div class="wp-section">07 · Payout integrity</div>
        <p class="wp-text">
          Before any transfer the payout process re-verifies every stake on-chain,
          confirms the caller is the recorded winner, and atomically reserves a
          single payout slot so concurrent or repeated claims cannot double-pay. The
          escrow transfer is broadcast and then polled to confirmation; the result is
          recorded with retries so a confirmed transfer is never lost or repeated.
        </p>

        <div class="wp-section">08 · Infrastructure resilience</div>
        <p class="wp-text">
          On-chain reads and writes are spread across multiple independent chain
          endpoints with round-robin selection and automatic failover, raising
          throughput at peak join times and surviving a single provider being rate
          limited or unavailable.
        </p>

        <div class="wp-section">09 · Security posture</div>
        <ul class="wp-list">
          <li>Server authority for everything that touches funds or results.</li>
          <li>Row-level isolation: a player can only read their own data and only write records attributed to themselves.</li>
          <li>Least privilege: sensitive routines are restricted to the server role and never granted to clients.</li>
          <li>Secrets (escrow signer, service credentials, endpoint keys) live only in the server environment.</li>
        </ul>

        <p class="wp-foot">This document is informational and describes system design at a high level. It is not financial advice. Exact thresholds, identifiers, and parameters are withheld by design.</p>
      </div>
    </div>
  </div>
`;
