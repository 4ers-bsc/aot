import { defineConfig } from "vite";

export default defineConfig({
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
