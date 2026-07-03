// Scroll-bound (scrubbed) animations for the home page.
//
// Two systems share the data-reveal tags:
//
//  - First-screen elements (inside .home-screen) play a one-shot timed
//    entrance when the loading splash fades. They are already in view at
//    load, so there is no scroll travel to bind them to — scrubbing them
//    would simply skip the entrance.
//  - Detail-section elements (inside .home-more) are scroll-BOUND: their
//    opacity and transform are interpolated directly from scroll position
//    every frame, so scrolling scrubs the animation forwards and backwards
//    instead of triggering it once.
//
// Two more scroll-linked effects ride the same rAF loop: the nav gains a
// dark backdrop past the top of the page, and the hero drifts up and fades
// (parallax) as the first screen scrolls away.
//
// Call initReveal() only once the loading splash starts fading — the splash
// covers the page, so starting earlier would play the entrance invisibly
// behind it.

// Mirrors the hidden-state offsets of the [data-reveal] CSS rules; e runs
// 0 (hidden) → 1 (resting position).
const MOVES = {
  "fade-up":    (e) => `translateY(${((1 - e) * 26).toFixed(2)}px)`,
  "fade-down":  (e) => `translateY(${((e - 1) * 22).toFixed(2)}px)`,
  "fade-left":  (e) => `translateX(${((1 - e) * 30).toFixed(2)}px)`,
  "fade-right": (e) => `translateX(${((e - 1) * 30).toFixed(2)}px)`,
  "zoom":       (e) => `scale(${(0.9 + 0.1 * e).toFixed(4)})`,
};

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

export function initReveal() {
  initScrollNav();

  const all = [...document.querySelectorAll("[data-reveal]")];
  if (!all.length) return;

  // Reduced motion: show everything immediately, bind nothing to scroll.
  // styles.css also neutralises the hidden state under prefers-reduced-motion.
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    typeof IntersectionObserver === "undefined"
  ) {
    all.forEach((el) => el.classList.add("reveal-in"));
    return;
  }

  initEntrance(all.filter((el) => !el.closest(".home-more")));

  // Scrubbed elements and the hero parallax share one rAF-throttled loop.
  const updaters = [
    makeScrubUpdater(all.filter((el) => el.closest(".home-more"))),
    makeHeroParallaxUpdater(),
  ].filter(Boolean);
  if (!updaters.length) return;

  let queued = false;
  const run = () => {
    queued = false;
    updaters.forEach((u) => u());
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  run(); // paint the initial state (below-fold hidden, hero at rest)
}

// One-shot timed entrance for the first screen. IntersectionObserver rather
// than a blanket class flip because on narrow screens the first screen flows
// taller than the viewport — its lower tiles should still wait to be seen.
function initEntrance(els) {
  if (!els.length) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("reveal-in");
        io.unobserve(entry.target); // reveal once, never re-hide
      }
    },
    // Low threshold, zero rootMargin: the hidden state shifts elements down
    // by ~26px, so anything flush with a fold edge would never cross a
    // stricter line and stay invisible.
    { threshold: 0.1 }
  );
  els.forEach((el) => io.observe(el));
}

// Scroll-bound scrubbing: progress p runs 0 → 1 as the element's top travels
// from the bottom edge of the viewport up through a scrub window. The window
// is the element's own height capped at 40% of the viewport — the cap keeps
// tall panels from scrubbing forever, and using the element height as the
// base guarantees anything fully visible has finished (p >= 1), so content
// pinned to the very bottom of the page can always complete.
function makeScrubUpdater(els) {
  if (!els.length) return null;
  const items = els.map((el) => {
    // Reuse the entrance stagger (--reveal-delay, in seconds) as a scrub
    // offset: a 0.15s card starts 15% of the window later than its row.
    const delay =
      parseFloat(getComputedStyle(el).getPropertyValue("--reveal-delay")) || 0;
    el.classList.add("reveal-scrub"); // drops the CSS transition; JS owns the styles
    return { el, offset: Math.min(delay, 0.6), move: MOVES[el.dataset.reveal] };
  });

  return () => {
    if (document.body.classList.contains("in-game")) return; // hidden anyway
    const vh = window.innerHeight;
    for (const it of items) {
      const r = it.el.getBoundingClientRect();
      const windowPx = Math.min(Math.max(r.height, 1), vh * 0.4);
      const p = (vh - r.top) / windowPx;
      const e = easeOutCubic(clamp01((p - it.offset) / (1 - it.offset)));
      it.el.style.opacity = e.toFixed(3);
      if (it.move) it.el.style.transform = e >= 1 ? "none" : it.move(e);
    }
  };
}

// Hero departure parallax: as the first screen scrolls away, the hero drifts
// up slightly faster than the page and fades — scrubbed, so scrolling back
// restores it. Applied to the untagged .hero-section container so it can't
// fight the entrance animation running on the children.
function makeHeroParallaxUpdater() {
  const hero = document.querySelector(".hero-section");
  if (!hero) return null;
  return () => {
    if (document.body.classList.contains("in-game")) {
      hero.style.transform = "";
      hero.style.opacity = "";
      return;
    }
    const t = clamp01(window.scrollY / (window.innerHeight * 0.7));
    hero.style.transform = t
      ? `translateY(${(-t * window.innerHeight * 0.12).toFixed(1)}px)`
      : "";
    hero.style.opacity = (1 - 0.85 * t).toFixed(3);
  };
}

// Scroll-linked nav backdrop: the fixed nav is transparent over the hero but
// gains a dark blurred background (.nav-scrolled, see styles.css) as soon as
// the page scrolls, so it stays readable over the detail sections.
function initScrollNav() {
  const nav = document.querySelector(".site-nav");
  if (!nav) return;
  const update = () => nav.classList.toggle("nav-scrolled", window.scrollY > 24);
  window.addEventListener("scroll", update, { passive: true });
  update();
}
