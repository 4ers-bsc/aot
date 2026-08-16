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

// Each selectable option maps to the class — or space-separated classes —
// applied to #homeSections. Composed entries pair a base theme with the
// generic monochrome modifier (`.hs-mono`), which drains that exact design to
// black/white/grey. Anything else (including a stale value from an older
// build) is ignored and falls back to the classic (no-class) look.
const OPTIONS = [
  "hs-theme-neon",
  "hs-theme-brutal",
  "hs-theme-aurora",
  "hs-theme-terminal",
  "hs-theme-deco",
  "hs-theme-mono",
  "hs-theme-terminal hs-mono",
  "hs-theme-deco hs-mono",
];

// Every class the picker might add, flattened from OPTIONS for reliable
// cleanup before applying a new selection.
const ALL_CLASSES = [...new Set(OPTIONS.flatMap((o) => o.split(" ")))];

function readSaved() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && OPTIONS.includes(v) ? v : "";
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
    ALL_CLASSES.forEach((c) => sections.classList.remove(c));
    if (value) value.split(" ").forEach((c) => sections.classList.add(c));
  };

  const saved = readSaved();
  if (saved) {
    apply(saved);
    select.value = saved;
  }

  select.addEventListener("change", () => {
    const value = OPTIONS.includes(select.value) ? select.value : "";
    apply(value);
    save(value);
  });
}
