// Player skins. Skin "1" is the black/gold martial artist, skin "2" the
// black/gold armored knight, skin "3" the crowned ape king in a gold
// pixel-mosaic suit. Each skin's palette is fixed; the hex ints feed straight
// into game.setPlayerAppearance() → the fighter's material map. The king uses
// the same five slots: skin = head, gi = jacket, pants = trousers, trim =
// crown, hair = hands (both tint the same rainbow-static skin).
export const APPEARANCE_PRESETS = {
  1: { skin: 0xd69a55, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  2: { skin: 0x1f2026, hair: 0x0e0e12, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  3: { skin: 0xd4d4d8, hair: 0xd4d4d8, gi: 0xecc81a, trim: 0xd8a938, pants: 0xdcb214 }
};

// A skin id from anywhere — a number from the DB, a string from the DOM, local
// storage or an untrusted network snapshot — as its preset key ("1", "2", …),
// or null when it isn't a known skin. Own-property check, so junk like
// "__proto__" never matches.
export function skinKey(id) {
  const key = String(id);
  return Object.prototype.hasOwnProperty.call(APPEARANCE_PRESETS, key) ? key : null;
}
