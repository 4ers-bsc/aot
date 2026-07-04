export const html = `
  <!-- Buy $FIGHT10 — shown when a wallet can't cover the 2,500 PvP entry fee -->
  <div class="overlay" id="buyFight10Overlay">
    <div class="panel">
      <div class="panel-head">Get $FIGHT10<button class="close" id="buyFight10Close" type="button">&times;</button></div>
      <div class="tab-body buyf10-body">
        <div class="holdings-coin">F10</div>
        <div class="buyf10-title">You need <span class="buyf10-amount">2,500 $FIGHT10</span> to enter a PvP match.</div>
        <div class="buyf10-balance" id="buyFight10Balance"></div>
        <a class="buyf10-btn" id="buyFight10Link" href="https://pump.fun" target="_blank" rel="noopener noreferrer">BUY $FIGHT10</a>
        <div class="buyf10-note">Buy with your connected wallet, then come back and hit PLAY PVP.</div>
      </div>
    </div>
  </div>
`;
