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
  <!-- A pinned scroll story. #homeSections is tall; .story-stage sticks to the
       viewport while src/home-anim.js maps scroll progress onto six chapters
       that crossfade in place (masked line reveals, drawn rules, counting
       figures, a progress rail). Without the script — or with reduced
       motion — .story-live is never added and the chapters simply stack. -->
  <div class="home-sections" id="homeSections">
   <div class="story" style="--chapters:6">
    <div class="story-stage">
      <div class="story-glow" aria-hidden="true"></div>
      <nav class="story-rail" aria-label="Chapters">
        <div class="story-rail-track"><div class="story-rail-fill"></div></div>
        <ol><li><button type="button" data-ch-go="0" aria-label="Chapter I: The Stake">I</button></li><li><button type="button" data-ch-go="1" aria-label="Chapter II: The Equal Start">II</button></li><li><button type="button" data-ch-go="2" aria-label="Chapter III: The Prize">III</button></li><li><button type="button" data-ch-go="3" aria-label="Chapter IV: The Yards">IV</button></li><li><button type="button" data-ch-go="4" aria-label="Chapter V: The Record">V</button></li><li><button type="button" data-ch-go="5" aria-label="Chapter VI: The Rules">VI</button></li></ol>
      </nav>

      <article class="ch" data-ch="0">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">I</span><span class="ch-rule"></span><span>THE STAKE</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>Ten thousand</span></span><span class="ch-line" style="--k:1"><span><em>to enter.</em></span></span></h2>
          <p class="ch-sub"><span class="hs-gold">$GULAG</span>, verified on-chain before you set foot inside.</p>
        </div>
        <div class="ch-aside">
          <div class="ch-figure"><span class="ch-count" data-count="10000">10,000</span><span class="ch-figure-unit">$GULAG · per seat</span></div>
        </div>
      </article>

      <article class="ch" data-ch="1">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">II</span><span class="ch-rule"></span><span>THE EQUAL START</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>Everyone</span></span><span class="ch-line" style="--k:1"><span><em>walks in equal.</em></span></span></h2>
          <p class="ch-sub">Same health. Same four weapons. The only difference is you.</p>
        </div>
        <div class="ch-aside">
          <ul class="ch-list"><li style="--k:0">Frag</li><li style="--k:1">Sword</li><li style="--k:2">Pistol</li><li style="--k:3">Sniper</li></ul>
        </div>
      </article>

      <article class="ch" data-ch="2">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">III</span><span class="ch-rule"></span><span>THE PRIZE</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>One walks out</span></span><span class="ch-line" style="--k:1"><span><em>with the pot.</em></span></span></h2>
          <p class="ch-sub">The last fighter standing is paid straight from escrow.</p>
        </div>
        <div class="ch-aside">
          <div class="ch-figure"><span class="ch-count" data-count="90" data-suffix="%">90%</span><span class="ch-figure-unit">of every pot</span></div>
        </div>
      </article>

      <article class="ch" data-ch="3">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">IV</span><span class="ch-rule"></span><span>THE YARDS</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>Choose</span></span><span class="ch-line" style="--k:1"><span><em>your sentence.</em></span></span></h2>
          <p class="ch-sub">Free-for-all. The match starts the moment the room is full.</p>
        </div>
        <div class="ch-aside">
          <table class="ch-table">
            <tr style="--k:0"><th>Duel</th><td>2 players</td><td>5 min</td><td class="hs-gold">18,000</td></tr>
            <tr style="--k:1"><th>Skirmish</th><td>5 players</td><td>7 min</td><td class="hs-gold">45,000</td></tr>
            <tr style="--k:2"><th>Warzone</th><td>10 players</td><td>10 min</td><td class="hs-gold">90,000</td></tr>
          </table>
        </div>
      </article>

      <article class="ch" data-ch="4">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">V</span><span class="ch-rule"></span><span>THE RECORD</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>Every fight</span></span><span class="ch-line" style="--k:1"><span><em>is written down.</em></span></span></h2>
          <p class="ch-sub">Points for showing up, more for winning, and streaks that compound.</p>
        </div>
        <div class="ch-aside">
          <ul class="ch-list"><li style="--k:0">+10 play</li><li style="--k:1">+60 win</li><li style="--k:2">streak bonus</li></ul>
        </div>
      </article>

      <article class="ch" data-ch="5">
        <div class="ch-copy">
          <div class="ch-kicker"><span class="ch-num">VI</span><span class="ch-rule"></span><span>THE RULES</span></div>
          <h2 class="ch-title"><span class="ch-line" style="--k:0"><span>The house can’t cheat.</span></span><span class="ch-line" style="--k:1"><span><em>Neither can they.</em></span></span></h2>
          <p class="ch-sub">Verified entry. Server-decided results. Cheaters forfeit their stake.</p>
        </div>
        <div class="ch-aside">
          <div class="ch-actions"><button class="home-btn home-btn-secondary" id="secWhitepaperBtn" type="button">READ THE WHITEPAPER</button></div>
        </div>
      </article>
    </div>
   </div><!-- /.story -->

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
      <a class="hs-footer-x" href="https://x.com/onedot6one8" target="_blank" rel="noopener noreferrer" aria-label="The Gulag on X">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        @onedot6one8
      </a>
    </footer>
  </div><!-- /.home-sections -->

  <!-- Scroll cue — bottom-right hint that there's more below the fold -->
  <button class="scroll-cue" id="scrollCue" type="button" aria-label="Scroll down for details">
    <span class="scroll-cue-text">SCROLL</span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
`;
