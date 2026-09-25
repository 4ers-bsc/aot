export const html = `
  <!-- Landing chrome is one full-viewport flex column (hero grows, actions +
       info strip keep their natural height) so the bands can never overlap,
       whatever the viewport size. -->
  <div class="home-screen">
  <!-- ===== Hero ===== -->
  <section class="hero-section">
    <div class="hero-title-block">
      <div class="hero-big-the">THE</div>
      <div class="hero-big-gulag">GULAG</div>
      <div class="hero-beta">BETA</div>
    </div>
    <div class="hero-tagline">
      <h2 class="hero-subtitle">LAST ONE STANDING</h2>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-value">10,000</div>
          <div class="hero-stat-label">$GULAG Entry</div>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <div class="hero-stat-value">90%</div>
          <div class="hero-stat-label">Winner's Pot</div>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <div class="hero-stat-value">2·5·10</div>
          <div class="hero-stat-label">Player Matches</div>
        </div>
      </div>
    </div>
  </section>

  <!-- ===== Action buttons ===== -->
  <div class="home-actions">
    <button class="home-btn home-btn-hero" id="pvpBtn" type="button">CONNECT WALLET</button>
    <div class="home-actions-row">
      <button class="home-btn home-btn-secondary hidden" id="demoBtn" type="button">DEMO MATCH</button>
      <button class="home-btn home-btn-secondary" id="howToPlayBtn" type="button">HOW TO PLAY</button>
      <button class="home-btn home-btn-secondary" id="homeLeaderboardBtn" type="button">LEADERBOARD</button>
      <button class="home-btn home-btn-secondary" id="whitepaperBtn" type="button">WHITEPAPER</button>
    </div>
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
      <div class="info-tile-multi">10,000 $GULAG</div>
      <div class="info-tile-label">ENTRY PER PLAYER</div>
      <div class="info-tile-desc">Last one standing<br>takes 90% of the pot.</div>
    </div>
    <div class="info-tile info-tile-online">
      <div class="info-tile-multi"><span class="online-dot"></span><span id="onlineCount">—</span></div>
      <div class="info-tile-label">ONLINE NOW</div>
      <div class="info-tile-desc">Players in the<br>game right now.</div>
    </div>
  </div>
  </div><!-- /.home-screen -->

  <!-- ===== Landing sections (below the fold) ===== -->
  <!-- One idea per block. Each .sb is scroll-linked by src/home-anim.js: it
       fades, rises and scales in as it nears the middle of the viewport and
       drifts back out as it leaves, in both scroll directions. -->
  <div class="home-sections" id="homeSections">

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">01</div>
      <div class="sb-inner">
        <div class="sb-kicker">STEP ONE</div>
        <h2 class="sb-title">PAY IN</h2>
        <p class="sb-line"><span class="hs-gold">10,000 $GULAG</span> buys your seat.</p>
        <p class="sb-sub">Verified on-chain before you drop in.</p>
      </div>
    </section>

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">02</div>
      <div class="sb-inner">
        <div class="sb-kicker">STEP TWO</div>
        <h2 class="sb-title">FIGHT</h2>
        <p class="sb-line">Same health. Same weapons. Only skill.</p>
        <div class="sb-chips">
          <span class="sb-chip" style="--i:0">FRAG</span>
          <span class="sb-chip" style="--i:1">SWORD</span>
          <span class="sb-chip" style="--i:2">PISTOL</span>
          <span class="sb-chip" style="--i:3">SNIPER</span>
        </div>
      </div>
    </section>

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">03</div>
      <div class="sb-inner">
        <div class="sb-kicker">STEP THREE</div>
        <h2 class="sb-title">OUTLAST</h2>
        <p class="sb-line">Last one standing takes <span class="hs-gold">90%</span> of the pot.</p>
      </div>
    </section>

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">2·5·10</div>
      <div class="sb-inner">
        <div class="sb-kicker">PICK YOUR BATTLE</div>
        <div class="sb-tiles">
          <div class="sb-tile" style="--i:0"><div class="sb-tile-big">2</div><div class="sb-tile-name">DUEL</div><div class="sb-tile-meta">5 min · win 18,000</div></div>
          <div class="sb-tile" style="--i:1"><div class="sb-tile-big">5</div><div class="sb-tile-name">SKIRMISH</div><div class="sb-tile-meta">7 min · win 45,000</div></div>
          <div class="sb-tile" style="--i:2"><div class="sb-tile-big">10</div><div class="sb-tile-name">WARZONE</div><div class="sb-tile-meta">10 min · win 90,000</div></div>
        </div>
      </div>
    </section>

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">+60</div>
      <div class="sb-inner">
        <div class="sb-kicker">EVERY MATCH COUNTS</div>
        <h2 class="sb-title">CLIMB</h2>
        <p class="sb-line">+10 to play. +60 to win. Streaks stack.</p>
      </div>
    </section>

    <section class="sb">
      <div class="sb-ghost" aria-hidden="true">✓</div>
      <div class="sb-inner">
        <div class="sb-kicker">NO HOUSE EDGE</div>
        <h2 class="sb-title">BUILT FAIR</h2>
        <p class="sb-line">Verified on-chain. Decided by the server. Cheaters forfeit.</p>
        <div class="sb-actions">
          <button class="home-btn home-btn-secondary" id="secWhitepaperBtn" type="button">READ THE WHITEPAPER</button>
        </div>
      </div>
    </section>

    <section class="sb sb-cta">
      <div class="sb-inner">
        <h2 class="sb-title">ONLY ONE WALKS OUT</h2>
        <div class="sb-actions">
          <button class="home-btn home-btn-hero hs-cta-play" id="secPlayBtn" type="button">PLAY PVP</button>
          <button class="home-btn home-btn-secondary" id="secHowToBtn" type="button">HOW TO PLAY</button>
        </div>
      </div>
    </section>

    <footer class="hs-footer">
      <div class="hs-footer-disclaimer">For entertainment only · not financial advice · entries are non-refundable once a match is joined.</div>
      <a class="hs-footer-x" href="https://x.com/fight10_club" target="_blank" rel="noopener noreferrer" aria-label="The Gulag on X">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        @fight10_club
      </a>
    </footer>
  </div><!-- /.home-sections -->

  <!-- Scroll cue — bottom-right hint that there's more below the fold -->
  <button class="scroll-cue" id="scrollCue" type="button" aria-label="Scroll down for details">
    <span class="scroll-cue-text">SCROLL</span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
`;
