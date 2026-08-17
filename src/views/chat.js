export const html = `
  <!-- ===== Home chat popup ===== -->
  <!-- A fixed bottom-right broadcast chat. Everyone can read it + the live
       online count; only the host (admin) sees the composer and the poll
       controls. Hidden in-game via body.in-game (styles.css). -->
  <div class="home-chat collapsed" id="homeChat">
    <!-- Collapsed launcher chip -->
    <button class="home-chat-launcher" id="chatLauncher" type="button" aria-label="Open chat">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="home-chat-launcher-label">CHAT</span>
      <span class="home-chat-badge hidden" id="chatBadge">0</span>
    </button>

    <!-- Expanded panel -->
    <div class="home-chat-panel" id="chatPanel" role="dialog" aria-label="FIGHT10 chat">
      <div class="home-chat-head">
        <div class="home-chat-title">
          <span class="home-chat-title-main">ARENA CHAT</span>
          <span class="home-chat-online"><span class="online-dot"></span><span id="chatOnlineCount">—</span> online</span>
        </div>
        <button class="home-chat-min" id="chatCollapse" type="button" aria-label="Minimise chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>

      <!-- Live Yes/No poll (shown only while the host has a vote open) -->
      <div class="home-chat-poll hidden" id="chatPoll">
        <div class="hc-poll-q" id="chatPollQuestion"></div>
        <div class="hc-poll-vote">
          <button class="hc-vote hc-vote-yes" id="voteYesBtn" type="button">
            <span class="hc-vote-key">YES</span>
            <span class="hc-vote-count" id="voteYesCount">0</span>
          </button>
          <button class="hc-vote hc-vote-no" id="voteNoBtn" type="button">
            <span class="hc-vote-key">NO</span>
            <span class="hc-vote-count" id="voteNoCount">0</span>
          </button>
        </div>
        <div class="hc-poll-bar"><div class="hc-poll-bar-yes" id="chatPollBar"></div></div>
        <div class="hc-poll-foot"><span id="chatPollTotal">0 votes</span><span id="chatPollState"></span></div>
      </div>

      <!-- Host-only poll controls -->
      <div class="home-chat-admin hidden" id="chatAdmin">
        <div class="hc-admin-title">HOST · VOTE</div>
        <input class="hc-admin-input" id="chatPollInput" type="text" maxlength="200" autocomplete="off" placeholder="Ask a yes / no question…" />
        <div class="hc-admin-row">
          <button class="hc-admin-btn hc-admin-btn-go" id="chatPollOpenBtn" type="button">START VOTE</button>
          <button class="hc-admin-btn hc-admin-btn-stop hidden" id="chatPollCloseBtn" type="button">CLOSE VOTE</button>
        </div>
        <div class="hc-admin-hint" id="chatAdminHint"></div>
      </div>

      <!-- Message stream -->
      <div class="home-chat-messages" id="chatMessages" aria-live="polite">
        <div class="home-chat-empty" id="chatEmpty">No messages yet.</div>
      </div>

      <!-- Host-only composer -->
      <form class="home-chat-composer hidden" id="chatComposer" autocomplete="off">
        <input class="home-chat-input" id="chatInput" type="text" maxlength="2000" placeholder="Message everyone…" />
        <button class="home-chat-send" id="chatSendBtn" type="submit" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
      <!-- Read-only note for everyone else -->
      <div class="home-chat-readonly" id="chatReadonly">Broadcast channel — only the host posts here.</div>
    </div>
  </div>

  <!-- ===== First-sign-in onboarding: pick name + avatar ===== -->
  <div class="onboard-overlay" id="onboardOverlay">
    <div class="onboard-box">
      <div class="onboard-kicker">WELCOME TO FIGHT10</div>
      <h2 class="onboard-title">CLAIM YOUR IDENTITY</h2>
      <p class="onboard-sub">Pick a call sign and a fighter. You can change both later in your profile.</p>

      <label class="onboard-label" for="onboardName">CALL SIGN</label>
      <input class="onboard-input" id="onboardName" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="3–24 characters, unique" />
      <div class="onboard-hint" id="onboardHint"></div>

      <div class="onboard-label">FIGHTER</div>
      <div class="onboard-preview" id="onboardPreview"></div>
      <div class="onboard-skins" id="onboardSkins">
        <button class="onboard-skin" type="button" data-skin="1"><span class="onboard-skin-num">1</span><span class="onboard-skin-name">FIGHTER</span></button>
        <button class="onboard-skin" type="button" data-skin="2"><span class="onboard-skin-num">2</span><span class="onboard-skin-name">KNIGHT</span></button>
      </div>

      <button class="onboard-continue" id="onboardContinueBtn" type="button">ENTER THE ARENA</button>
    </div>
  </div>
`;
