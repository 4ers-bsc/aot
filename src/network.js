// ---------------------------------------------------------------------------
// Robinhood Chain (mainnet) — the single network the app talks to. This table
// drives the wallet's add/switch-chain prompts, the read-only RPC provider,
// and every explorer link, so nothing can point at a different chain. The
// Supabase edge functions (f10join / f10treasurer / f10admin) hardcode the
// same parameters.
// ---------------------------------------------------------------------------
export const NETWORK = {
  name: "Robinhood Chain",
  chainId: 4663,
  chainIdHex: "0x1237",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerBase: "https://robinhoodchain.blockscout.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

// VITE_ROBINHOOD_RPC_URL overrides the public RPC endpoint (e.g. a dedicated
// Alchemy/QuickNode key) without changing which network is used.
export const RPC_URL =
  import.meta.env?.VITE_ROBINHOOD_RPC_URL?.trim() || NETWORK.rpcUrl;

// Blockscout explorer links.
export const txExplorerUrl = (hash) =>
  `${NETWORK.explorerBase}/tx/${encodeURIComponent(hash)}`;
export const addrExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/address/${encodeURIComponent(String(addr).split(":").pop())}`;
