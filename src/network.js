// ---------------------------------------------------------------------------
// Solana network — the single place the app defines the network it talks to.
// The app runs on mainnet-beta only.
//
// This drives the read-only RPC connection and every explorer link. The
// Supabase edge functions carry a matching definition, kept in sync with this
// one. Unlike an EVM chain, Solana wallets have no "switch/add network" prompt:
// the cluster a wallet operates on follows the RPC endpoint the app uses, so
// there is nothing to ask the wallet to switch to.
// ---------------------------------------------------------------------------
export const NETWORK = {
  key: "mainnet",
  name: "Solana",
  // Solana has no EVM-style numeric chain id. We keep a small integer cluster
  // identifier (Metaplex convention: mainnet-beta = 101) purely so the match
  // "economic identity" snapshot can detect a cluster change the same way the
  // EVM build detected a chain-id change. It is NEVER sent to a wallet.
  cluster: "mainnet-beta",
  chainId: 101,
  rpcUrl: "https://api.mainnet-beta.solana.com",
  explorerBase: "https://solscan.io",
  nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
};

// VITE_SOLANA_RPC_URL overrides the cluster's public RPC endpoint (e.g. a
// dedicated Helius/QuickNode/Triton key) without changing which cluster is
// selected. The public endpoint is heavily rate-limited — set a dedicated key
// for production.
export const RPC_URL =
  import.meta.env?.VITE_SOLANA_RPC_URL?.trim() || NETWORK.rpcUrl;

// Solscan explorer links for the selected cluster. Base58 signatures and
// addresses are CASE-SENSITIVE — never lowercase them. A stored value may carry
// a CAIP-style "solana:" prefix; strip only that leading segment.
export const txExplorerUrl = (sig) =>
  `${NETWORK.explorerBase}/tx/${encodeURIComponent(String(sig).split(":").pop())}`;
export const addrExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/account/${encodeURIComponent(String(addr).split(":").pop())}`;
