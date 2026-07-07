export const html = `
  <!-- Compulsory username prompt — shown after wallet connect until a name is saved.
       Deliberately has no close button: it can only be dismissed by saving. -->
  <div class="overlay" id="usernameOverlay">
    <div class="panel">
      <div class="panel-head">Choose Your Username</div>
      <div class="tab-body">
        <label class="profile-label" for="usernameInput">Username</label>
        <input id="usernameInput" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="3&ndash;24 characters" />
        <div class="profile-hint" id="usernameHint">Pick the name your rivals will see. You can change it later in your profile.</div>
        <button class="profile-save" id="usernameSaveBtn" type="button">Save Username</button>
      </div>
    </div>
  </div>
`;
