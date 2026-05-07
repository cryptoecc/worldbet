// Utility to manually interact with the WorldBet contract.
// All commands are available to any funded account; admin commands require the contract owner.
//
// ── View / Info ───────────────────────────────────────────────────────────────
//   COMMAND=info
//       Contract overview: owner, assets, pools, pending burn, total burned.
//
//   COMMAND=round ASSET=WL/USD [ID=<roundId>]
//       Full round state for an asset. Defaults to the current round.
//
//   COMMAND=bet-info ASSET=WL/USD ID=<roundId> USER=0x...
//       A specific user's bet inside a given round.
//
//   COMMAND=referral [USER=0x...]
//       Referrer address and claimable referral balance (defaults to signer).
//
// ── Keeper (permissionless — any funded account) ──────────────────────────────
//   COMMAND=lock   ASSET=WL/USD ID=<roundId>
//       Call lockRound() for the given asset and round.
//
//   COMMAND=settle ASSET=WL/USD ID=<roundId>
//       Call settleRound() for the given asset and round.
//
//   COMMAND=sweep [LOOKBACK=4]
//       Attempt lockRound / settleRound across all registered assets for the
//       last LOOKBACK rounds. Use for manual recovery when the keeper bot is down.
//
// ── User ──────────────────────────────────────────────────────────────────────
//   COMMAND=bet ASSET=WL/USD DIR=up|down AMOUNT=<wl> [REF=0x...]
//       Place a bet on the current round. Auto-approves WL if allowance is low.
//
//   COMMAND=claim ASSET=WL/USD ID=<roundId>
//       Claim winnings or refund for a finalized round.
//
//   COMMAND=claim-referral
//       Withdraw accrued referral rebates to the signer address.
//
//   COMMAND=burn
//       Flush accumulated burn-share fees to the dead address (0x...dEaD).
//
// ── Admin (owner only) ────────────────────────────────────────────────────────
//   COMMAND=register-asset ASSET=FOO/USD
//       Register a new trading pair.
//
//   COMMAND=set-max-bet ASSET=WL/USD AMOUNT=<wl>
//       Set per-round bet cap for an asset. AMOUNT=0 removes the cap.
//
//   COMMAND=set-owner OWNER=0x...
//       Transfer WorldBet contract ownership.
//
//   COMMAND=distribute-prize RECIPIENTS=0x1,0x2 AMOUNTS=<wl1>,<wl2>
//       Distribute leaderboard prize pool to winners.
//
// Examples:
//   COMMAND=info npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=round ASSET=WL/USD npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=round ASSET=WL/USD ID=471 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=lock ASSET=WL/USD ID=471 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=settle ASSET=WL/USD ID=471 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=sweep LOOKBACK=6 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=bet ASSET=WL/USD DIR=up AMOUNT=50 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=claim ASSET=WL/USD ID=471 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=claim-referral npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=burn npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=referral USER=0x... npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=bet-info ASSET=WL/USD ID=471 USER=0x... npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=register-asset ASSET=FOO/USD npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=set-max-bet ASSET=WL/USD AMOUNT=10000 npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=set-owner OWNER=0x... npx hardhat run scripts/manage-worldbet.js --network bscTestnet
//   COMMAND=distribute-prize RECIPIENTS=0x1,0x2 AMOUNTS=100,200 npx hardhat run scripts/manage-worldbet.js --network bscTestnet

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const WORLDBET_ABI = [
  // ── auto-getters ──
  "function owner() view returns (address)",
  "function prizePool() view returns (uint256)",
  "function pendingBurn() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function assetCount() view returns (uint256)",
  "function assets(uint256 index) view returns (bytes32)",
  "function assetRegistered(bytes32) view returns (bool)",
  "function maxBetPerRound(bytes32) view returns (uint128)",
  "function referrer(address) view returns (address)",
  "function referralBalance(address) view returns (uint256)",
  // ── views ──
  "function currentRoundId() view returns (uint64)",
  "function roundView(bytes32 asset, uint64 id, address user) view returns (tuple(uint128 upPool, uint128 downPool, uint64 lockTime, uint64 closeTime, uint128 lockPrice, uint128 closePrice, uint8 status) r, tuple(uint128 upAmount, uint128 downAmount, bool claimed) b)",
  // ── user ──
  "function bet(bytes32 asset, uint8 dir, address ref, uint256 amount)",
  "function claim(bytes32 asset, uint64 id)",
  "function claimReferral()",
  "function burn()",
  // ── keeper (permissionless) ──
  "function lockRound(bytes32 asset, uint64 id)",
  "function settleRound(bytes32 asset, uint64 id)",
  // ── admin ──
  "function setOwner(address _owner)",
  "function registerAsset(bytes32 key)",
  "function setMaxBetPerRound(bytes32 asset, uint128 cap)",
  "function distributePrize(address[] recipients, uint256[] amounts)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
  "function symbol() view returns (string)",
];

// ── helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL = ["Open", "Locked", "UP Wins", "DOWN Wins", "Refund"];

// Accept "WL/USD" (name) or a raw 0x-prefixed bytes32.
function assetKey(nameOrBytes32) {
  if (/^0x[0-9a-fA-F]{64}$/.test(nameOrBytes32)) return nameOrBytes32;
  return ethers.id(nameOrBytes32);
}

function fmtWL(wei) {
  return ethers.formatUnits(wei, 18) + " WL";
}

// Oracle prices are 8-decimal fixed-point.
function fmtPrice(raw) {
  if (raw === 0n) return "—";
  return (Number(raw) / 1e8).toFixed(8);
}

function fmtTime(unix) {
  if (Number(unix) === 0) return "—";
  return new Date(Number(unix) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function printRound(r, b, label, id) {
  const status = Number(r.status);
  const lockTime = Number(r.lockTime);
  const now = Math.floor(Date.now() / 1000);

  let timing = "";
  if (status === 0 && lockTime > 0) {
    const secsToLock = lockTime - now;
    timing = secsToLock > 0
      ? `  (locks in ${Math.ceil(secsToLock / 60)} min)`
      : `  (lock overdue by ${Math.ceil(-secsToLock / 60)} min)`;
  }

  console.log(`\nRound #${id}  [${label}]`);
  console.log(`  Status     : ${status} — ${STATUS_LABEL[status] ?? "Unknown"}${timing}`);
  console.log(`  Lock time  : ${fmtTime(r.lockTime)}`);
  console.log(`  Close time : ${fmtTime(r.closeTime)}`);
  console.log(`  Lock price : ${fmtPrice(r.lockPrice)}`);
  console.log(`  Close price: ${fmtPrice(r.closePrice)}`);
  console.log(`  UP pool    : ${fmtWL(r.upPool)}`);
  console.log(`  DOWN pool  : ${fmtWL(r.downPool)}`);
  if (b && (b.upAmount > 0n || b.downAmount > 0n)) {
    console.log(`  Your bet   : UP=${fmtWL(b.upAmount)}  DOWN=${fmtWL(b.downAmount)}  claimed=${b.claimed}`);
  }
}

// Resolve a registered asset's name from deployments.json assets map.
function resolveAssetName(key, deployment) {
  const entry = Object.entries(deployment.assets || {}).find(([, v]) => v === key);
  return entry ? entry[0] : key;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.env.COMMAND;

  if (!command) {
    printHelp();
    process.exit(1);
  }

  const deployPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deployPath)) {
    throw new Error("deployments.json not found. Run deploy.js first.");
  }
  const deployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));

  if (deployment.chainId !== Number(network.config.chainId)) {
    throw new Error(
      `Chain mismatch: deployments.json has chainId ${deployment.chainId} but network is ${network.config.chainId}`
    );
  }

  const [signer] = await ethers.getSigners();
  const wb = new ethers.Contract(deployment.worldbet, WORLDBET_ABI, signer);

  console.log(`Network  : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`WorldBet : ${deployment.worldbet}`);
  console.log(`Signer   : ${signer.address}`);
  console.log("");

  switch (command) {
    // ── info ──
    case "info":             return await cmdInfo(wb, deployment);
    case "round":            return await cmdRound(wb, signer, deployment);
    case "bet-info":         return await cmdBetInfo(wb, deployment);
    case "referral":         return await cmdReferral(wb, signer);
    // ── keeper ──
    case "lock":             return await cmdLock(wb);
    case "settle":           return await cmdSettle(wb);
    case "sweep":            return await cmdSweep(wb, deployment);
    // ── user ──
    case "bet":              return await cmdBet(wb, signer, deployment);
    case "claim":            return await cmdClaim(wb);
    case "claim-referral":   return await cmdClaimReferral(wb, signer);
    case "burn":             return await cmdBurn(wb);
    // ── admin ──
    case "register-asset":   return await cmdRegisterAsset(wb);
    case "set-max-bet":      return await cmdSetMaxBet(wb);
    case "set-owner":        return await cmdSetOwner(wb);
    case "distribute-prize": return await cmdDistributePrize(wb);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// ── command implementations ───────────────────────────────────────────────────

async function cmdInfo(wb, deployment) {
  const [owner, curId, prizePool, pendingBurn, totalBurned, count] = await Promise.all([
    wb.owner(),
    wb.currentRoundId(),
    wb.prizePool(),
    wb.pendingBurn(),
    wb.totalBurned(),
    wb.assetCount(),
  ]);

  console.log(`Owner        : ${owner}`);
  console.log(`Current ID   : ${curId}`);
  console.log(`Prize pool   : ${fmtWL(prizePool)}`);
  console.log(`Pending burn : ${fmtWL(pendingBurn)}`);
  console.log(`Total burned : ${fmtWL(totalBurned)}`);
  console.log(`\nAssets (${count}):`);

  for (let i = 0; i < Number(count); i++) {
    const key = await wb.assets(i);
    const cap = await wb.maxBetPerRound(key);
    const name = resolveAssetName(key, deployment);
    const capStr = cap > 0n ? `  cap=${fmtWL(cap)}` : "  no cap";
    console.log(`  [${i}] ${name}${capStr}`);
  }
}

async function cmdRound(wb, signer, deployment) {
  const assetName = process.env.ASSET;
  if (!assetName) throw new Error("ASSET env var required (e.g. ASSET=WL/USD)");

  const key = assetKey(assetName);
  const curId = await wb.currentRoundId();
  const id = process.env.ID !== undefined ? BigInt(process.env.ID) : curId;

  const [r, b] = await wb.roundView(key, id, signer.address);

  if (r.lockTime === 0n) {
    console.log(`Round #${id} [${assetName}]: not yet created (no bets placed).`);
    return;
  }

  printRound(r, b, assetName, id);
}

