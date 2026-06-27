export const html = `
  <!-- Game over -->
  <div class="game-over hidden" id="gameOver">
    <div class="game-over-card">
      <img class="go-logo" src="/logo.png" alt="FIGHT10" />
      <div class="game-over-title" id="gameOverTitle">VICTORY</div>
      <div class="game-over-reason" id="gameOverReason"></div>
      <div class="game-over-prize hidden" id="gameOverPrize">
        <div class="go-prize-label">YOU WON</div>
        <div class="go-prize-amount" id="gameOverPrizeAmount">Processing payout…</div>
      </div>
      <div class="go-summary">
        <div class="go-summary-item">
          <img class="go-summary-icon" src="/sword.png" alt="Kills" />
          <span class="go-summary-num" id="gameOverKills">0</span>
          <span class="go-summary-label">Kills</span>
        </div>
        <div class="go-summary-item">
          <span class="go-summary-num" id="gameOverTime">0:00</span>
          <span class="go-summary-label">Time</span>
        </div>
      </div>
      <div class="standings-list" id="gameOverStandings"></div>
      <div class="game-over-stats">
        <div class="go-name" id="gameOverName">Trench Rookie</div>
        <div class="go-record">
          <div class="go-stat go-win">
            <span class="go-num" id="gameOverWins">0</span>
            <span class="go-label">Wins</span>
          </div>
          <div class="go-stat go-loss">
            <span class="go-num" id="gameOverLosses">0</span>
            <span class="go-label">Losses</span>
          </div>
        </div>
      </div>
      <button class="game-over-retry hidden" id="gameOverRetryBtn" type="button">Retry Payout</button>
      <button class="game-over-menu hidden" id="gameOverMenuBtn" type="button">Main Menu</button>
    </div>
  </div>
`;
