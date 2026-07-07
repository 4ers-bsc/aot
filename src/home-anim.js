// Homescreen animations — entrance reveals + scroll effects.
//
// Every marketing element on the landing screen (nav, hero wordmark, tagline,
// stats, action buttons, info tiles) gets a staggered reveal animation. The
// reveal is driven by an IntersectionObserver, so on the narrow scrolling
// layout anything below the fold animates in the moment it scrolls into view
// instead of having already played invisibly. On top of that, scrolling gets
// a light parallax/fade on the hero title and a shadow on the fixed nav.
//
// The whole module is a no-op for prefers-reduced-motion users, and if it
// never runs (script error, ancient browser) no class is ever added, so the
// home screen simply renders static — nothing can get stuck hidden.

// Reveal choreography. Each entry: [selector, variant, entrance delay ms,
// per-element stagger ms]. "Entrance" delays choreograph the initial sweep
// right after the loading splash lifts; elements revealed later by scrolling
// use a short local stagger instead (a tile shouldn't wait out the whole
// intro just because it was below the fold).
const GROUPS = [
  [".site-nav",                    "down",  0,    0],
  [".hero-big-fight",              "fight", 100,  0],
  [".hero-big-10",                 "stamp", 340,  0],
  [".hero-tagline",                "up",    540,  0],
  [".hero-stats > *",              "up",    660, 70],
  [".home-btn-hero:not(.hs-cta-play)", "rise", 720, 0],
  [".home-actions-row .home-btn",  "up",    840, 90],
  [".info-tile",                   "up",    940, 80],
  // Landing sections below the fold — revealed by scrolling, so the entrance
  // delay is irrelevant; only the local scroll stagger matters.
  [".hs-kicker",                   "up",    0,    0],
  [".hs-title",                    "up",    0,    0],
  [".hs-card",                     "up",    0,   60],
  [".hs-footnote",                 "up",    0,    0],
  [".hs-center",                   "up",    0,    0],
  [".hs-cta-title",                "up",    0,    0],
  [".hs-cta-sub",                  "up",    0,    0],
  [".hs-cta-actions",              "rise",  0,    0],
  [".hs-footer",                   "up",    0,    0],
];

// How long after an entrance starts we still honour the choreographed delays.
// Past this window a reveal was caused by scrolling, not by the page opening.
const ENTRANCE_WINDOW_MS = 2500;
const SCROLL_STAGGER_CAP_MS = 240;

