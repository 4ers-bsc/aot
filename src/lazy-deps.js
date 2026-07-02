// This module is excluded from obfuscation (see vite.config.js). The
// obfuscator rewrites string literals into decoder lookups, and a dynamic
// import() whose specifier is no longer a literal can't be analyzed by the
// bundler — it would ship to the browser as a bare import("@solana/web3.js")
// and fail to resolve. Keeping the import() literals in this tiny unobfuscated
// module (it contains nothing but public package names) lets Vite code-split
// each library into its own locally served chunk, fetched lazily on first use.
// The Solana libraries assume Node's Buffer global (Buffer.concat in PDA
// derivation, Buffer.alloc in instruction encoders, transaction
// serialization). esm.sh's ?bundle used to inject a shim for it; when bundling
// locally we must provide it ourselves, before either library runs.
const ensureBufferGlobal = async () => {
  if (!globalThis.Buffer) {
    const { Buffer } = await import("buffer");
    globalThis.Buffer = Buffer;
  }
};
export const importSolanaWeb3 = () => ensureBufferGlobal().then(() => import("@solana/web3.js"));
export const importSplToken = () => ensureBufferGlobal().then(() => import("@solana/spl-token"));
export const importDevtoolsDetector = () => import("devtools-detector");
