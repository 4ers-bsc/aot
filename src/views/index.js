import { html as homeHtml }        from './home.js';
import { html as pvpSizeHtml }     from './pvpSize.js';
import { html as roomBrowserHtml } from './roomBrowser.js';
import { html as lobbyHtml }       from './lobby.js';
import { html as gameOverHtml }    from './gameOver.js';
import { html as profileHtml }     from './profile.js';
import { html as pauseHtml }       from './pause.js';
import { html as howToHtml }       from './howToPlay.js';

export function mountViews() {
  document.getElementById('views-root').innerHTML = [
    homeHtml,
    pvpSizeHtml,
    roomBrowserHtml,
    lobbyHtml,
    gameOverHtml,
    profileHtml,
    pauseHtml,
    howToHtml,
  ].join('');
}
