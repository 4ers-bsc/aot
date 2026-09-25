// Player skins. Skin "1" is the black/gold martial artist, skin "2" the
// black/gold armored knight, skin "3" the Degent — the white-faced, crowned
// ape in a black suit, built from the Degent model (see buildDegentBody in
// game.js). Each skin's palette is fixed; the hex ints feed straight into
// game.setPlayerAppearance() → the fighter's material map.
export const APPEARANCE_PRESETS = {
  1: { skin: 0xd69a55, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  2: { skin: 0x1f2026, hair: 0x0e0e12, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  // Degent: skin = the white face, hair = fur + shoes, gi = jacket, trim = the
  // gold (crown, face lines, shirt, pocket square, cuffs), pants = trousers + lapels.
  3: { skin: 0xf2f0eb, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 }
};

// Skin ids are strings ("1", "2", "3") in the client and on the network, and
// numbers in the profile row. Anything unknown falls back to skin "1".
export const SKIN_IDS = Object.keys(APPEARANCE_PRESETS);
export function normalizeSkin(id) {
  const s = String(id);
  return SKIN_IDS.includes(s) ? s : "1";
}
