// Player skins. Skin "1" is the black/gold martial artist, skin "2" the
// black/gold armored knight, skin "3" ("Babbler") the black/gold voxel boxer.
// Each skin's palette is fixed; the hex ints feed straight into
// game.setPlayerAppearance() → the fighter's material map.
export const APPEARANCE_PRESETS = {
  1: { skin: 0xd69a55, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  2: { skin: 0x1f2026, hair: 0x0e0e12, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  3: { skin: 0x1c1d23, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xf0b32e, pants: 0x101114 }
};
