export const html = `
  <!-- Profile -->
  <div class="overlay" id="profileOverlay">
    <div class="panel">
      <div class="panel-head">Profile<button class="close" id="profileClose" type="button">&times;</button></div>
      <div class="tabs">
        <button class="tab active" data-ptab="stats">STATS</button>
        <button class="tab" data-ptab="holdings">$FIGHT10</button>
        <button class="tab" data-ptab="appearance">APPEARANCE</button>
        <button class="tab" data-ptab="history">MATCH HISTORY</button>
      </div>

      <div class="tab-body" data-pbody="stats">
        <label class="profile-label" for="profileNameInput">Username</label>
        <input id="profileNameInput" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="3–24 characters" />
        <div class="profile-hint" id="profileHint">Saved to your wallet profile.</div>

        <div class="level-block">
          <div class="level-top">
            <span class="level-badge">LVL <span id="profileLevel">1</span></span>
            <span class="level-pts"><span id="profilePoints">0</span> PTS</span>
          </div>
          <div class="level-bar"><div class="level-fill" id="profileLevelFill"></div></div>
          <div class="level-next" id="profileLevelNext">0 / 100 to level 2</div>
        </div>

        <div class="divider"></div>
        <div class="profile-stats">
          <div class="go-stat go-win"><span class="go-num" id="profileWins">0</span><span class="go-label">Wins</span></div>
          <div class="go-stat go-loss"><span class="go-num" id="profileLosses">0</span><span class="go-label">Losses</span></div>
          <div class="go-stat"><span class="go-num" id="profileWinRate">0%</span><span class="go-label">Win Rate</span></div>
        </div>
        <div class="profile-stats">
          <div class="go-stat"><span class="go-num" id="profileGames">0</span><span class="go-label">Games</span></div>
          <div class="go-stat"><span class="go-num" id="profileStreak">0</span><span class="go-label">Streak</span></div>
          <div class="go-stat"><span class="go-num" id="profileBest">0</span><span class="go-label">Best Streak</span></div>
        </div>
        <button class="profile-save" id="profileSaveBtn" type="button">Save Username</button>
      </div>

      <div class="tab-body hidden" data-pbody="holdings">
        <div class="section">YOUR HOLDINGS</div>
        <div class="holdings-card">
          <div class="holdings-coin">F10</div>
          <div class="holdings-amount" id="holdingsAmount">&mdash;</div>
          <div class="holdings-token">$FIGHT10</div>
          <div class="holdings-wallet" id="holdingsWallet"></div>
          <div class="holdings-note" id="holdingsNote"></div>
        </div>

        <div class="section">HOLDER PERKS</div>
        <div class="perks-card">
          <div class="perks-coming"><span class="coming-soon-pill pill-lg">COMING SOON</span></div>
          <div class="perk-row perk-row-center">
            <svg class="perk-lock" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          </div>
        </div>
      </div>

      <div class="tab-body hidden" data-pbody="appearance">
        <div class="appearance-preview" id="appearancePreview"></div>
        <div class="section">SKINS</div>
        <div class="skin-cards" id="skinCards">
          <button class="skin-card" type="button" data-skin="1"><span class="skin-card-num">1</span><span class="skin-card-name">FIGHTER</span></button>
          <button class="skin-card" type="button" data-skin="2"><span class="skin-card-num">2</span><span class="skin-card-name">KNIGHT</span></button>
        </div>
      </div>

      <div class="tab-body hidden" data-pbody="history">
        <div class="section">PORTFOLIO</div>
        <div class="portfolio-summary">
          <span class="pf-win" id="pfWins">0 W</span>
          <span class="pf-loss" id="pfLosses">0 L</span>
        </div>
        <div class="history-list" id="historyList">
          <div class="history-empty">No matches played yet.</div>
        </div>
      </div>
    </div>
  </div>
`;
