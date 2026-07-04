export const html = `
  <!-- Game over -->
  <div class="game-over hidden" id="gameOver">
    <div class="game-over-card">
      <div class="go-brand">
        <img class="go-logo" src="/logo.png" alt="FIGHT10" />
      </div>
      <div class="game-over-title" id="gameOverTitle">VICTORY</div>
      <div class="go-matchno hidden" id="gameOverMatchNo"></div>
      <div class="game-over-reason" id="gameOverReason"></div>
      <div class="game-over-prize hidden" id="gameOverPrize">
        <div class="go-prize-label">YOU WON</div>
        <div class="go-prize-amount" id="gameOverPrizeAmount">Processing payout…</div>
        <a class="go-prize-tx hidden" id="gameOverTxLink" href="#" target="_blank" rel="noopener noreferrer">View transaction ↗</a>
      </div>
      <div class="go-summary">
        <div class="go-summary-item">
          <svg class="go-tile-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
          <div class="go-tile-body">
            <span class="go-summary-num" id="gameOverKills">0</span>
            <span class="go-summary-label">Kills</span>
          </div>
        </div>
        <div class="go-summary-item">
          <svg class="go-tile-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>
          <div class="go-tile-body">
            <span class="go-summary-num" id="gameOverTime">0:00</span>
            <span class="go-summary-label">Time</span>
          </div>
        </div>
      </div>
      <div class="standings-list" id="gameOverStandings"></div>
      <div class="game-over-stats">
        <div class="go-name" id="gameOverName">Trench Rookie</div>
        <div class="go-record">
          <div class="go-stat go-win">
            <svg class="go-tile-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
            <div class="go-tile-body">
              <span class="go-num" id="gameOverWins">0</span>
              <span class="go-label">Wins</span>
            </div>
          </div>
          <div class="go-stat go-loss">
            <svg class="go-tile-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l8 3.5V12c0 4.8-3.3 8.4-8 10-4.7-1.6-8-5.2-8-10V5.5z"/></svg>
            <div class="go-tile-body">
              <span class="go-num" id="gameOverLosses">0</span>
              <span class="go-label">Losses</span>
            </div>
          </div>
        </div>
      </div>
      <button class="game-over-retry hidden" id="gameOverRetryBtn" type="button">Retry Payout</button>
      <button class="game-over-menu hidden" id="gameOverMenuBtn" type="button">Main Menu</button>
    </div>
  </div>
`;
