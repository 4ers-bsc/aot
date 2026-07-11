// Site theme switcher. Every accent/fill in styles.css reads from CSS custom
// properties, so a theme is just a `data-theme` value on <html> that re-points
// those variables (see the theme blocks in styles.css). The default (gold)
// look uses no attribute at all.
//
// The chosen theme is persisted to localStorage and re-applied on the next
// visit. applyTheme() runs as early as main.js can call it, before the home
// swatches are wired, so there's no flash of the wrong palette.

const THEME_KEY = "f10_theme";
const THEMES = ["default", "robinhood"];

function normalize(name) {
  return THEMES.includes(name) ? name : "default";
}

export function getTheme() {
  try {
    return normalize(localStorage.getItem(THEME_KEY));
  } catch {
    return "default"; // private mode / storage blocked
  }
}

export function applyTheme(name) {
  const theme = normalize(name);
  const root = document.documentElement;
  // Default theme carries no attribute — it's the base :root palette.
  if (theme === "default") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore — theme just won't persist */
  }
  syncSwatches(theme);
}

function syncSwatches(theme) {
  document.querySelectorAll("#themeSwatches .theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeName === theme);
  });
}

// Apply the stored theme and wire the home-page picker. Safe to call once at
// boot, after the home view HTML has been mounted.
export function initTheme() {
  applyTheme(getTheme());
  const swatches = document.getElementById("themeSwatches");
  if (!swatches) return;
  swatches.addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-swatch");
    if (!btn) return;
    applyTheme(btn.dataset.themeName);
  });
}
