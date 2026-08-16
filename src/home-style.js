// Home-sections style previewer.
//
// Repaints the landing sections (#homeSections) with one of five alternate
// "looks" by toggling a single theme class, driven by the floating <select>
// baked into the home markup. The pick is remembered in localStorage so a
// reload keeps whatever you were previewing.
//
// Everything here is defensive: if the DOM nodes are missing or storage is
// blocked (private mode), it quietly does nothing and the classic default
// stays in place — the switcher can never leave the page broken.

const STORAGE_KEY = "fight10.hsStyle";

// The theme classes the picker is allowed to set. Anything else — including a
// stale value written by an older build — is ignored and falls back to the
// classic (no-class) look.
const THEMES = [
  "hs-theme-neon",
  "hs-theme-brutal",
  "hs-theme-aurora",
  "hs-theme-terminal",
  "hs-theme-deco",
  "hs-theme-mono",
];

function readSaved() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && THEMES.includes(v) ? v : "";
  } catch {
    return "";
  }
}

function save(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — the preview still works for this session */
  }
}

export function initHomeStylePicker() {
  const sections = document.getElementById("homeSections");
  const select = document.getElementById("hsStyleSelect");
  if (!sections || !select) return;

  const apply = (value) => {
    THEMES.forEach((t) => sections.classList.toggle(t, t === value));
  };

  const saved = readSaved();
  if (saved) {
    apply(saved);
    select.value = saved;
  }

  select.addEventListener("change", () => {
    const value = THEMES.includes(select.value) ? select.value : "";
    apply(value);
    save(value);
  });
}