export function initHomeAnimations() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // -- Scroll cue (bottom right) ---------------------------------------------
  // Wired even for reduced-motion users — it's navigation, not decoration:
  // clicking it jumps to the landing sections, and it fades away once the
  // page has actually been scrolled (the hint has served its purpose).
  const scrollCue = document.getElementById("scrollCue");
  const cueText = scrollCue?.querySelector(".scroll-cue-text");
  const sections = document.getElementById("homeSections");
  scrollCue?.addEventListener("click", () => {
    const behavior = reduced ? "auto" : "smooth";
    // Once the page has been scrolled the cue becomes a "back to top" control;
    // near the top it still jumps down to the landing sections as before.
    if ((window.scrollY || 0) > 60) {
      window.scrollTo({ top: 0, behavior });
    } else {
      sections?.scrollIntoView({ behavior, block: "start" });
    }
  });
  const updateCue = () => {
    const scrolled = (window.scrollY || 0) > 60;
    scrollCue?.classList.toggle("scroll-cue-up", scrolled);
    if (cueText) cueText.textContent = scrolled ? "TOP" : "SCROLL";
    scrollCue?.setAttribute(
      "aria-label",
      scrolled ? "Back to top" : "Scroll down for details",
    );
  };
  window.addEventListener("scroll", updateCue, { passive: true });
  updateCue();

  if (reduced) return;

  const els = [];
  GROUPS.forEach(([selector, variant, base, step]) => {
    document.querySelectorAll(selector).forEach((el, i) => {
      el.classList.add("ha", `ha-${variant}`);
      el.dataset.haEnter = String(base + i * step);
      el.dataset.haScroll = String(Math.min(i * 70, SCROLL_STAGGER_CAP_MS));
      els.push(el);
    });
  });
  if (!els.length) return;

  let entranceAt = 0; // set when a sweep starts; 0 while home is hidden

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const inEntrance = entranceAt && performance.now() - entranceAt < ENTRANCE_WINDOW_MS;
      el.style.animationDelay = (inEntrance ? el.dataset.haEnter : el.dataset.haScroll) + "ms";
      el.classList.add("ha-in");
      observer.unobserve(el);
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });

  function startSweep() {
    entranceAt = performance.now();
    els.forEach((el) => observer.observe(el));
    // Once the hero entrance has played, dip the page to tease the sections.
    if (!hinted) setTimeout(autoScrollHint, 1700);
  }

  function resetSweep() {
    // Leaving the home screen (match / free-play): park the scroll at the top
    // so the hero — not the middle of the marketing page — greets the return.
    window.scrollTo(0, 0);
    els.forEach((el) => {
      observer.unobserve(el);
      el.classList.remove("ha-in");
      el.style.animationDelay = "";
    });
  }

  // -- Auto scroll hint --------------------------------------------------------
  // First load only: glide the page down toward the sections and back up, so
  // it's obvious there's more below the fold. Any real user input (wheel,
  // touch, drag, key) cancels it instantly and hands control straight back.
  let hinted = false;
  function autoScrollHint() {
    if (hinted) return;
    hinted = true;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max < 160 || (window.scrollY || 0) > 4) return; // nothing to tease / user moved
    const down = Math.min(window.innerHeight * 0.55, max);
    const DURATION = 2600;
    let cancelled = false;
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
    const cancel = () => { cancelled = true; unbind(); };
    const unbind = () => inputs.forEach((t) => window.removeEventListener(t, cancel));
    inputs.forEach((t) => window.addEventListener(t, cancel, { passive: true }));
    const t0 = performance.now();
    (function step(now) {
      if (cancelled) return;
      const t = Math.min(1, (now - t0) / DURATION);
      // Ease the clock, then sweep 0 → down → 0 along a half sine.
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      window.scrollTo(0, Math.round(down * Math.sin(Math.PI * e)));
      if (t < 1) requestAnimationFrame(step);
      else unbind();
    })(t0);
  }

  // -- First entrance: wait for the loading splash to lift ------------------
  // main.js fades the splash by adding .fade-out and then removes the node;
  // start the sweep on whichever we see first. If the splash is already gone
  // (or was never there), start immediately.
  const splash = document.getElementById("appLoading");
  if (!splash || splash.classList.contains("fade-out")) {
    startSweep();
  } else {
    const splashWatch = new MutationObserver(() => {
      if (!splash.isConnected || splash.classList.contains("fade-out")) {
        splashWatch.disconnect();
        startSweep();
      }
    });
    splashWatch.observe(splash, { attributes: true, attributeFilter: ["class"] });
    splashWatch.observe(document.body, { childList: true });
  }

  // -- Replay when the home screen comes back --------------------------------
  // A match (body.in-game) and landing free-play (body.home-free-play) both
  // display:none the home chrome; replay the entrance when either ends so the
  // return to the menu feels as staged as the first load.
  let homeHidden = false;
  const bodyWatch = new MutationObserver(() => {
    const hidden = document.body.classList.contains("in-game") ||
                   document.body.classList.contains("home-free-play");
    if (hidden && !homeHidden) { entranceAt = 0; resetSweep(); }
    if (!hidden && homeHidden) startSweep();
    homeHidden = hidden;
  });
  bodyWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // -- Scroll effects ---------------------------------------------------------
  // Only the narrow layout scrolls (desktop home is a fixed full-viewport
  // screen, body overflow hidden), but the handler is a cheap no-op there:
  // scrollY stays 0 and everything resets. Hero title drifts down slower than
  // the page and fades out; the fixed nav gains a shadow once off the top.
  const nav = document.querySelector(".site-nav");
  const heroTitle = document.querySelector(".hero-title-block");
  const heroTagline = document.querySelector(".hero-tagline");
  let scrollRaf = 0;

  function applyScroll() {
    scrollRaf = 0;
    const y = window.scrollY || 0;
    nav?.classList.toggle("nav-scrolled", y > 12);
    if (heroTitle) {
      heroTitle.style.transform = y ? `translateY(${(y * 0.22).toFixed(1)}px)` : "";
      heroTitle.style.opacity = y ? Math.max(0, 1 - y / 480).toFixed(3) : "";
    }
    if (heroTagline) {
      heroTagline.style.transform = y ? `translateY(${(y * 0.1).toFixed(1)}px)` : "";
    }
  }

  window.addEventListener("scroll", () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(applyScroll);
  }, { passive: true });
  applyScroll();
}
