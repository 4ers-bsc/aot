// Inline stroke icons for the result-card stat tiles (crosshair / clock /
// trophy / shield). currentColor lets CSS theme them gold on victory.
const icoKills = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`;
const icoTime = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 6.5 12 12 15.5 14"/></svg>`;
const icoWins = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
const icoLosses = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.4 8-10V5l-8-3-8 3v7c0 6.6 8 10 8 10z"/></svg>`;

export const html = `
  <!-- Game over -->
  <div class="game-over hidden" id="gameOver">
    <div class="game-over-card">
      <div class="go-shine" aria-hidden="true"></div>
      <img class="go-logo" src="/logo.png" alt="FIGHT10" />
      <div class="game-over-title" id="gameOverTitle">VICTORY</div>
      <div class="go-matchno hidden" id="gameOverMatchNo"></div>
      <div class="game-over-reason" id="gameOverReason"></div>
      <div class="game-over-prize hidden" id="gameOverPrize">
        <div class="go-prize-label">YOU WON</div>
        <div class="go-prize-amount" id="gameOverPrizeAmount">Processing payout…</div>
        <a class="go-prize-tx hidden" id="gameOverTxLink" href="#" target="_blank" rel="noopener noreferrer">View transaction <span aria-hidden="true">↗</span></a>
      </div>
      <div class="go-summary">
        <div class="go-summary-item">
          <span class="go-tile-icon" aria-hidden="true">${icoKills}</span>
          <span class="go-tile-col">
            <span class="go-summary-num" id="gameOverKills">0</span>
            <span class="go-summary-label">Kills</span>
          </span>
        </div>
        <div class="go-summary-item">
          <span class="go-tile-icon" aria-hidden="true">${icoTime}</span>
          <span class="go-tile-col">
            <span class="go-summary-num" id="gameOverTime">0:00</span>
            <span class="go-summary-label">Time</span>
          </span>
        </div>
      </div>
      <div class="standings-list" id="gameOverStandings"></div>
      <div class="game-over-stats">
        <div class="go-name" id="gameOverName">Trench Rookie</div>
        <div class="go-record">
          <div class="go-stat go-win">
            <span class="go-tile-icon" aria-hidden="true">${icoWins}</span>
            <span class="go-tile-col">
              <span class="go-num" id="gameOverWins">0</span>
              <span class="go-label">Wins</span>
            </span>
          </div>
          <div class="go-stat go-loss">
            <span class="go-tile-icon" aria-hidden="true">${icoLosses}</span>
            <span class="go-tile-col">
              <span class="go-num" id="gameOverLosses">0</span>
              <span class="go-label">Losses</span>
            </span>
          </div>
        </div>
      </div>
      <button class="game-over-retry hidden" id="gameOverRetryBtn" type="button">Retry Payout</button>
      <button class="game-over-menu hidden" id="gameOverMenuBtn" type="button">Main Menu</button>
    </div>
  </div>
`;
