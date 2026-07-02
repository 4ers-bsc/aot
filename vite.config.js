import { defineConfig } from "vite";
import obfuscatorPlugin from "vite-plugin-javascript-obfuscator";

export default defineConfig({
  plugins: [
    obfuscatorPlugin({
      apply: "build",
      // Overrides the plugin's default exclude, so node_modules must be
      // restated. lazy-deps.js must stay unobfuscated: it holds the dynamic
      // import() literals that Vite needs to see verbatim to code-split the
      // Solana/devtools-detector libraries into local chunks (see that file).
      exclude: [/node_modules/, /src\/lazy-deps\.js$/],
      debugger: false,
      options: {
        compact: true,
        // Off: control-flow flattening measurably slows hot code, and game.js is
        // per-frame hot path (the render/update loop runs 60×/s). String-array
        // encoding below stays on and is the real deterrent; flattening added
        // FPS cost on mid-range devices for little extra obscurity.
        controlFlowFlattening: false,
        deadCodeInjection: false,
        stringEncoding: true,
        stringEncodingThreshold: 0.6,
        renameGlobals: false,
        // Must stay false: selfDefending locks the app in an infinite loop if
        // anything re-formats the code after obfuscation — and Vite's esbuild
        // minify pass does exactly that to transformed chunks. The result is a
        // production-only hang on the loading screen. It adds no real security
        // (the string-array obfuscation above is the actual deterrent).
        selfDefending: false,
        // Must stay false: the devtools-open detection in main.js relies on
        // console.log firing a property getter. Stubbing console breaks it.
        disableConsoleOutput: false,
        rotateStringArray: true,
        shuffleStringArray: true,
        splitStrings: true,
        splitStringsChunkLength: 8,
        unicodeEscapeSequence: false,
      },
    }),
  ],
  publicDir: "assets",
  build: {
    rollupOptions: {
      output: {
        // three.js is large and pinned — keep it in its own chunk so app-code
        // changes don't invalidate its browser cache entry.
        manualChunks: { three: ["three"] },
      },
    },
  },
  server: {
    host: true,
    // Must match the Supabase project's Site URL (http://localhost:3000) so the
    // Sign in with Solana (SIWS) message URI is on the auth server's allow list.
    port: 3000,
    strictPort: true
  },
  preview: {
    port: 3000,
    strictPort: true
  }
});
