// Chain definitions for viem/wagmi.
import { defineChain } from "viem";
import { bsc, bscTestnet } from "viem/chains";

export const seoul = defineChain({
  id: 103,
  name: "WorldLand Seoul",
  nativeCurrency: { name: "WorldLand Coin", symbol: "WLC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_SEOUL_RPC || "https://seoul.worldland.foundation"] },
  },
  blockExplorers: {
    default: { name: "Seoul Scan", url: process.env.NEXT_PUBLIC_SEOUL_EXPLORER || "https://scan.worldland.foundation" },
  },
});

export const gwangju = defineChain({
  id: 10395,
  name: "WorldLand Gwangju",
  nativeCurrency: { name: "WorldLand Coin", symbol: "WLC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_GWANGJU_RPC || "https://gwangju.worldland.foundation"] },
  },
});

export { bsc, bscTestnet };

// Default chain selection: BSC mainnet (where WL BEP-20 lives and trades).
// Override via NEXT_PUBLIC_DEFAULT_CHAIN_ID.
export const DEFAULT_CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || "56", 10);

export const ASSETS = [
  { label: "WL/USD",  key: "WL/USD"  },
  { label: "BTC/USD", key: "BTC/USD" },
  { label: "ETH/USD", key: "ETH/USD" },
];

export const WORLDBET_ADDRESS = process.env.NEXT_PUBLIC_WORLDBET_ADDRESS || "";
export const WL_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_WL_TOKEN_ADDRESS
  || "0x8aaB31fbc69C92fa53f600910Cf0f215531F8239"; // BSC mainnet WL
export const ORACLE_ADDRESS   = process.env.NEXT_PUBLIC_ORACLE_ADDRESS   || "";
