export const html = `
  <!-- Profile -->
  <div class="overlay" id="profileOverlay">
    <div class="panel">
      <div class="panel-head">Profile<button class="close" id="profileClose" type="button">&times;</button></div>
      <div class="tabs">
        <button class="tab active" data-ptab="stats">STATS</button>
        <button class="tab" data-ptab="history">MATCH HISTORY</button>
      </div>

      <div class="tab-body" data-pbody="stats">
        <div class="ban-notice hidden" id="profileBanNotice">
          <div class="ban-notice-title">⚠ Account Banned</div>
          <div class="ban-notice-text" id="profileBanText">This wallet was banned for cheating and can no longer join matches.</div>
          <button class="profile-resolve" id="profileResolveBtn" type="button">Raise Resolution</button>
        </div>

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
