export const html = `
  <!-- PvP waiting lobby -->
  <div class="pvp-lobby hidden" id="pvpLobby">
    <div class="pvp-lobby-card">
      <div class="pvp-lobby-title">FINDING MATCH</div>
      <div class="pvp-lobby-spinner">
        <div class="pvp-spinner-ring"></div>
      </div>
      <div class="pvp-lobby-status" id="pvpLobbyStatus">Searching for an opponent…</div>
      <div class="pvp-lobby-meta" id="pvpLobbyMeta"></div>
      <div class="pvp-prize-pool hidden" id="pvpPrizePool">
        Prize Pool: <span id="pvpPrizeAmount">—</span> $FIGHT10
      </div>
      <div class="lobby-players" id="lobbyPlayers"></div>
      <button class="pvp-lobby-cancel" id="pvpCancelBtn" type="button">Cancel</button>
    </div>
  </div>
`;
