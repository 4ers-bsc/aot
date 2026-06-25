export const html = `
  <!-- In-game menu (Esc) -->
  <div class="overlay" id="pauseOverlay">
    <div class="panel pause-panel">
      <div class="panel-head">Menu<button class="close" id="pauseClose" type="button">&times;</button></div>
      <div class="tab-body">
        <button class="pause-btn pause-resume" id="resumeBtn" type="button">Resume</button>
        <button class="pause-btn" id="pauseHowToBtn" type="button">How to Play</button>
        <button class="pause-btn" id="pauseSettingsBtn" type="button">Settings</button>
        <button class="pause-btn pause-leave" id="leaveMatchBtn" type="button">Leave Match</button>
      </div>
    </div>
  </div>
`;
