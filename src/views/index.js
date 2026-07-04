import { html as homeHtml }      from './home.js';
import { html as pvpSizeHtml }   from './pvpSize.js';
import { html as lobbyHtml }     from './lobby.js';
import { html as gameOverHtml }  from './gameOver.js';
import { html as profileHtml }   from './profile.js';
import { html as pauseHtml }     from './pause.js';
import { html as howToHtml }     from './howToPlay.js';
import { html as whitepaperHtml } from './whitepaper.js';
import { html as leaderboardHtml } from './leaderboard.js';
import { html as buyFight10Html } from './buyFight10.js';

export function mountViews() {
  document.getElementById('views-root').innerHTML = [
    homeHtml,
    pvpSizeHtml,
    lobbyHtml,
    gameOverHtml,
    profileHtml,
    pauseHtml,
    howToHtml,
    whitepaperHtml,
    leaderboardHtml,
    buyFight10Html,
  ].join('');
}
