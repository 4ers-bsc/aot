// First-visit home tutorial.
//
// A short, multi-step guided walkthrough shown once when the home page first
// loads. The player can page through the steps, skip it, or tick "Don't show
// this again" — the latter persists to localStorage so returning players are
// never interrupted twice. The whole module is best-effort: any failure (no
// DOM, private-mode storage throwing) simply means no tutorial, never a broken
// home screen.

const SEEN_KEY = "f10_tutorial_seen";

function hasSeenTutorial() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch (_) {
    return false; // private mode: show it, just don't persist
  }
}

function markTutorialSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch (_) { /* private mode — nothing to persist */ }
}

// Show the tutorial when the home page loads unless the player has dismissed it.
// Waits for the loading splash to lift so the walkthrough greets a settled page
// rather than the boot spinner. Safe to call unconditionally at startup.
export function initHomeTutorial({ force = false } = {}) {
  const overlay = document.getElementById("tutorialOverlay");
  if (!overlay) return;
  if (!force && hasSeenTutorial()) return;

  const steps = Array.from(overlay.querySelectorAll(".tut-step"));
  const dotsWrap = document.getElementById("tutorialDots");
  const backBtn = document.getElementById("tutorialBackBtn");
  const nextBtn = document.getElementById("tutorialNextBtn");
  const closeBtn = document.getElementById("tutorialClose");
  const dontShow = document.getElementById("tutorialDontShow");
  if (!steps.length || !backBtn || !nextBtn) return;

  let current = 0;

  // Build one progress dot per step.
  if (dotsWrap && !dotsWrap.childElementCount) {
    steps.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "tut-dot";
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-label", `Step ${i + 1} of ${steps.length}`);
      dot.addEventListener("click", () => render(i));
      dotsWrap.appendChild(dot);
    });
  }
  const dots = dotsWrap ? Array.from(dotsWrap.children) : [];

  function render(i) {
    current = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach((s, idx) => s.classList.toggle("is-active", idx === current));
    dots.forEach((d, idx) => d.classList.toggle("is-active", idx === current));
    backBtn.classList.toggle("is-hidden", current === 0);
    nextBtn.textContent = current === steps.length - 1 ? "START FIGHTING" : "NEXT";
  }

  function close() {
    overlay.classList.remove("show");
    // A tick of "Don't show this again", OR simply reaching/closing the last
    // step, marks it seen. Closing early without the checkbox lets it reappear
    // on the next visit — the player hasn't opted out yet.
    if (dontShow?.checked || current === steps.length - 1) markTutorialSeen();
  }

  backBtn.addEventListener("click", () => render(current - 1));
  nextBtn.addEventListener("click", () => {
    if (current === steps.length - 1) close();
    else render(current + 1);
  });
  closeBtn?.addEventListener("click", close);
  // Backdrop click and Esc close it too (matches the app's other overlays).
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("show")) {
      e.stopPropagation();
      close();
    }
  }, true);

  render(0);

  // Reveal once the boot splash has lifted so the tutorial isn't stacked on top
  // of the loading screen. If the splash is already gone, show right away.
  const splash = document.getElementById("appLoading");
  const show = () => overlay.classList.add("show");
  if (!splash || splash.classList.contains("fade-out") || !splash.isConnected) {
    show();
  } else {
    const watch = new MutationObserver(() => {
      if (!splash.isConnected || splash.classList.contains("fade-out")) {
        watch.disconnect();
        show();
      }
    });
    watch.observe(splash, { attributes: true, attributeFilter: ["class"] });
    watch.observe(document.body, { childList: true });
  }
}
