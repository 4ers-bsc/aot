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
      <div class="pvp-lobby-online"><span class="online-dot"></span><span id="pvpLobbyOnline">— players online</span></div>
      <div class="pvp-prize-pool hidden" id="pvpPrizePool">
        Winner takes: <span id="pvpPrizeAmount">—</span> $FIGHT10 <span class="pvp-prize-note">(90% of the pot)</span>
      </div>
      <div class="lobby-players" id="lobbyPlayers"></div>
      <div class="pvp-lobby-warning hidden" id="pvpLobbyWarning">
        ⚠ Entry fee paid. Leaving the queue will NOT refund your 10,000 $FIGHT10.
      </div>
      <button class="pvp-lobby-cancel" id="pvpCancelBtn" type="button">Cancel</button>
    </div>
  </div>
`;