async function cmdBetInfo(wb, deployment) {
  const assetName = process.env.ASSET;
  const user = process.env.USER;
  const id = process.env.ID;

  if (!assetName) throw new Error("ASSET env var required");
  if (!user || !ethers.isAddress(user)) throw new Error("USER env var required (valid address)");
  if (id === undefined) throw new Error("ID env var required");

  const key = assetKey(assetName);
  const [r, b] = await wb.roundView(key, BigInt(id), user);

  printRound(r, b, assetName, id);
  console.log(`\n  Queried user: ${user}`);
}

async function cmdReferral(wb, signer) {
  const user = process.env.USER || signer.address;
  if (!ethers.isAddress(user)) throw new Error("USER is not a valid address");

  const [ref, bal] = await Promise.all([
    wb.referrer(user),
    wb.referralBalance(user),
  ]);

  console.log(`User             : ${user}`);
  console.log(`Referrer set to  : ${ref === ethers.ZeroAddress ? "(none)" : ref}`);
  console.log(`Referral balance : ${fmtWL(bal)}`);
}

// ── keeper ────────────────────────────────────────────────────────────────────

async function cmdLock(wb) {
  const assetName = process.env.ASSET;
  const id = process.env.ID;
  if (!assetName) throw new Error("ASSET env var required");
  if (id === undefined) throw new Error("ID env var required");

  const key = assetKey(assetName);
  console.log(`Calling lockRound(${assetName}, ${id})...`);
  const tx = await wb.lockRound(key, BigInt(id));
  const rcpt = await tx.wait();
  console.log(`✓ lockRound confirmed  tx=${rcpt.hash}`);
}

