require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const SEOUL_RPC      = process.env.SEOUL_RPC      || "https://seoul.worldland.foundation";
const GWANGJU_RPC    = process.env.GWANGJU_RPC    || "https://gwangju.worldland.foundation";
const BSC_RPC        = process.env.BSC_RPC        || "https://bsc-dataseed.binance.org";
const BSC_TEST_RPC   = process.env.BSC_TEST_RPC   || "https://data-seed-prebsc-1-s1.binance.org:8545";

const PK = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "london",
    },
  },
  networks: {
    seoul:      { url: SEOUL_RPC,    chainId: 103,   accounts: PK },
    gwangju:    { url: GWANGJU_RPC,  chainId: 10395, accounts: PK },
    bsc:        { url: BSC_RPC,      chainId: 56,    accounts: PK },
    bscTestnet: { url: BSC_TEST_RPC, chainId: 97,    accounts: PK },
  },
  etherscan: {
    apiKey: {
      bsc:        process.env.BSCSCAN_API_KEY || "",
      bscTestnet: process.env.BSCSCAN_API_KEY || "",
    },
  },
};
