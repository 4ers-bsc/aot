// This module is excluded from obfuscation (see vite.config.js). The
// obfuscator rewrites string literals into decoder lookups, and a dynamic
// import() whose specifier is no longer a literal can't be analyzed by the
// bundler — it would ship to the browser as a bare import("ethers") and fail
// to resolve. Keeping the import() literals in this tiny unobfuscated module
// (it contains nothing but public package names) lets Vite code-split each
// library into its own locally served chunk, fetched lazily on first use.
export const importEthers = () => import("ethers");
export const importDevtoolsDetector = () => import("devtools-detector");
