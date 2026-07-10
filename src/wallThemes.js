// Arena wall themes. Each theme restyles the fortress rampart that rings the
// battlefield: the curtain-wall face pattern (painted onto the shared 256×128
// canvas texture, tiled horizontally along each wall run) plus the tints of
// the shared rampart materials (stone, trim, tower lanterns, corner crystals).
// Selected from the WALL dropdown on the in-game HUD; the choice persists in
// localStorage under WALL_THEME_KEY and is re-applied on the next boot.
//
// Every drawFace() paints the full face and must tile seamlessly left-to-right
// (the texture repeats along each curtain with wrapS = RepeatWrapping).

export const WALL_THEME_KEY = "f10_wall_theme";

// Offset-course brick/block pattern shared by several themes. `tones` are
// per-brick fill variants picked pseudo-randomly (deterministic, so every
// client paints the identical wall).
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

export const WALL_THEMES = [
  {
    // The original F10 look: navy panels framed in gold rails.
    id: "royal-gold", name: "Royal Gold",
    stone: 0x0c1430, stoneEmissive: 0x060a1a, stone2: 0x18213c,
    trim: 0xffc21a, trimEmissive: 0x6a4300,
    glow: 0xffd23a, glowEmissive: 0xffa406,
    crystal: 0x38b0ff, crystalEmissive: 0x1c7cff,
    drawFace(g, W, H) {
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, "#141f42"); grd.addColorStop(0.5, "#0c1730"); grd.addColorStop(1, "#070c1c");
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      g.strokeStyle = "rgba(255,200,50,0.55)"; g.lineWidth = 3; g.strokeRect(14, 14, W - 28, H - 28);
      g.strokeStyle = "rgba(120,150,210,0.25)"; g.lineWidth = 1; g.strokeRect(20, 20, W - 40, H - 40);
      g.fillStyle = "#ffc627"; g.fillRect(0, 4, W, 3); g.fillRect(0, H - 7, W, 3);
    }
  },
  {
    // Dark red brickwork with iron banding.
    id: "crimson-keep", name: "Crimson Keep",
    stone: 0x3a0e10, stoneEmissive: 0x1a0406, stone2: 0x4a1518,
    trim: 0x9aa0a8, trimEmissive: 0x2a2c30,
    glow: 0xff6a3a, glowEmissive: 0xd23c10,
    crystal: 0xff8a4a, crystalEmissive: 0xd25a1a,
    drawFace(g, W, H) {
      brickCourses(g, W, H, { mortar: "#1c0808", tones: ["#4a1214", "#571619", "#3f0f11", "#521418"], rows: 5, cols: 5 });
      g.fillStyle = "#787e86"; g.fillRect(0, 0, W, 5); g.fillRect(0, H - 5, W, 5); // iron bands
      g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, 5, W, 2); g.fillRect(0, H - 7, W, 2);
    }
  },
  {
    // Weathered green stone overgrown with hanging vines.
    id: "emerald-ruins", name: "Emerald Ruins",
    stone: 0x11301c, stoneEmissive: 0x061507, stone2: 0x1a4227,
    trim: 0xc2e860, trimEmissive: 0x3f6a10,
    glow: 0x8aff6a, glowEmissive: 0x3fd21a,
    crystal: 0x4affa8, crystalEmissive: 0x1ad27c,
    drawFace(g, W, H) {
      brickCourses(g, W, H, { mortar: "#0a1c10", tones: ["#1d4a2b", "#174022", "#215434", "#14381e"], rows: 4, cols: 4 });
      // Vines: wavy strands drooping from the top, with leaf dabs.
      g.strokeStyle = "rgba(120,200,90,0.75)"; g.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const x0 = (i + 0.5) * (W / 6), len = H * (0.35 + ((i * 37) % 5) / 9);
        g.beginPath(); g.moveTo(x0, 0);
        g.quadraticCurveTo(x0 + 8, len * 0.5, x0 - 4, len);
        g.stroke();
        g.fillStyle = "rgba(140,220,110,0.8)";
        g.fillRect(x0 + 4, len * 0.4, 4, 4); g.fillRect(x0 - 8, len * 0.8, 4, 4);
      }
    }
  },
  {
    // Pale blue ice blocks shot through with frost cracks.
    id: "frost-citadel", name: "Frost Citadel",
    stone: 0x1c3a5c, stoneEmissive: 0x0a1c30, stone2: 0x2c5680,
    trim: 0xbfe6ff, trimEmissive: 0x3a6a8f,
    glow: 0xa8e8ff, glowEmissive: 0x4ab8ff,
    crystal: 0x9adfff, crystalEmissive: 0x4aa8ff,
    drawFace(g, W, H) {
      brickCourses(g, W, H, { mortar: "#12283f", tones: ["#2e5a86", "#356798", "#28517a", "#3a70a4"], rows: 3, cols: 3 });
      // Frost sheen along the top of each block + hairline cracks.
      g.fillStyle = "rgba(220,245,255,0.28)";
      for (let r = 0; r < 3; r++) g.fillRect(0, r * (H / 3) + 2, W, 4);
      g.strokeStyle = "rgba(235,250,255,0.5)"; g.lineWidth = 1;
      [[30, 20, 55, 60, 40, 105], [150, 10, 130, 55, 160, 100], [220, 30, 235, 70, 215, 110]].forEach(([a, b, c, d, e, f]) => {
        g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.lineTo(e, f); g.stroke();
      });
    }
  },
  {
    // Near-black volcanic rock veined with glowing magma.
    id: "obsidian-magma", name: "Obsidian Magma",
    stone: 0x151013, stoneEmissive: 0x0a0507, stone2: 0x241a1c,
    trim: 0xff7a1a, trimEmissive: 0x8f3a00,
    glow: 0xffa03a, glowEmissive: 0xff5a06,
    crystal: 0xff6a2a, crystalEmissive: 0xd23400,
    drawFace(g, W, H) {
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, "#1c1416"); grd.addColorStop(1, "#0c0709");
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      // Lava veins: bright cores over soft glow halos, branching downward.
      const vein = (pts) => {
        g.strokeStyle = "rgba(255,110,20,0.35)"; g.lineWidth = 7; path(pts);
        g.strokeStyle = "#ff9a2a"; g.lineWidth = 2.5; path(pts);
      };
      const path = (pts) => {
        g.beginPath(); g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
        g.stroke();
      };
      vein([0, 90, 40, 70, 70, 95, 110, 60, 150, 88, 195, 55, 230, 80, 256, 62]);
      vein([20, 128, 35, 100, 60, 112]);
      vein([170, 128, 185, 104, 215, 118]);
      g.fillStyle = "#ff7a1a"; g.fillRect(0, H - 4, W, 4); // molten base line
    }
  },
  {
    // Cyberpunk panels traced with glowing cyan circuitry.
    id: "neon-circuit", name: "Neon Circuit",
    stone: 0x0a0e18, stoneEmissive: 0x04060c, stone2: 0x121828,
    trim: 0x2affd8, trimEmissive: 0x0a8f74,
    glow: 0x4affe8, glowEmissive: 0x06ffc8,
    crystal: 0xff3ae8, crystalEmissive: 0xb80a9e,
    drawFace(g, W, H) {
      g.fillStyle = "#0a0f1c"; g.fillRect(0, 0, W, H);
      g.strokeStyle = "rgba(40,60,100,0.5)"; g.lineWidth = 1;
      for (let x = 0; x <= W; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      // Circuit traces: right-angle runs with node pads at the corners.
      g.strokeStyle = "#22e8c8"; g.lineWidth = 2; g.fillStyle = "#a8fff0";
      const trace = (pts) => {
        g.beginPath(); g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
        g.stroke();
        for (let i = 0; i < pts.length; i += 2) g.fillRect(pts[i] - 2, pts[i + 1] - 2, 4, 4);
      };
      trace([0, 24, 48, 24, 48, 64, 112, 64, 112, 30, 176, 30]);
      trace([176, 30, 176, 84, 240, 84, 240, 24, 256, 24]);
      trace([0, 104, 64, 104, 64, 88, 144, 88, 144, 112, 220, 112, 220, 104, 256, 104]);
      // Magenta accent nodes.
      g.fillStyle = "#ff3ae8";
      [[48, 24], [112, 64], [176, 84], [64, 104], [220, 112]].forEach(([x, y]) => g.fillRect(x - 3, y - 3, 6, 6));
    }
  },
  {
    // Regal violet stone under a silver diamond lattice.
    id: "amethyst-palace", name: "Amethyst Palace",
    stone: 0x2a1440, stoneEmissive: 0x140824, stone2: 0x3a1e58,
    trim: 0xd8d2e8, trimEmissive: 0x4a4460,
    glow: 0xc88aff, glowEmissive: 0x8a3aff,
    crystal: 0xd28aff, crystalEmissive: 0x9a3aff,
    drawFace(g, W, H) {
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, "#3f2260"); grd.addColorStop(1, "#241038");
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      // Diamond lattice: crossing diagonals on a 32px rhythm (tiles cleanly).
      g.strokeStyle = "rgba(216,210,232,0.5)"; g.lineWidth = 2;
      for (let x = -H; x < W + H; x += 32) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke();
        g.beginPath(); g.moveTo(x + H, 0); g.lineTo(x, H); g.stroke();
      }
      // Gem stud at each lattice crossing row.
      g.fillStyle = "#e8c2ff";
      for (let x = 16; x < W; x += 32) { g.fillRect(x - 2, H / 2 - 2, 4, 4); }
      g.fillStyle = "#d8d2e8"; g.fillRect(0, 0, W, 4); g.fillRect(0, H - 4, W, 4);
    }
  },
  {
    // Sun-baked sandstone blocks with terracotta banding.
    id: "desert-sandstone", name: "Desert Sandstone",
    stone: 0x9a7a4a, stoneEmissive: 0x241a08, stone2: 0xb08a54,
    trim: 0xc2542a, trimEmissive: 0x571f0a,
    glow: 0xffc86a, glowEmissive: 0xb8742a,
    crystal: 0x3ac8c2, crystalEmissive: 0x0a8f8a,
    drawFace(g, W, H) {
      brickCourses(g, W, H, { mortar: "#6a5230", tones: ["#c2a066", "#b8945a", "#cca972", "#ad8a50"], rows: 4, cols: 5 });
      // Terracotta chevron band across the middle course.
      g.fillStyle = "#b04a24"; g.fillRect(0, H / 2 - 5, W, 10);
      g.fillStyle = "#8f3a1a";
      for (let x = 0; x < W; x += 16) {
        g.beginPath(); g.moveTo(x, H / 2 + 5); g.lineTo(x + 8, H / 2 - 5); g.lineTo(x + 16, H / 2 + 5); g.closePath(); g.fill();
      }
      g.fillStyle = "rgba(255,236,190,0.25)"; g.fillRect(0, 0, W, 6); // sun bleach
    }
  },
  {
    // Riveted steel plating with a hazard-striped base.
    id: "industrial-steel", name: "Industrial Steel",
    stone: 0x3a4048, stoneEmissive: 0x14161a, stone2: 0x4a525c,
    trim: 0xffce1a, trimEmissive: 0x6a5200,
    glow: 0xffe23a, glowEmissive: 0xc8a006,
    crystal: 0xff9a2a, crystalEmissive: 0xc85a00,
    drawFace(g, W, H) {
      g.fillStyle = "#464e58"; g.fillRect(0, 0, W, H);
      // Plate seams + rivets on a 64×48 grid.
      g.strokeStyle = "rgba(20,24,28,0.8)"; g.lineWidth = 2;
      for (let x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y <= H - 24; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.fillStyle = "#20242a";
      for (let x = 8; x < W; x += 16) for (const y of [8, 40, 88]) g.fillRect(x - 1, y - 1, 3, 3);
      g.fillStyle = "rgba(255,255,255,0.07)"; g.fillRect(0, 0, W, 10); // top sheen
      // Yellow/black hazard stripe along the base.
      g.fillStyle = "#ffce1a"; g.fillRect(0, H - 22, W, 22);
      g.fillStyle = "#15151a";
      for (let x = -16; x < W; x += 32) {
        g.beginPath(); g.moveTo(x, H); g.lineTo(x + 16, H - 22); g.lineTo(x + 32, H - 22); g.lineTo(x + 16, H); g.closePath(); g.fill();
      }
    }
  },
  {
    // Pink-and-cream candy stripes with a mint scallop crown.
    id: "bubblegum-candy", name: "Bubblegum Candy",
    stone: 0xf06aa8, stoneEmissive: 0x40142a, stone2: 0xff9ac2,
    trim: 0x5ae8c2, trimEmissive: 0x0a6a52,
    glow: 0xffb8dd, glowEmissive: 0xff6ab8,
    crystal: 0x6affd8, crystalEmissive: 0x1ad2a0,
    drawFace(g, W, H) {
      g.fillStyle = "#ffe9f4"; g.fillRect(0, 0, W, H);
      // Diagonal candy stripes on a 32px rhythm (tiles cleanly).
      g.fillStyle = "#ff6ab0";
      for (let x = -H; x < W + H; x += 32) {
        g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.lineTo(x + H + 16, 0); g.lineTo(x + 16, H); g.closePath(); g.fill();
      }
      // Mint scallop trim along the top edge.
      g.fillStyle = "#5ae8c2";
      g.fillRect(0, 0, W, 8);
      for (let x = 16; x <= W; x += 32) { g.beginPath(); g.arc(x, 8, 10, 0, Math.PI); g.fill(); }
      g.fillStyle = "#ff4a9e"; g.fillRect(0, H - 6, W, 6); // raspberry base line
    }
  }
];
