// ---------------------------------------------------------------------------
// Robinhood Chain network — the single place the app defines the network it
// talks to. The app runs on mainnet only.
//
// This drives the wallet's add/switch-chain prompts, the read-only RPC
// provider, and every explorer link. The Supabase edge functions carry a
// matching definition, kept in sync with this one.
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

// VITE_ROBINHOOD_RPC_URL overrides the table's public RPC endpoint (e.g. a
// dedicated Alchemy/QuickNode key) without changing which network is selected.
export const RPC_URL =
  import.meta.env?.VITE_ROBINHOOD_RPC_URL?.trim() || NETWORK.rpcUrl;

// Blockscout explorer links for the selected network.
export const txExplorerUrl = (hash) =>
  `${NETWORK.explorerBase}/tx/${encodeURIComponent(hash)}`;
export const addrExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/address/${encodeURIComponent(String(addr).split(":").pop())}`;
