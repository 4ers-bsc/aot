// Player skins. Skin "1" is the black/red martial artist, skin "2" the
// black/red armored knight. Each skin's palette is fixed; the hex ints feed
// straight into game.setPlayerAppearance() → the fighter's material map.
export const APPEARANCE_PRESETS = {
  1: { skin: 0xd69a55, hair: 0x0f0909, gi: 0x211213, trim: 0xc81e2a, pants: 0x170d0e },
  2: { skin: 0x2c191a, hair: 0x140c0c, gi: 0x211213, trim: 0xc81e2a, pants: 0x170d0e }
};