async function cmdSettle(wb) {
  const assetName = process.env.ASSET;
  const id = process.env.ID;
  if (!assetName) throw new Error("ASSET env var required");
  if (id === undefined) throw new Error("ID env var required");

  const key = assetKey(assetName);
  console.log(`Calling settleRound(${assetName}, ${id})...`);
  const tx = await wb.settleRound(key, BigInt(id));
  const rcpt = await tx.wait();
  console.log(`✓ settleRound confirmed  tx=${rcpt.hash}`);
}

async function cmdSweep(wb, deployment) {
  const lookback = parseInt(process.env.LOOKBACK || "4", 10);
  const curId = Number(await wb.currentRoundId());
  const count = Number(await wb.assetCount());
  const now = Math.floor(Date.now() / 1000);

  console.log(`Sweeping rounds [${curId - lookback} … ${curId}] across ${count} asset(s)...\n`);

  let locked = 0, settled = 0, skipped = 0;

  for (let i = 0; i < count; i++) {
    const key = await wb.assets(i);
    const label = resolveAssetName(key, deployment);

    for (let off = lookback; off >= 0; off--) {
      const id = curId - off;
      if (id < 0) continue;

      let r;
      try {
        const out = await wb.roundView(key, id, ethers.ZeroAddress);
        r = out[0];
      } catch {
        continue;
      }

      if (r.lockTime === 0n) continue; // no bets placed

      const lockTime = Number(r.lockTime);
      const closeTime = Number(r.closeTime);
      let status = Number(r.status);

      if (status === 0 && now >= lockTime) {
        try {
          const tx = await wb.lockRound(key, id);
          const rcpt = await tx.wait();
          console.log(`  lock   [${label}] #${id}  tx=${rcpt.hash}`);
          locked++;
          // Re-read on-chain status before attempting settle below.
          try {
            const fresh = await wb.roundView(key, id, ethers.ZeroAddress);
            status = Number(fresh[0].status);
          } catch { /* keep stale */ }
        } catch (e) {
          const msg = e.shortMessage || e.message;
          console.log(`  lock   [${label}] #${id}  skipped — ${msg}`);
          skipped++;
        }
      }

      if (status < 2 && now >= closeTime) {
        try {
          const tx = await wb.settleRound(key, id);
          const rcpt = await tx.wait();
          console.log(`  settle [${label}] #${id}  tx=${rcpt.hash}`);
          settled++;
        } catch (e) {
          const msg = e.shortMessage || e.message;
          console.log(`  settle [${label}] #${id}  skipped — ${msg}`);
          skipped++;
        }
      }
    }
  }

  console.log(`\nSweep complete. locked=${locked} settled=${settled} skipped=${skipped}`);
}

// ── user ──────────────────────────────────────────────────────────────────────

