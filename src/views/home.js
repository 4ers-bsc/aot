export const html = `
  <!-- ===== First screen: hero + actions + info strip ===== -->
  <div class="home-screen">
  <section class="hero-section">
    <div class="hero-title-block">
      <div class="hero-big-fight" data-reveal="fade-down">FIGHT</div>
      <div class="hero-big-10" data-reveal="zoom" style="--reveal-delay: 0.15s">10</div>
    </div>
    <div class="hero-tagline" data-reveal="fade-up" style="--reveal-delay: 0.3s">
      <h2 class="hero-subtitle">LAST ONE STANDING</h2>
      <p class="hero-desc">A tactical isometric arena. Every fighter spawns with the same health, the same attack, and the same weapons — no advantages, pure skill. Each player puts in <strong>2,500 $FIGHT10</strong> — the last one standing takes 90% of the pot (a 10% protocol fee keeps the arena running). Connect your Solana wallet, then drop into a demo match against the computer or queue for 2, 5, or 10-player PvP. <strong>Winner takes 90% of the pot.</strong></p>
    </div>
  </section>

  <!-- ===== Action buttons ===== -->
  <div class="home-actions" data-reveal="fade-up" style="--reveal-delay: 0.45s">
    <button class="home-btn home-btn-secondary hidden" id="demoBtn" type="button">DEMO MATCH</button>
    <button class="home-btn home-btn-primary" id="connectWalletBtn" type="button">Connect Wallet</button>
    <button class="home-btn home-btn-primary hidden" id="pvpBtn" type="button">PLAY PVP</button>
    <button class="home-btn home-btn-secondary" id="howToPlayBtn" type="button">HOW TO PLAY</button>
    <button class="home-btn home-btn-secondary" id="whitepaperBtn" type="button">WHITEPAPER</button>
    <button class="home-btn home-btn-ghost hidden" id="signOutBtn" type="button">Sign Out</button>
  </div>

  <!-- ===== Info strip ===== -->
  <div class="info-strip">
    <div class="info-tile" data-reveal="fade-up" style="--reveal-delay: 0.05s">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
      <div class="info-tile-label">SKILL BASED</div>
      <div class="info-tile-desc">No pay to win.<br>Just you and your aim.</div>
    </div>
    <div class="info-tile" data-reveal="fade-up" style="--reveal-delay: 0.13s">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div class="info-tile-label">FAST MATCHES</div>
      <div class="info-tile-desc">Jump in.<br>Fight. Win.</div>
    </div>
    <div class="info-tile" data-reveal="fade-up" style="--reveal-delay: 0.21s">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2l7 7-10 10.5L4 12z"/><path d="M2 22l4-4"/></svg>
      <div class="info-tile-label">SAME KIT</div>
      <div class="info-tile-desc">Same weapons.<br>Same health.</div>
    </div>
    <div class="info-tile" data-reveal="fade-up" style="--reveal-delay: 0.29s">
      <svg class="info-tile-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
      <div class="info-tile-label">RANK UP</div>
      <div class="info-tile-desc">Climb the leaderboard.<br>Prove yourself.</div>
    </div>
    <div class="info-tile info-tile-multiplier" data-reveal="fade-up" style="--reveal-delay: 0.37s">
      <div class="info-tile-multi">2,500 $FIGHT10</div>
      <div class="info-tile-label">ENTRY PER PLAYER</div>
      <div class="info-tile-desc">Last one standing<br>takes 90% of the pot.</div>
    </div>
    <div class="info-tile info-tile-online" data-reveal="fade-up" style="--reveal-delay: 0.45s">
      <div class="info-tile-multi"><span class="online-dot"></span><span id="onlineCount">—</span></div>
      <div class="info-tile-label">ONLINE NOW</div>
      <div class="info-tile-desc">Players in the<br>game right now.</div>
    </div>
  </div>
  </div><!-- /.home-screen -->

  <!-- ===== Detail sections (scroll below the first screen) ===== -->
  <div class="home-more">

    <!-- How a match works -->
    <section class="hm-section">
      <div class="hm-head" data-reveal="fade-up">
        <div class="hm-kicker">From Wallet to Victory</div>
        <h2 class="hm-title">How a Match Works</h2>
      </div>
      <div class="hm-grid">
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.05s">
          <div class="hm-card-num">01</div>
          <div class="hm-card-title">Connect</div>
          <p class="hm-card-desc">Link your Solana wallet — Phantom, Backpack, or Brave. One wallet maps to one active match at a time.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.15s">
          <div class="hm-card-num">02</div>
          <div class="hm-card-title">Stake</div>
          <p class="hm-card-desc">Put <strong>2,500 $FIGHT10</strong> into the match escrow. Your seat is granted only after the stake is verified on-chain.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.25s">
          <div class="hm-card-num">03</div>
          <div class="hm-card-title">Fight</div>
          <p class="hm-card-desc">Drop into the arena. Everyone spawns with the same health, attack and weapons — the only difference is skill.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.35s">
          <div class="hm-card-num">04</div>
          <div class="hm-card-title">Get Paid</div>
          <p class="hm-card-desc">Be the last one standing and the escrow pays you <strong>90% of the pot</strong>, straight to your wallet.</p>
        </div>
      </div>
    </section>

    <!-- Modes & stakes -->
    <section class="hm-section">
      <div class="hm-head" data-reveal="fade-up">
        <div class="hm-kicker">Pick Your Battle</div>
        <h2 class="hm-title">Modes &amp; Stakes</h2>
      </div>
      <div class="hm-grid">
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.05s">
          <div class="hm-card-title">Demo</div>
          <div class="hm-mode-players">VS The Computer</div>
          <div class="hm-mode-row"><span>Entry</span><span class="v">Free</span></div>
          <div class="hm-mode-row"><span>Stakes</span><span class="v">None</span></div>
          <div class="hm-mode-row"><span>For</span><span class="v">Learning the ropes</span></div>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.15s">
          <div class="hm-card-title">Duel</div>
          <div class="hm-mode-players">2 Players &middot; 5 Min</div>
          <div class="hm-mode-row"><span>Entry</span><span class="v">2,500</span></div>
          <div class="hm-mode-row"><span>Pot</span><span class="v">5,000</span></div>
          <div class="hm-mode-row"><span>Winner takes</span><span class="v gold">4,500</span></div>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.25s">
          <div class="hm-card-title">5-Player FFA</div>
          <div class="hm-mode-players">Free-For-All &middot; 7 Min</div>
          <div class="hm-mode-row"><span>Entry</span><span class="v">2,500</span></div>
          <div class="hm-mode-row"><span>Pot</span><span class="v">12,500</span></div>
          <div class="hm-mode-row"><span>Winner takes</span><span class="v gold">11,250</span></div>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.35s">
          <div class="hm-card-title">10-Player FFA</div>
          <div class="hm-mode-players">Free-For-All &middot; 10 Min</div>
          <div class="hm-mode-row"><span>Entry</span><span class="v">2,500</span></div>
          <div class="hm-mode-row"><span>Pot</span><span class="v">25,000</span></div>
          <div class="hm-mode-row"><span>Winner takes</span><span class="v gold">22,500</span></div>
        </div>
      </div>
      <p class="hm-note" data-reveal="fade-up">All amounts in <strong>$FIGHT10</strong>. If the timer runs out, the survivor with the highest HP takes the win. A <strong>10% protocol fee</strong> keeps the arena running.</p>
    </section>

    <!-- Battlefield: controls + hazards -->
    <section class="hm-section">
      <div class="hm-head" data-reveal="fade-up">
        <div class="hm-kicker">The Arena Gives No Favours</div>
        <h2 class="hm-title">Know the Battlefield</h2>
      </div>
      <div class="hm-cols">
        <div class="hm-panel" data-reveal="fade-right">
          <h3 class="hm-panel-title">Controls</h3>
          <div class="hm-row"><span>Move</span><span>click a tile</span></div>
          <div class="hm-row"><span>Attack / shoot</span><span>click the rival</span></div>
          <div class="hm-row"><span>Switch weapon</span><span>keys 1 &ndash; 4</span></div>
          <div class="hm-row"><span>Pan camera</span><span>click + drag</span></div>
          <div class="hm-row"><span>Zoom</span><span>mouse wheel</span></div>
          <div class="hm-row"><span>Menu</span><span>Esc</span></div>
        </div>
        <div class="hm-panel" data-reveal="fade-left">
          <h3 class="hm-panel-title">Hazards &amp; Rules</h3>
          <div class="hm-row"><span>Trees &amp; mountains</span><span>block movement &amp; deflect attacks</span></div>
          <div class="hm-row"><span>River</span><span>halves your speed &amp; damage</span></div>
          <div class="hm-row"><span>Loadout</span><span>everyone starts equal &mdash; same HP, attack &amp; weapons</span></div>
          <div class="hm-row"><span>Win</span><span>last one standing takes 90% of the pot</span></div>
          <div class="hm-row"><span>Time runs out</span><span>highest HP survivor wins</span></div>
          <div class="hm-row"><span>Leaving early</span><span>forfeits your stake to the pot</span></div>
        </div>
      </div>
    </section>

    <!-- Progression -->
    <section class="hm-section">
      <div class="hm-head" data-reveal="fade-up">
        <div class="hm-kicker">Every Match Counts</div>
        <h2 class="hm-title">Climb the Ranks</h2>
      </div>
      <div class="hm-grid">
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.05s">
          <div class="hm-card-num">+10</div>
          <div class="hm-card-title">Play a Match</div>
          <p class="hm-card-desc">Every fight earns points — win or lose, you're always moving up.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.15s">
          <div class="hm-card-num">+60</div>
          <div class="hm-card-title">Win a Match</div>
          <p class="hm-card-desc">Victories carry the real weight on your ledger.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.25s">
          <div class="hm-card-num">&times;</div>
          <div class="hm-card-title">Win Streak</div>
          <p class="hm-card-desc">+10 points per consecutive win — the bonus escalates the longer you hold it. One loss resets it.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.35s">
          <div class="hm-card-num">L5</div>
          <div class="hm-card-title">Level Up</div>
          <p class="hm-card-desc">L2 at 100 pts &middot; L3 at 300 &middot; L4 at 600 &middot; L5 at 1000 &mdash; and it keeps climbing.</p>
        </div>
      </div>
    </section>

    <!-- Fairness / security -->
    <section class="hm-section">
      <div class="hm-head" data-reveal="fade-up">
        <div class="hm-kicker">The House Can't Cheat. Neither Can They.</div>
        <h2 class="hm-title">Built Fair</h2>
      </div>
      <div class="hm-grid">
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.05s">
          <div class="hm-card-title">On-Chain Escrow</div>
          <p class="hm-card-desc">Stakes sit in a program-controlled escrow. Payouts are the only outflow — gated by a verified, finished match.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.15s">
          <div class="hm-card-title">Verified Admission</div>
          <p class="hm-card-desc">A seat is granted only after your stake is re-checked on-chain. No deposit, no entry — the browser can't self-admit.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.25s">
          <div class="hm-card-title">Server-Decided Results</div>
          <p class="hm-card-desc">No client reports its own survival. The server derives every fighter's health from what opponents dealt.</p>
        </div>
        <div class="hm-card" data-reveal="fade-up" style="--reveal-delay: 0.35s">
          <div class="hm-card-title">Cheaters Forfeit</div>
          <p class="hm-card-desc">Impossible output excludes a fighter from winning — the best clean player still wins, and the cheater's stake stays in the pot.</p>
        </div>
      </div>
      <div class="hm-more-link" data-reveal="fade-up">
        <button class="home-btn home-btn-secondary" id="hmWhitepaperBtn" type="button">Read the Whitepaper</button>
      </div>
    </section>

    <!-- Final call to action -->
    <section class="hm-cta">
      <h2 class="hm-cta-title" data-reveal="zoom">Ready to Fight?</h2>
      <p class="hm-cta-sub" data-reveal="fade-up" style="--reveal-delay: 0.1s">2,500 $FIGHT10 buys your seat. Skill pays the rest.</p>
      <div class="hm-cta-actions" data-reveal="fade-up" style="--reveal-delay: 0.2s">
        <button class="home-btn home-btn-primary" id="ctaPlayBtn" type="button">PLAY PVP</button>
        <button class="home-btn home-btn-secondary" id="ctaHowToBtn" type="button">HOW TO PLAY</button>
      </div>
      <div class="hm-footer">FIGHT10 &middot; LAST ONE STANDING &mdash; skill-based arena on Solana. Winner takes 90% of the pot; a 10% protocol fee funds the arena. Entries are non-refundable once a match is joined.</div>
    </section>

  </div><!-- /.home-more -->
`;
