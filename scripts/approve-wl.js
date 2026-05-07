// Manually approve WL (or MockWL) spending from a given account.
// Use this to isolate whether a MetaMask approval problem is in the frontend
// or in the contract / network itself.
//
// Usage:
//   SPENDER_KEY=0x<account2_privkey> npx hardhat run scripts/approve-wl.js --network bscTestnet
//
// Optional overrides:
//   SPENDER=0x<address>   override spender address (defaults to WORLDBET_ADDRESS in deployments.json)
//   AMOUNT=<WL>           WL amount to approve (default: max uint256)
//   WL=0x<address>        override WL token address (default: from mock-wl.json, then deployments.json)

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const key = process.env.SPENDER_KEY;
  if (!key) {
    console.error("SPENDER_KEY env var required (0x-prefixed private key of the approving account)");
    process.exit(1);
  }

  // ── resolve WL token address ──
  let wlAddr = process.env.WL;
  if (!wlAddr) {
    const mockPath = path.join(__dirname, "..", "mock-wl.json");
    const deployPath = path.join(__dirname, "..", "deployments.json");
    if (fs.existsSync(mockPath)) {
      const mock = JSON.parse(fs.readFileSync(mockPath, "utf8"));
      if (mock.chainId === Number(network.config.chainId)) wlAddr = mock.mockWL;
    }
    if (!wlAddr && fs.existsSync(deployPath)) {
      const dep = JSON.parse(fs.readFileSync(deployPath, "utf8"));
      if (dep.chainId === Number(network.config.chainId)) wlAddr = dep.wl;
    }
  }
  if (!wlAddr || !ethers.isAddress(wlAddr)) {
    console.error("Could not resolve WL token address. Set WL=0x... env var or ensure mock-wl.json / deployments.json exist.");
    process.exit(1);
  }

  // ── resolve spender (WorldBet contract) ──
  let spender = process.env.SPENDER;
  if (!spender) {
    const deployPath = path.join(__dirname, "..", "deployments.json");
    if (fs.existsSync(deployPath)) {
      const dep = JSON.parse(fs.readFileSync(deployPath, "utf8"));
      if (dep.chainId === Number(network.config.chainId)) spender = dep.worldbet;
    }
  }
  if (!spender || !ethers.isAddress(spender)) {
    console.error("Could not resolve spender address. Set SPENDER=0x... env var or ensure deployments.json exists.");
    process.exit(1);
  }

  // ── resolve amount ──
  const amountStr = process.env.AMOUNT;
  const amount = amountStr ? ethers.parseUnits(amountStr, 18) : ethers.MaxUint256;

  // ── connect ──
  const provider = ethers.provider;
  const wallet = new ethers.Wallet(key.startsWith("0x") ? key : "0x" + key, provider);
  const token = new ethers.Contract(wlAddr, ERC20_ABI, wallet);

  const [sym, decimals, balance, allowanceBefore] = await Promise.all([
    token.symbol().catch(() => "???"),
    token.decimals().catch(() => 18n),
    token.balanceOf(wallet.address),
    token.allowance(wallet.address, spender),
  ]);
  const bnbBalance = await provider.getBalance(wallet.address);

  console.log(`Network   : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Account   : ${wallet.address}`);
  console.log(`BNB bal   : ${ethers.formatEther(bnbBalance)} BNB`);
  console.log(`WL token  : ${wlAddr} (${sym})`);
  console.log(`WL bal    : ${ethers.formatUnits(balance, decimals)} ${sym}`);
  console.log(`Spender   : ${spender}`);
  console.log(`Allowance (before): ${allowanceBefore === ethers.MaxUint256 ? "max" : ethers.formatUnits(allowanceBefore, decimals)} ${sym}`);
  console.log(`Approving : ${amount === ethers.MaxUint256 ? "max (uint256)" : ethers.formatUnits(amount, decimals) + " " + sym}`);
  console.log("");

  console.log("Sending approve() ...");
  const tx = await token.approve(spender, amount);
  console.log(`tx hash   : ${tx.hash}`);
  console.log("Waiting for confirmation ...");
  const rcpt = await tx.wait();
  console.log(`Confirmed : block=${rcpt.blockNumber} status=${rcpt.status === 1 ? "success" : "FAILED"}`);

  const allowanceAfter = await token.allowance(wallet.address, spender);
  console.log(`Allowance (after) : ${allowanceAfter === ethers.MaxUint256 ? "max" : ethers.formatUnits(allowanceAfter, decimals)} ${sym}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