async function cmdBet(wb, signer, deployment) {
  const assetName = process.env.ASSET;
  const dirStr = (process.env.DIR || "").toLowerCase();
  const amountStr = process.env.AMOUNT;
  const ref = process.env.REF || ethers.ZeroAddress;

  if (!assetName) throw new Error("ASSET env var required");
  if (dirStr !== "up" && dirStr !== "down") throw new Error("DIR must be 'up' or 'down'");
  if (!amountStr) throw new Error("AMOUNT env var required (in whole WL, e.g. AMOUNT=100)");
  if (!ethers.isAddress(ref)) throw new Error("REF is not a valid address");

  const key = assetKey(assetName);
  const dir = dirStr === "up" ? 0 : 1;
  const amount = ethers.parseUnits(amountStr, 18);

  // Auto-approve WL if allowance is insufficient.
  const wlToken = new ethers.Contract(deployment.wl, ERC20_ABI, signer);
  const [sym, allowance, balance] = await Promise.all([
    wlToken.symbol().catch(() => "WL"),
    wlToken.allowance(signer.address, deployment.worldbet),
    wlToken.balanceOf(signer.address),
  ]);

  console.log(`Balance   : ${fmtWL(balance)} ${sym}`);
  if (balance < amount) throw new Error(`Insufficient balance: have ${fmtWL(balance)}, need ${fmtWL(amount)}`);

  if (allowance < amount) {
    console.log(`Approving ${fmtWL(amount)} ${sym} to WorldBet...`);
    const approveTx = await wlToken.approve(deployment.worldbet, amount);
    await approveTx.wait();
    console.log("  ✓ Approved");
  }

  const curId = await wb.currentRoundId();
  console.log(`Placing ${dirStr.toUpperCase()} bet of ${fmtWL(amount)} on ${assetName} round #${curId}...`);
  const tx = await wb.bet(key, dir, ref, amount);
  const rcpt = await tx.wait();
  console.log(`✓ Bet placed  tx=${rcpt.hash}`);
}

async function cmdClaim(wb) {
  const assetName = process.env.ASSET;
  const id = process.env.ID;
  if (!assetName) throw new Error("ASSET env var required");
  if (id === undefined) throw new Error("ID env var required");

  const key = assetKey(assetName);
  console.log(`Claiming ${assetName} round #${id}...`);
  const tx = await wb.claim(key, BigInt(id));
  const rcpt = await tx.wait();
  console.log(`✓ Claimed  tx=${rcpt.hash}`);
}

async function cmdClaimReferral(wb, signer) {
  const bal = await wb.referralBalance(signer.address);
  if (bal === 0n) {
    console.log("No referral balance to claim.");
    return;
  }
  console.log(`Claiming referral balance: ${fmtWL(bal)}...`);
  const tx = await wb.claimReferral();
  const rcpt = await tx.wait();
  console.log(`✓ Referral claimed  tx=${rcpt.hash}`);
}

async function cmdBurn(wb) {
  const pending = await wb.pendingBurn();
  if (pending === 0n) {
    console.log("No pending burn to flush.");
    return;
  }
  console.log(`Flushing ${fmtWL(pending)} to dead address...`);
  const tx = await wb.burn();
  const rcpt = await tx.wait();
  console.log(`✓ Burned  tx=${rcpt.hash}`);
}

// ── admin ─────────────────────────────────────────────────────────────────────

async function cmdRegisterAsset(wb) {
  const assetName = process.env.ASSET;
  if (!assetName) throw new Error("ASSET env var required (e.g. ASSET=FOO/USD)");

  const key = assetKey(assetName);
  const already = await wb.assetRegistered(key);
  if (already) {
    console.error(`Error: ${assetName} is already registered`);
    process.exit(1);
  }

  console.log(`Registering asset: ${assetName}`);
  console.log(`  key = ${key}`);
  const tx = await wb.registerAsset(key);
  const rcpt = await tx.wait();
  console.log(`✓ Asset registered  tx=${rcpt.hash}`);
}

