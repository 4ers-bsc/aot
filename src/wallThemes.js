// The arena wall style: near-black brick masonry laced with glowing white
// neon grout — a black-and-white brick face. drawFace() paints the
// 256×128 curtain-face canvas (tiled horizontally along each wall run, so it
// must tile seamlessly left-to-right); the hex ints tint the rampart's shared
// materials in game.js (stone shafts, gold trim, tower lanterns, corner
// crystals).

function roundRectPath(g, x, y, w, h, r) {
  if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Running-bond (offset-course) brick pattern. Bricks are near-black stone; the
// mortar between them is a bright gold that glows like neon tubing. Draws
// bricks first, then strokes the glowing grout on top so the bloom bleeds onto
// the brick edges (the key to the neon look). The horizontal offset is exactly
// half a brick and the run width is a whole number of bricks, so the face tiles
// seamlessly left-to-right.
function neonBricks(g, W, H, { rows, cols, gap, tones }) {
  // 1) Black base — becomes the dark mortar channels behind the gold.
  g.fillStyle = "#040405";
  g.fillRect(0, 0, W, H);

  const bw = W / cols, bh = H / rows;

  // 2) The black bricks, inset by the grout gap and softly shaded top-to-bottom
  //    with a few deterministic hairline cracks so the stone reads as textured.
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? -bw / 2 : 0;
    const y = r * bh + gap / 2;
    for (let c = -1; c <= cols; c++) {
      const x = c * bw + off + gap / 2;
      const bwid = bw - gap, bhei = bh - gap;
      const hash = Math.abs((r * 31 + c * 17 + 7) * 2654435761);
      const t = tones[hash % tones.length];

      const grd = g.createLinearGradient(x, y, x, y + bhei);
      grd.addColorStop(0, t);
      grd.addColorStop(1, "#050506");
      g.fillStyle = grd;
      roundRectPath(g, x, y, bwid, bhei, 3);
      g.fill();

      // A couple of faint cracks, seeded from the brick's grid cell.
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 1;
      const cracks = hash % 3;
      for (let k = 0; k < cracks; k++) {
        const sx = x + ((hash >> (k * 3 + 2)) % 100) / 100 * bwid;
        const sy = y + ((hash >> (k * 4 + 1)) % 100) / 100 * bhei;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx + (((hash >> k) % 2) ? 1 : -1) * bwid * 0.25, sy + bhei * 0.22);
        g.stroke();
      }
    }
  }

  // 3) The glowing gold grout, drawn last so its bloom spills onto the brick
  //    edges. A wide soft pass lays the neon halo, then a bright thin core runs
  //    down the middle of every seam.
  const hSeam = (pass) => {
    for (let r = 0; r <= rows; r++) {
      const yy = r * bh;
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(W, yy);
      g.stroke();
    }
  };
  const vSeams = () => {
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? -bw / 2 : 0;
      const y0 = r * bh, y1 = (r + 1) * bh;
      for (let c = -1; c <= cols; c++) {
        const x = c * bw + off;
        g.beginPath();
        g.moveTo(x, y0);
        g.lineTo(x, y1);
        g.stroke();
      }
    }
  };

  g.save();
  g.lineCap = "round";

  // Soft outer halo.
  g.shadowColor = "rgba(235,240,250,0.95)";
  g.shadowBlur = 11;
  g.strokeStyle = "rgba(220,226,238,0.85)";
  g.lineWidth = gap;
  hSeam(); vSeams();

  // Brighter mid glow.
  g.shadowBlur = 6;
  g.strokeStyle = "#e9edf5";
  g.lineWidth = gap * 0.6;
  hSeam(); vSeams();

  // Hot white core.
  g.shadowBlur = 3;
  g.strokeStyle = "#ffffff";
  g.lineWidth = 1.6;
  hSeam(); vSeams();

  g.restore();
}

export const WALL_THEME = {
  id: "neon-vault", name: "Neon Vault",
  stone: 0x0d0d10, stoneEmissive: 0x050506, stone2: 0x151519,
  trim: 0xffc21a, trimEmissive: 0x6a4300,
  glow: 0xffd23a, glowEmissive: 0xffb400,
  crystal: 0xffc84a, crystalEmissive: 0xd2920a,
  drawFace(g, W, H) {
    // Near-black bricks in a running bond, every seam a glowing white neon line.
    neonBricks(g, W, H, {
      rows: 4, cols: 4, gap: 6,
      tones: ["#0e0e12", "#111116", "#0b0b0e", "#141419"],
    });
  },
};
