import { defineConfig } from "vite";
import obfuscatorPlugin from "vite-plugin-javascript-obfuscator";

export default defineConfig({
  plugins: [
    obfuscatorPlugin({
      apply: "build",
      debugger: false,
      options: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.4,
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