async function cmdSetMaxBet(wb) {
  const assetName = process.env.ASSET;
  const amountStr = process.env.AMOUNT;
  if (!assetName) throw new Error("ASSET env var required");
  if (amountStr === undefined) throw new Error("AMOUNT env var required (WL amount; 0 = remove cap)");

  const key = assetKey(assetName);
  const cap = ethers.parseUnits(amountStr, 18);

  console.log(`Setting max bet for ${assetName}: ${cap === 0n ? "no cap (removing limit)" : fmtWL(cap)}...`);
  const tx = await wb.setMaxBetPerRound(key, cap);
  const rcpt = await tx.wait();
  console.log(`✓ Max bet updated  tx=${rcpt.hash}`);
}

async function cmdSetOwner(wb) {
  const newOwner = process.env.OWNER;
  if (!newOwner || !ethers.isAddress(newOwner)) throw new Error("OWNER env var required (valid address)");

  const current = await wb.owner();
  console.log(`Current owner: ${current}`);
  console.log(`New owner    : ${newOwner}`);
  const tx = await wb.setOwner(newOwner);
  const rcpt = await tx.wait();
  console.log(`✓ Ownership transferred  tx=${rcpt.hash}`);
}

async function cmdDistributePrize(wb) {
  const recipStr = process.env.RECIPIENTS;
  const amtStr = process.env.AMOUNTS;
  if (!recipStr) throw new Error("RECIPIENTS env var required (comma-separated addresses)");
  if (!amtStr) throw new Error("AMOUNTS env var required (comma-separated WL amounts)");

  const recipients = recipStr.split(",").map((s) => s.trim());
  const amounts = amtStr.split(",").map((s) => ethers.parseUnits(s.trim(), 18));

  if (recipients.length !== amounts.length) {
    throw new Error("RECIPIENTS and AMOUNTS must have the same number of entries");
  }
  for (const r of recipients) {
    if (!ethers.isAddress(r)) throw new Error(`Invalid address: ${r}`);
  }

  const pool = await wb.prizePool();
  const total = amounts.reduce((a, b) => a + b, 0n);

  console.log(`Prize pool   : ${fmtWL(pool)}`);
  console.log(`Distributing : ${fmtWL(total)}`);
  if (total > pool) throw new Error(`Distribution ${fmtWL(total)} exceeds prize pool ${fmtWL(pool)}`);

  console.log("\nRecipients:");
  for (let i = 0; i < recipients.length; i++) {
    console.log(`  ${recipients[i]}  ${fmtWL(amounts[i])}`);
  }

  const tx = await wb.distributePrize(recipients, amounts);
  const rcpt = await tx.wait();
  console.log(`\n✓ Prize distributed  tx=${rcpt.hash}`);
}

// ── help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.error(`
Usage: COMMAND=<cmd> [ARGS...] npx hardhat run scripts/manage-worldbet.js --network <NETWORK>

View / Info
  COMMAND=info
  COMMAND=round        ASSET=WL/USD  [ID=<roundId>]
  COMMAND=bet-info     ASSET=WL/USD   ID=<roundId>   USER=0x...
  COMMAND=referral    [USER=0x...]

Keeper  (permissionless — any funded account)
  COMMAND=lock         ASSET=WL/USD   ID=<roundId>
  COMMAND=settle       ASSET=WL/USD   ID=<roundId>
  COMMAND=sweep       [LOOKBACK=4]

User
  COMMAND=bet          ASSET=WL/USD   DIR=up|down   AMOUNT=<wl>  [REF=0x...]
  COMMAND=claim        ASSET=WL/USD   ID=<roundId>
  COMMAND=claim-referral
  COMMAND=burn

Admin  (owner only)
  COMMAND=register-asset    ASSET=FOO/USD
  COMMAND=set-max-bet       ASSET=WL/USD   AMOUNT=<wl>   (0 = no cap)
  COMMAND=set-owner         OWNER=0x...
  COMMAND=distribute-prize  RECIPIENTS=0x1,0x2   AMOUNTS=<wl1>,<wl2>
`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
