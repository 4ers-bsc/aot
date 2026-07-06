// Chrome themes. The active theme id lives in a data-theme attribute on
// <html> (set before first paint by an inline script in index.html) and
// styles.css keys its per-theme overrides off that attribute. "combat" is the
// original military look; "elegant" is the refined serif/gold look.
const THEME_KEY = "fight10.theme";

export const THEMES = [
  { id: "combat", label: "Combat" },
  { id: "elegant", label: "Elegant" },
];

export function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.some((x) => x.id === t) ? t : THEMES[0].id;
  } catch {
    return THEMES[0].id; // private mode / blocked storage
  }
}

export function applyTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = THEMES[0].id;
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(THEME_KEY, id); } catch { /* private mode */ }
  const label = document.getElementById("themeSwitchLabel");
  if (label) label.textContent = THEMES.find((t) => t.id === id).label;
  document.querySelectorAll("#themeMenu .theme-menu-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.theme === id)
  );
}

// Wires the nav theme dropdown: toggle on the button, pick on an item,
// close on click-away or Escape. Mirrors the hamburger menu behavior.
export function initThemeSwitch() {
  const wrap = document.getElementById("themeSwitch");
  const btn = document.getElementById("themeSwitchBtn");
  const menu = document.getElementById("themeMenu");
  if (!wrap || !btn || !menu) return;

  applyTheme(getTheme());

  const close = () => {
    menu.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // keep the document click-away handler from re-closing it
    const open = menu.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(!!open));
  });
  menu.querySelectorAll(".theme-menu-item").forEach((item) =>
    item.addEventListener("click", () => {
      applyTheme(item.dataset.theme);
      close();
    })
  );
  document.addEventListener("click", (e) => {
    if (menu.classList.contains("open") && !wrap.contains(e.target)) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("open")) close();
  });
}
