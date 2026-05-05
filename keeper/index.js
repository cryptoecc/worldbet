#!/usr/bin/env node
/* eslint-disable no-console */
// WorldBet keeper: drives the permissionless lockRound / settleRound
// transitions so users don't have to.
//
// Both calls are open to anyone — the keeper just needs a funded WL
// account to pay gas. Lock fails until the oracle bot has posted the
// hourly price; the keeper retries on the next tick. After the 30-min
// grace, lockRound / settleRound auto-refund instead of erroring.
//
// Env:
//   RPC_URL          required, WorldLand JSON-RPC
//   WORLDBET_ADDR    required, deployed WorldBet address
//   KEEPER_KEY       required, 0x... funded gas key (no privileges needed)
//   ASSETS           default "WL/USD,BTC/USD,ETH/USD"
//   POLL_MS          default 30000
//   LOOKBACK_ROUNDS  default 4 (rounds scanned around current)

const { ethers } = require("ethers");

const RPC      = process.env.RPC_URL;
const WB_ADDR  = process.env.WORLDBET_ADDR;
const KEY      = process.env.KEEPER_KEY;
const ASSETS   = (process.env.ASSETS || "WL/USD,BTC/USD,ETH/USD").split(",").map((s) => s.trim());
const POLL_MS  = parseInt(process.env.POLL_MS || "30000", 10);
const LOOKBACK = parseInt(process.env.LOOKBACK_ROUNDS || "4", 10);

const ABI = [
  "function currentRoundId() view returns (uint64)",
  "function roundView(bytes32 asset, uint64 id, address user) view returns (tuple(uint128 upPool, uint128 downPool, uint64 lockTime, uint64 closeTime, uint128 lockPrice, uint128 closePrice, uint8 status) r, tuple(uint128 upAmount, uint128 downAmount, bool claimed) b)",
  "function lockRound(bytes32 asset, uint64 id)",
  "function settleRound(bytes32 asset, uint64 id)",
];

const BENIGN = /oracle pending|lock first|too early|not open|settled|no round/i;

async function processOne(wb, label, key, id, now) {
  let r;
  try {
    const out = await wb.roundView(key, id, ethers.ZeroAddress);
    r = out[0];
  } catch (e) {
    return; // unreadable round — move on
  }

  const lockTime  = Number(r.lockTime);
  const closeTime = Number(r.closeTime);
  const status    = Number(r.status);

  // Round was never opened (no bets placed) → skip.
  if (lockTime === 0) return;

  // status: 0 open, 1 locked, 2 UP-wins, 3 DOWN-wins, 4 refund.
  if (status === 0 && now >= lockTime) {
    try {
      const tx = await wb.lockRound(key, id);
      const rcpt = await tx.wait();
      console.log(`[${label}] lock  #${id} tx=${rcpt.hash}`);
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e);
      if (!BENIGN.test(msg)) console.error(`[${label}] lock  #${id} ERR: ${msg}`);
    }
  }

  if (status < 2 && now >= closeTime) {
    try {
      const tx = await wb.settleRound(key, id);
      const rcpt = await tx.wait();
      console.log(`[${label}] settle #${id} tx=${rcpt.hash}`);
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e);
      if (!BENIGN.test(msg)) console.error(`[${label}] settle #${id} ERR: ${msg}`);
    }
  }
}

async function tick(wb) {
  const now = Math.floor(Date.now() / 1000);
  const cur = Number(await wb.currentRoundId());

  for (const label of ASSETS) {
    const key = ethers.id(label);
    for (let off = LOOKBACK; off >= 0; off--) {
      const id = cur - off;
      if (id < 0) continue;
      await processOne(wb, label, key, id, now);
    }
  }
}

async function main() {
  if (!RPC || !WB_ADDR || !KEY) {
    console.error("env required: RPC_URL, WORLDBET_ADDR, KEEPER_KEY");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(KEY.startsWith("0x") ? KEY : "0x" + KEY, provider);
  const wb = new ethers.Contract(WB_ADDR, ABI, signer);

  const net = await provider.getNetwork();
  console.log(`Keeper ${signer.address} chainId=${net.chainId} pollMs=${POLL_MS} assets=${ASSETS.join(",")}`);

  const run = async () => {
    try { await tick(wb); }
    catch (e) { console.error("tick:", e.message || e); }
  };

  await run();
  setInterval(run, POLL_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });
