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
        selfDefending: true,
        disableConsoleOutput: true,
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
