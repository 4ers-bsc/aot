// ---------------------------------------------------------------------------
// Robinhood Chain network — the single place the app defines the network it
// talks to. The app runs on mainnet only.
//
// This drives the wallet's add/switch-chain prompts, the read-only RPC
// provider, and every explorer link. The Supabase edge functions carry a
// matching definition (f10join / f10treasurer / f10admin), kept in sync with
// this one — the ops dashboard's Deployment tab flags a mismatch.
// ---------------------------------------------------------------------------
export const NETWORK = {
  key: "mainnet",
  name: "Robinhood Chain",
  chainId: 4663,
  chainIdHex: "0x1237",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerBase: "https://robinhoodchain.blockscout.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

// VITE_ROBINHOOD_RPC_URL overrides the network's public RPC endpoint (e.g. a
// dedicated Alchemy/QuickNode key) without changing which network is selected.
// The public endpoint is rate-limited — set a dedicated key for production.
export const RPC_URL =
  import.meta.env?.VITE_ROBINHOOD_RPC_URL?.trim() || NETWORK.rpcUrl;

// Blockscout explorer links for the selected network. Hashes and addresses are
// case-insensitive hex; a stored wallet value may carry a CAIP-style
// "ethereum:" / "eip155:4663:" prefix — keep only the trailing segment.
export const txExplorerUrl = (hash) =>
  `${NETWORK.explorerBase}/tx/${encodeURIComponent(String(hash).split(":").pop())}`;
export const addrExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/address/${encodeURIComponent(String(addr).split(":").pop())}`;
export const tokenExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/token/${encodeURIComponent(String(addr).split(":").pop())}`;
