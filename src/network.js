// ---------------------------------------------------------------------------
// Robinhood Chain network table — the single place the app decides which
// network it talks to. Switch between testnet and mainnet with the
// VITE_NETWORK env var ("testnet" | "mainnet"; defaults to testnet).
//
// The same table drives the wallet's add/switch-chain prompts, the read-only
// RPC provider, and every explorer link, so a network change can never be
// half-applied. The Supabase edge functions carry a matching table selected
// by their NETWORK secret — flip both together when moving to mainnet.
// ---------------------------------------------------------------------------
export const NETWORKS = {
  mainnet: {
    key: "mainnet",
    name: "Robinhood Chain",
    chainId: 4663,
    chainIdHex: "0x1237",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerBase: "https://robinhoodchain.blockscout.com",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  testnet: {
    key: "testnet",
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    chainIdHex: "0xb626",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com/rpc",
    explorerBase: "https://explorer.testnet.chain.robinhood.com",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
};

export const NETWORK =
  NETWORKS[import.meta.env?.VITE_NETWORK?.trim().toLowerCase()] ?? NETWORKS.testnet;

// VITE_ROBINHOOD_RPC_URL overrides the table's public RPC endpoint (e.g. a
// dedicated Alchemy/QuickNode key) without changing which network is selected.
export const RPC_URL =
  import.meta.env?.VITE_ROBINHOOD_RPC_URL?.trim() || NETWORK.rpcUrl;

// Blockscout explorer links for the selected network.
export const txExplorerUrl = (hash) =>
  `${NETWORK.explorerBase}/tx/${encodeURIComponent(hash)}`;
export const addrExplorerUrl = (addr) =>
  `${NETWORK.explorerBase}/address/${encodeURIComponent(String(addr).split(":").pop())}`;
