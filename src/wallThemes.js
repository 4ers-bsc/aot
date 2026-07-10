// The arena wall style: "Crimson Keep" brick masonry recolored to the F10
// black-and-gold palette. drawFace() paints the 256×128 curtain-face canvas
// (tiled horizontally along each wall run, so it must tile seamlessly
// left-to-right); the hex ints tint the rampart's shared materials in
// game.js (stone shafts, gold trim, tower lanterns, corner crystals).

// Offset-course brick pattern. `tones` are per-brick fill variants picked
// pseudo-randomly (deterministic, so every client paints the identical wall).
function brickCourses(g, W, H, { mortar, tones, rows = 4, cols = 4 }) {
  g.fillStyle = mortar;
  g.fillRect(0, 0, W, H);
  const bw = W / cols, bh = H / rows, gap = 3;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? bw / 2 : 0;
    for (let c = -1; c < cols; c++) {
      const x = c * bw + off;
      // Deterministic tone pick — hash the brick's grid cell.
      const t = tones[Math.abs((r * 31 + c * 17 + 7) * 2654435761) % tones.length];
      g.fillStyle = t;
      g.fillRect(x + gap / 2, r * bh + gap / 2, bw - gap, bh - gap);
    }
  }
}

export const WALL_THEME = {
  id: "crimson-keep", name: "Crimson Keep",
  stone: 0x121216, stoneEmissive: 0x060608, stone2: 0x1c1c22,
  trim: 0xffc21a, trimEmissive: 0x6a4300,
  glow: 0xffd23a, glowEmissive: 0xffa406,
  crystal: 0xffc84a, crystalEmissive: 0xd2920a,
  drawFace(g, W, H) {
    // Near-black brick courses over a charcoal mortar, capped with the gold
    // banding that runs through the rest of the arena trim.
    brickCourses(g, W, H, { mortar: "#060607", tones: ["#141418", "#18181d", "#101014", "#1b1a20"], rows: 5, cols: 5 });
    g.strokeStyle = "rgba(255,198,39,0.16)"; g.lineWidth = 1; // faint gold brick edges
    for (let r = 1; r < 5; r++) { g.beginPath(); g.moveTo(0, r * H / 5); g.lineTo(W, r * H / 5); g.stroke(); }
    g.fillStyle = "#ffc627"; g.fillRect(0, 0, W, 5); g.fillRect(0, H - 5, W, 5); // gold bands
    g.fillStyle = "rgba(0,0,0,0.45)"; g.fillRect(0, 5, W, 2); g.fillRect(0, H - 7, W, 2);
  }
};
