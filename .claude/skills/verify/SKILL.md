---
name: verify
description: Build, run, and drive the FIGHT10 arena app headlessly to verify a change at its surface.
---

# Verifying changes in this repo

Vite + vanilla JS + three.js single-page app. No test suite — verify by driving the real app.

## Build & serve

```bash
npm ci
npx vite build            # catches syntax/import errors
npx vite preview --port 4173 &   # serves dist/
```

Supabase env vars are optional for local runs: the app boots with a placeholder
anon key and logs (harmless) websocket errors. Demo mode needs no network.

## Drive it (headless Playwright)

Chromium is at `/opt/pw-browsers/chromium`; launch with
`args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"]` for WebGL
(expect ~5 FPS, fine for screenshots).

Gotchas:
- A first-visit tutorial modal covers the screen. Suppress with
  `localStorage.setItem("f10_tutorial_seen", "1")` before reload.
- `#demoBtn` is hidden until a wallet connects, but its click listener is
  bound at boot — `document.getElementById("demoBtn").click()` starts a demo
  match regardless.
- After clicking, wait for `body.in-game`, then ~5s for the match-start
  countdown before the HUD is interactive.
- The home page also shows the game HUD in free-play (`body.home-free-play`).
- Camera: `mouse.wheel` zooms, click-drag pans. Arena walls hang *below* the
  map rim, so zoom fully out (or pan past an edge) to see them.
