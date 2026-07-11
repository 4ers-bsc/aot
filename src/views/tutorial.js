export const html = `
  <!-- First-visit tutorial — a short guided walkthrough shown when the home
       page loads. A "Don't show this again" checkbox persists the dismissal to
       localStorage so returning players never see it twice. -->
  <div class="overlay tutorial-overlay" id="tutorialOverlay">
    <div class="panel tutorial-panel">
      <div class="panel-head">
        WELCOME TO FIGHT10
        <button class="close" id="tutorialClose" type="button" aria-label="Close tutorial">&times;</button>
      </div>

      <div class="tut-body">
        <!-- Steps — only the .is-active step is visible at a time. -->
        <div class="tut-step is-active" data-tut-step="0">
          <div class="tut-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2l7 7-10 10.5L4 12z"/><path d="M2 22l4-4"/></svg>
          </div>
          <div class="tut-step-title">LAST ONE STANDING</div>
          <div class="tut-step-text">FIGHT10 is a skill-based arena on Robinhood Chain, an Ethereum L2. Stake $FIGHT10, drop into a free-for-all, and be the last fighter alive to take <span class="hs-gold">90% of the pot</span>.</div>
        </div>

        <div class="tut-step" data-tut-step="1">
          <div class="tut-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 12h.01"/><path d="M2 10h20"/></svg>
          </div>
          <div class="tut-step-title">CONNECT &amp; STAKE</div>
          <div class="tut-step-text">Link your Ethereum wallet — MetaMask, Rabby, or Brave — and stake <span class="hs-gold">10,000 $FIGHT10</span> to claim your seat. Your entry is verified on-chain before the match begins.</div>
        </div>

        <div class="tut-step" data-tut-step="2">
          <div class="tut-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
          </div>
          <div class="tut-step-title">KNOW THE CONTROLS</div>
          <div class="tut-step-text">
            <div class="tut-controls">
              <div class="tut-ctrl-row"><span>Move</span><span class="k">click a tile</span></div>
              <div class="tut-ctrl-row"><span>Attack / shoot</span><span class="k">click the rival</span></div>
              <div class="tut-ctrl-row"><span>Switch weapon</span><span class="k">keys 1 – 4</span></div>
              <div class="tut-ctrl-row"><span>Menu</span><span class="k">Esc</span></div>
            </div>
          </div>
        </div>

        <div class="tut-step" data-tut-step="3">
          <div class="tut-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
          </div>
          <div class="tut-step-title">WIN &amp; CLIMB</div>
          <div class="tut-step-text">Everyone spawns equal — same health, same weapons. Outplay the arena to win the pot, earn points every match, and climb the leaderboard. Try a <span class="hs-gold">free Demo match</span> first to learn the ropes.</div>
        </div>
      </div>

      <div class="tut-foot">
        <div class="tut-dots" id="tutorialDots" role="tablist" aria-label="Tutorial progress"></div>
        <div class="tut-nav">
          <button class="tut-btn tut-btn-ghost" id="tutorialBackBtn" type="button">BACK</button>
          <button class="tut-btn tut-btn-primary" id="tutorialNextBtn" type="button">NEXT</button>
        </div>
        <label class="tut-dontshow">
          <input type="checkbox" id="tutorialDontShow" />
          <span>Don't show this again</span>
        </label>
      </div>
    </div>
  </div>
`;
