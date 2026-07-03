// Scroll-triggered reveal animations for the home/landing screen.
//
// Elements tagged with data-reveal start hidden (opacity/transform — see the
// "Reveal animations" block in styles.css) and gain .reveal-in when they enter
// the viewport. On desktop the whole home fits in one viewport, so everything
// reveals at once in a staggered entrance (per-element --reveal-delay); on
// narrow screens the home flows and scrolls, so below-the-fold content (info
// tiles) genuinely reveals on scroll. Each element animates once.
//
// Call initReveal() only once the loading splash starts fading — the splash
// covers the page, and IntersectionObserver fires on viewport intersection
// regardless of what's painted on top, so starting earlier would play the
// entrance animation invisibly behind the splash.
export function initReveal() {
  initScrollNav();

  const els = document.querySelectorAll("[data-reveal]");
  if (!els.length) return;

  // Reduced motion (or no IO support): show everything immediately, no motion.
  // styles.css also neutralises the hidden state under prefers-reduced-motion,
  // so this class flip is just belt-and-braces for the IO-less path.
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    typeof IntersectionObserver === "undefined"
  ) {
    els.forEach((el) => el.classList.add("reveal-in"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("reveal-in");
        io.unobserve(entry.target); // reveal once, never re-hide
      }
    },
    // Trigger once a slice of the element is on screen. Keep the threshold
    // low and the rootMargin at zero: the hidden state shifts elements down
    // by ~26px (see styles.css), so anything flush with the bottom of the
    // page — the info strip — sits partly below the viewport until it
    // reveals. A stricter threshold or a negative bottom rootMargin would
    // leave that content permanently invisible.
    { threshold: 0.1 }
  );

  els.forEach((el) => io.observe(el));
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
