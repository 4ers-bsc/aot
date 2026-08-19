export const html = `
  <!-- Whitepaper / overview -->
  <div class="overlay" id="whitepaperOverlay">
    <div class="panel panel-wide">
      <div class="panel-head">Whitepaper<button class="close" id="whitepaperClose" type="button">&times;</button></div>
      <div class="tab-body wp-body">

        <p class="wp-intro">
          FIGHT10 is a skill based, last one standing arena on Solana. Every
          fighter spawns identical and every player pays the same entry. The
          winner takes 90% of the pot and a 10% protocol fee funds the arena.
          This page walks through how it all works, from your first sign in to
          the payout.
        </p>

        <div class="wp-section">01 What FIGHT10 is</div>
        <p class="wp-text">
          An arena where the only edge is skill. Everyone drops in with the same
          health, the same four weapons and the same stats, so nothing you buy
          can win a fight for you. Play a free Demo against the computer, or jump
          into PvP as a duel, a five player free for all, or a ten player free
          for all. Be the last fighter standing to take the pot. If the timer
          runs out, the survivor with the highest health takes the win.
        </p>

        <div class="wp-section">02 The token and the pot</div>
        <p class="wp-text">
          You enter a PvP match by paying 10,000 $FIGHT10, the in game token.
          Every entry for a match forms one pot. When the match is settled the
          pot goes to the sole survivor, less the 10% protocol fee that keeps the
          arena running. Entries cannot be refunded once you join a match, and
          leaving early forfeits your entry to the pot.
        </p>

        <div class="wp-section">03 How a match runs</div>
        <p class="wp-text">
          Getting into a fight takes three steps:
        </p>
        <div class="wp-flow">
          <div class="wp-step"><span>1</span> Connect your Solana wallet. Phantom, Solflare and Backpack all work, on desktop and on mobile.</div>
          <div class="wp-step"><span>2</span> Pay your entry into the match escrow. Your seat is granted only after the payment clears on chain.</div>
          <div class="wp-step"><span>3</span> Drop into the arena and fight. The last fighter alive wins the pot, paid straight to your wallet.</div>
        </div>
        <p class="wp-text">
          One wallet plays one match at a time.
        </p>

        <div class="wp-section">04 Fair by design</div>
        <p class="wp-text">FIGHT10 is built so the game runs the same for everyone and nobody can tilt a result.</p>
        <ul class="wp-list">
          <li><strong>Escrow on chain.</strong> Your entry sits in escrow. A payout to the winner of a finished match is the only way funds leave it.</li>
          <li><strong>Seats are earned.</strong> You are admitted only after your entry clears on chain, never before.</li>
          <li><strong>The game calls it.</strong> Results are decided by the game, not by any player's own report of how they did.</li>
          <li><strong>Cheating does not pay.</strong> A fighter caught doing the impossible is dropped from winner selection. The best clean player still wins, and the cheat loses their entry to the pot.</li>
        </ul>

        <div class="wp-section">05 Your identity and progress</div>
        <p class="wp-text">
          Your first sign in sets you up with a call sign and a fighter. Pick a
          name, 3 to 24 characters and one of a kind, and choose FIGHTER or
          KNIGHT. Change either one anytime from your profile. Every match adds
          points, wins push you up faster, and a win streak stacks a growing
          bonus until you lose. Points raise your level, and the leaderboard
          ranks everyone by points, wins or $FIGHT10 held. Filter it by name or
          wallet, or jump straight to your own.
        </p>

        <div class="wp-section">06 The community room</div>
        <p class="wp-text">
          The home screen carries a live broadcast, Dev Chat, sitting in the
          corner. Everyone reads the stream and the live online count, signed in
          or not. When the host opens a yes or no question, every signed in
          player gets a vote and the tally updates for the whole room in real
          time. Chat stays live even while matches are paused for maintenance, so
          you always know what is going on and when the arena is back.
        </p>

        <div class="wp-section">07 Holder perks</div>
        <p class="wp-text">
          Holding $FIGHT10 is set to open more over time. Playing PvP is live
          today, with exclusive skins, holder tournaments, airdrops and rewards
          on the way.
        </p>

        <p class="wp-foot">This page is informational and describes FIGHT10 at a high level. It is for entertainment and is not financial advice. All $FIGHT10 amounts are show values at token scale and carry no guaranteed real world or monetary value.</p>
      </div>
    </div>
  </div>
`;
