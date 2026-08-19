export const html = `
  <!-- Landing chrome is one full-viewport flex column (hero grows, actions +
       info strip keep their natural height) so the bands can never overlap,
       whatever the viewport size. -->
  <div class="home-screen">
  <!-- ===== Hero ===== -->
  <section class="hero-section">
    <div class="hero-title-block">
      <div class="hero-big-fight">FIGHT</div>
      <div class="hero-big-10">10</div>
      <div class="hero-beta">BETA</div>
    </div>
    <div class="hero-tagline">
      <h2 class="hero-subtitle">LAST ONE STANDING</h2>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-value">10,000</div>
          <div class="hero-stat-label">$FIGHT10 Entry</div>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <div class="hero-stat-value">90%</div>
          <div class="hero-stat-label">Winner's Pot</div>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <div class="hero-stat-value">2 / 5 / 10</div>
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
      <div class="info-tile-multi">10,000 $FIGHT10</div>
      <div class="info-tile-label">ENTRY PER PLAYER</div>
      <div class="info-tile-desc">Last one standing<br>takes 90% of the pot.</div>
    </div>
    <div class="info-tile info-tile-online">
      <div class="info-tile-multi"><span class="online-dot"></span><span id="onlineCount">0</span></div>
      <div class="info-tile-label">ONLINE NOW</div>
      <div class="info-tile-desc">Players in the<br>game right now.</div>
    </div>
  </div>
  </div><!-- /.home-screen -->

  <!-- ===== Landing sections (below the fold) ===== -->
  <!-- Luxe Deco is the shipped look for the landing sections; the alternate
       hs-theme-* blocks in styles.css remain available by swapping this class. -->
  <div class="home-sections hs-theme-deco" id="homeSections">

    <!-- How a match works -->
    <section class="hs-block">
      <div class="hs-kicker">FROM WALLET TO VICTORY</div>
      <h2 class="hs-title">HOW A MATCH WORKS</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card">
          <div class="hs-card-num">01</div>
          <div class="hs-card-label">CONNECT</div>
          <div class="hs-card-desc">Link your Solana wallet. Phantom, Solflare or Backpack, on desktop or mobile. One wallet plays one match at a time.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">02</div>
          <div class="hs-card-label">PAY</div>
          <div class="hs-card-desc">Put 10,000 $FIGHT10 into the match escrow. Your seat is granted only after the payment clears on chain.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">03</div>
          <div class="hs-card-label">FIGHT</div>
          <div class="hs-card-desc">Drop into the arena. Everyone spawns with the same health, attack and weapons. The only edge is skill.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">04</div>
          <div class="hs-card-label">GET PAID</div>
          <div class="hs-card-desc">Be the last one standing and the escrow pays you 90% of the pot, straight to your wallet.</div>
        </div>
      </div>
    </section>

    <!-- Modes & pay -->
    <section class="hs-block">
      <div class="hs-kicker">PICK YOUR BATTLE</div>
      <h2 class="hs-title">MODES &amp; PAY</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card hs-mode">
          <div class="hs-mode-name">DEMO</div>
          <div class="hs-mode-sub">VS The Computer</div>
          <div class="hs-mode-row"><span>Entry</span><span>Free</span></div>
          <div class="hs-mode-row"><span>Pay</span><span>None</span></div>
          <div class="hs-mode-row"><span>For</span><span>Learning the ropes</span></div>
        </div>
        <div class="hs-card hs-mode">
          <div class="hs-mode-name">DUEL</div>
          <div class="hs-mode-sub">2 Players, 5 Min</div>
          <div class="hs-mode-row"><span>Entry</span><span>10,000</span></div>
          <div class="hs-mode-row"><span>Pot</span><span>20,000</span></div>
          <div class="hs-mode-row"><span>Winner takes</span><span class="hs-gold">18,000</span></div>
        </div>
        <div class="hs-card hs-mode">
          <div class="hs-mode-name">5 PLAYER FFA</div>
          <div class="hs-mode-sub">Free For All, 7 Min</div>
          <div class="hs-mode-row"><span>Entry</span><span>10,000</span></div>
          <div class="hs-mode-row"><span>Pot</span><span>50,000</span></div>
          <div class="hs-mode-row"><span>Winner takes</span><span class="hs-gold">45,000</span></div>
        </div>
        <div class="hs-card hs-mode">
          <div class="hs-mode-name">10 PLAYER FFA</div>
          <div class="hs-mode-sub">Free For All, 10 Min</div>
          <div class="hs-mode-row"><span>Entry</span><span>10,000</span></div>
          <div class="hs-mode-row"><span>Pot</span><span>100,000</span></div>
          <div class="hs-mode-row"><span>Winner takes</span><span class="hs-gold">90,000</span></div>
        </div>
      </div>
      <p class="hs-footnote">All amounts in <span class="hs-gold">$FIGHT10</span>. If the timer runs out, the survivor with the highest HP takes the win. A <span class="hs-gold">10% protocol fee</span> keeps the arena running.</p>
    </section>

    <!-- Know the battlefield -->
    <section class="hs-block">
      <div class="hs-kicker">THE ARENA GIVES NO FAVOURS</div>
      <h2 class="hs-title">KNOW THE BATTLEFIELD</h2>
      <div class="hs-grid hs-grid-2">
        <div class="hs-card hs-list">
          <div class="hs-card-label">CONTROLS</div>
          <div class="hs-list-row"><span>Move</span><span>click a tile</span></div>
          <div class="hs-list-row"><span>Attack or shoot</span><span>click the rival</span></div>
          <div class="hs-list-row"><span>Switch weapon</span><span>keys 1 to 4</span></div>
          <div class="hs-list-row"><span>Pan camera</span><span>click and drag</span></div>
          <div class="hs-list-row"><span>Zoom</span><span>mouse wheel, or pinch on mobile</span></div>
          <div class="hs-list-row"><span>Menu</span><span>Esc</span></div>
        </div>
        <div class="hs-card hs-list">
          <div class="hs-card-label">HAZARDS &amp; RULES</div>
          <div class="hs-list-row"><span>Trees &amp; mountains</span><span>block movement &amp; deflect attacks</span></div>
          <div class="hs-list-row"><span>River</span><span>halves your speed &amp; damage</span></div>
          <div class="hs-list-row"><span>Loadout</span><span>everyone starts equal, same HP, attack &amp; weapons</span></div>
          <div class="hs-list-row"><span>Win</span><span>last one standing takes 90% of the pot</span></div>
          <div class="hs-list-row"><span>Time runs out</span><span>highest HP survivor wins</span></div>
          <div class="hs-list-row"><span>Leaving early</span><span>forfeits your entry to the pot</span></div>
        </div>
      </div>
    </section>

    <!-- Identity & skins -->
    <section class="hs-block">
      <div class="hs-kicker">MAKE YOUR MARK</div>
      <h2 class="hs-title">YOUR NAME, YOUR FIGHTER</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card">
          <div class="hs-card-label">CALL SIGN</div>
          <div class="hs-card-desc">Claim a name on your first sign in, 3 to 24 characters and one of a kind. It rides with you into every arena and up the leaderboard.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">FIGHTER SKINS</div>
          <div class="hs-card-desc">Choose your look. FIGHTER or KNIGHT for now, both in black and gold. Swap it anytime from your profile.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">YOUR PROFILE</div>
          <div class="hs-card-desc">Track wins, losses, win rate, games, current streak and best streak. Your holdings and full match history live here too.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">HOLDER PERKS</div>
          <div class="hs-card-desc">Holding $FIGHT10 opens more. Exclusive skins, holder tournaments, airdrops and rewards are on the way.</div>
        </div>
      </div>
    </section>

    <!-- Community room -->
    <section class="hs-block">
      <div class="hs-kicker">NOBODY FIGHTS ALONE</div>
      <h2 class="hs-title">THE ROOM IS LIVE</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card">
          <div class="hs-card-label">DEV CHAT</div>
          <div class="hs-card-desc">A broadcast channel sits in the corner of the home screen. Everyone reads the stream, signed in or not.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">WHO IS ONLINE</div>
          <div class="hs-card-desc">A live count shows how many players are in the game right now, on the home screen and in chat.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">LIVE VOTES</div>
          <div class="hs-card-desc">The host opens a yes or no question and every signed in player votes. The tally moves for the whole room in real time.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">ALWAYS ON</div>
          <div class="hs-card-desc">Chat stays live even when matches pause for maintenance, so you always know when the arena is back.</div>
        </div>
      </div>
    </section>

    <!-- Progression -->
    <section class="hs-block">
      <div class="hs-kicker">EVERY MATCH COUNTS</div>
      <h2 class="hs-title">CLIMB THE RANKS</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card">
          <div class="hs-card-num">+10</div>
          <div class="hs-card-label">PLAY A MATCH</div>
          <div class="hs-card-desc">Every fight earns points. Win or lose, you are always moving up.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">+60</div>
          <div class="hs-card-label">WIN A MATCH</div>
          <div class="hs-card-desc">Victories carry the real weight on your ledger.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">&times;</div>
          <div class="hs-card-label">WIN STREAK</div>
          <div class="hs-card-desc">+10 points per win in a row, and the bonus escalates the longer you hold it. One loss resets it.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-num">L5</div>
          <div class="hs-card-label">LEVEL UP</div>
          <div class="hs-card-desc">L2 at 100 pts, L3 at 300, L4 at 600, L5 at 1000, and it keeps climbing.</div>
        </div>
      </div>
    </section>

    <!-- Fairness -->
    <section class="hs-block">
      <div class="hs-kicker">THE HOUSE CAN'T CHEAT. NEITHER CAN THEY.</div>
      <h2 class="hs-title">BUILT FAIR</h2>
      <div class="hs-grid hs-grid-4">
        <div class="hs-card">
          <div class="hs-card-label">ESCROW ON CHAIN</div>
          <div class="hs-card-desc">Your entry sits in escrow on chain. A payout to the winner of a finished match is the only way out.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">VERIFIED ADMISSION</div>
          <div class="hs-card-desc">A seat is granted only after your entry clears on chain. No entry, no seat.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">RESULTS DECIDED FAIRLY</div>
          <div class="hs-card-desc">No player reports their own survival. The game works out every fighter's health from the fight itself.</div>
        </div>
        <div class="hs-card">
          <div class="hs-card-label">CHEATERS FORFEIT</div>
          <div class="hs-card-desc">Do the impossible and you are dropped from winner selection. The best clean player still wins, and the cheat's entry stays in the pot.</div>
        </div>
      </div>
      <div class="hs-center">
        <button class="home-btn home-btn-secondary" id="secWhitepaperBtn" type="button">READ THE WHITEPAPER</button>
      </div>
    </section>

    <!-- Final CTA -->
    <section class="hs-block hs-cta">
      <h2 class="hs-cta-title">GL, HF!</h2>
      <p class="hs-cta-sub">10,000 $FIGHT10 buys your seat. Skill pays the rest.</p>
      <div class="hs-cta-actions">
        <button class="home-btn home-btn-hero hs-cta-play" id="secPlayBtn" type="button">PLAY PVP</button>
        <button class="home-btn home-btn-secondary" id="secHowToBtn" type="button">HOW TO PLAY</button>
      </div>
    </section>

    <footer class="hs-footer">
      <div class="hs-footer-disclaimer">FOR ENTERTAINMENT PURPOSES ONLY. FIGHT10 is purely for entertainment. All $FIGHT10 amounts are show values displayed at token scale and carry no guaranteed real world or monetary value. Nothing here is financial advice.</div>
      <div class="hs-footer-text">FIGHT10, LAST ONE STANDING. A skill based arena on Solana. Winner takes 90% of the pot and a 10% protocol fee funds the arena. Once you join a match your entry cannot be refunded.</div>
      <a class="hs-footer-x" href="https://x.com/fight10_club" target="_blank" rel="noopener noreferrer" aria-label="FIGHT10 on X">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        @fight10_club
      </a>
    </footer>
  </div><!-- /.home-sections -->

  <!-- Scroll cue: bottom-right hint that there's more below the fold -->
  <button class="scroll-cue" id="scrollCue" type="button" aria-label="Scroll down for details">
    <span class="scroll-cue-text">SCROLL</span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
`;
