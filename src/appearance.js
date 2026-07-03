// Player appearance styles and the color options offered in the profile's
// APPEARANCE tab. Style "1" is the black/gold martial artist, style "2" the
// black/gold armored knight. Every color is a plain hex int fed straight into
// game.setPlayerAppearance() → the fighter's material map, so a preset and a
// fully customized palette are the same shape.
export const APPEARANCE_STYLES = { 1: "FIGHTER", 2: "KNIGHT" };

// The five recolorable material groups. The same palette keys drive both
// styles; only the on-screen label changes with the active style.
export const APPEARANCE_PARTS = [
  { key: "skin",  labels: { 1: "Skin",  2: "Face" } },
  { key: "hair",  labels: { 1: "Hair",  2: "Helmet" } },
  { key: "gi",    labels: { 1: "Gi",    2: "Armor" } },
  { key: "trim",  labels: { 1: "Trim",  2: "Trim" } },
  { key: "pants", labels: { 1: "Pants", 2: "Legs" } }
];

export const APPEARANCE_PRESETS = {
  1: { skin: 0xd69a55, hair: 0x0b0b0d, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 },
  2: { skin: 0x1f2026, hair: 0x0e0e12, gi: 0x17181c, trim: 0xd9a821, pants: 0x101114 }
};

// Swatches shown per part. Each preset's default is included so "Reset Colors"
// always lands on a selectable swatch.
export const COLOR_OPTIONS = {
  skin:  [0xd69a55, 0xf0c8a0, 0xb07a3e, 0x8a5a2b, 0x5c3b1e, 0x1f2026],
  hair:  [0x0b0b0d, 0x0e0e12, 0x4a2e17, 0xd9b13b, 0x8a2f1d, 0xdcdcdc],
  gi:    [0x17181c, 0xf2ede2, 0xa83a32, 0x2b4a8a, 0x2f6b3a, 0x5a2d82],
  trim:  [0xd9a821, 0xc0392b, 0xc9d2da, 0x2aa8b8, 0x141414],
  pants: [0x101114, 0xe8e2d4, 0x5e1f1a, 0x1e3358, 0x3a3f45]
};
