export const html = `
  <!-- ===== Hero ===== -->
  <section class="hero-section">
    <div class="hero-title-block">
      <div class="hero-big-fight">FIGHT</div>
      <div class="hero-big-10">10</div>
    </div>
    <div class="hero-tagline">
      <h2 class="hero-subtitle">LAST ONE STANDING</h2>
      <p class="hero-desc">A tactical isometric arena. Every fighter spawns with the same health, the same attack, and the same weapons — no advantages, pure skill. Each player puts in <strong>2,500 $FIGHT10</strong> — last one standing takes the entire pot. Connect your Solana wallet, then drop into a demo match against the computer or queue for 2, 5, or 10-player PvP. <strong>Winner takes it all.</strong></p>
    </div>
  </section>

  <!-- ===== Action buttons ===== -->
  <div class="home-actions">
    <button class="home-btn home-btn-secondary hidden" id="demoBtn" type="button">DEMO MATCH</button>
    <button class="home-btn home-btn-primary" id="connectWalletBtn" type="button">Connect Wallet</button>
    <button class="home-btn home-btn-primary hidden" id="pvpBtn" type="button">PLAY PVP</button>
    <button class="home-btn home-btn-secondary" id="howToPlayBtn" type="button">HOW TO PLAY</button>
    <button class="home-btn home-btn-secondary" id="whitepaperBtn" type="button">WHITEPAPER</button>
    <button class="home-btn home-btn-ghost hidden" id="signOutBtn" type="button">Sign Out</button>
  </div>

  <!-- ===== Info strip ===== -->
  <div class="info-strip">
    <div class="info-tile">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
      <div class="info-tile-label">SKILL BASED</div>
      <div class="info-tile-desc">No pay to win.<br>Just you and your aim.</div>
    </div>
    <div class="info-tile">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div class="info-tile-label">FAST MATCHES</div>
      <div class="info-tile-desc">Jump in.<br>Fight. Win.</div>
    </div>
    <div class="info-tile">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2l7 7-10 10.5L4 12z"/><path d="M2 22l4-4"/></svg>
      <div class="info-tile-label">SAME KIT</div>
      <div class="info-tile-desc">Same weapons.<br>Same health.</div>
    </div>
    <div class="info-tile">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
      <div class="info-tile-label">RANK UP</div>
      <div class="info-tile-desc">Climb the leaderboard.<br>Prove yourself.</div>
    </div>
    <div class="info-tile info-tile-multiplier">
      <div class="info-tile-multi">2,500 $FIGHT10</div>
      <div class="info-tile-label">ENTRY PER PLAYER</div>
      <div class="info-tile-desc">Last one standing<br>takes the entire pot.</div>
    </div>
    <div class="info-tile info-tile-online">
      <div class="info-tile-multi"><span class="online-dot"></span><span id="onlineCount">—</span></div>
      <div class="info-tile-label">ONLINE NOW</div>
      <div class="info-tile-desc">Players in the<br>app right now.</div>
    </div>
  </div>
`;
