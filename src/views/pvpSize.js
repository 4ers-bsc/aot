export const html = `
  <!-- PvP size chooser -->
  <div class="overlay" id="pvpSizeOverlay">
    <div class="panel pvp-size-panel">
      <div class="panel-head">Choose Battle<button class="close" id="pvpSizeClose" type="button">&times;</button></div>
      <div class="tab-body">
        <p class="pvp-size-copy">Free-for-all — last fighter standing wins. The match begins once the room is full.</p>
        <div class="pvp-size-grid">
          <button class="pvp-size-btn" data-size="2" type="button">
            <span class="pvp-size-num">2</span>
            <span class="pvp-size-label">Duel</span>
            <span class="pvp-size-waiting" id="pvpWaiting2"></span>
          </button>
          <button class="pvp-size-btn" data-size="5" type="button">
            <span class="pvp-size-num">5</span>
            <span class="pvp-size-label">Skirmish</span>
            <span class="pvp-size-waiting" id="pvpWaiting5"></span>
          </button>
          <button class="pvp-size-btn" data-size="10" type="button">
            <span class="pvp-size-num">10</span>
            <span class="pvp-size-label">Warzone</span>
            <span class="pvp-size-waiting" id="pvpWaiting10"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
`;
