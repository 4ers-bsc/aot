export const html = `
  <!-- Buy $GULAG — shown when a wallet can't cover the 10,000 PvP entry fee -->
  <div class="overlay" id="buyGulagOverlay">
    <div class="panel">
      <div class="panel-head">Get $GULAG<button class="close" id="buyGulagClose" type="button">&times;</button></div>
      <div class="tab-body buygulag-body">
        <div class="holdings-coin">GULAG</div>
        <div class="buygulag-title">You need <span class="buygulag-amount">10,000 $GULAG</span> to enter a PvP match.</div>
        <div class="buygulag-balance" id="buyGulagBalance"></div>
        <a class="buygulag-btn" id="buyGulagLink" href="https://solscan.io" target="_blank" rel="noopener noreferrer">BUY $GULAG</a>
        <div class="buygulag-note">Buy with your connected wallet, then come back and hit PLAY PVP.</div>
      </div>
    </div>
  </div>
`;
