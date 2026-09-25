export const html = `
  <!-- Leaderboard — top fighters by points, wins / win%, and $GULAG held -->
  <div class="overlay" id="leaderboardOverlay">
    <div class="panel">
      <div class="panel-head">Leaderboard<button class="close" id="leaderboardClose" type="button">&times;</button></div>
      <div class="tabs">
        <button class="tab active" data-lbtab="points">POINTS</button>
        <button class="tab" data-lbtab="wins">WINS</button>
        <button class="tab" data-lbtab="holdings">$GULAG</button>
      </div>
      <div class="tab-body">
        <div class="lb-filter">
          <input id="leaderboardFilter" type="text" placeholder="Filter by name or wallet" autocomplete="off" spellcheck="false" />
          <button class="lb-me-btn" id="leaderboardMeBtn" type="button">YOUR WALLET</button>
        </div>
        <div class="section" id="leaderboardTitle">TOP FIGHTERS &middot; POINTS</div>
        <div class="lb-list" id="leaderboardList">
          <div class="lb-empty">Loading&hellip;</div>
        </div>
      </div>
    </div>
  </div>
`;
