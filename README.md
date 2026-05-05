# WorldBet

Hourly multi-asset pari-mutuel price-prediction market for **WorldLand Seoul mainnet (chainId 103)**.
Designed to drive direct WL buy pressure, deflation via burn, and viral growth via sticky referrals.

> **WLC vs WL.** Seoul mainnet's native gas coin is **WLC**. The market-listed asset on KuCoin / Gate / MEXC / HTX is the **WL** BRC-20 token (issued on Bitcoin via BNC). A future bridge will lock WL → mint WLC at 1:1, so the oracle's `WL/USD` feed is the forward-looking price of the bridged WLC. Bets are placed in WLC; the contract refers to that as "native WL" for clarity once the bridge is live. Pre-bridge, WLC has no exchange price — Seoul mainnet operates as a high-fidelity live testnet for the dApp.

## Mechanics

- **Markets**: WL/USD, BTC/USD, ETH/USD
- **Rounds**: 1 hour each, rolling — every UTC hour a new round opens for betting; the prior hour's bets go *live* once the lock price posts; the hour before that *settles* on the close price.
- **Bets**: native WLC (= WL post-bridge), UP or DOWN
- **Payout**: pari-mutuel — winners get back their stake plus their pro-rata slice of the loser pool. Contract has zero LP risk.
- **Fees (3% total)**:
  - 1.0% → weekly leaderboard prize pool (`prizePool`, owner-distributed off events)
  - 0.3% → sticky referrer rebate (claimable, falls back to burn if no referrer)
  - 1.7% → `pendingBurn`, anyone can call `burn()` to send to `0x000000000000000000000000000000000000dEaD`
- **Oracle**: 2-of-3 EIP-712 multisig. Bots fetch median spot from KuCoin / Gate / MEXC / HTX at every UTC hour, sign, and post on-chain.
- **Refund cases** (round status 4): one-sided pool, tie (lock == close), or oracle fails to post within a 30-minute grace window.
- **Anti-whale**: `setMaxBetPerRound(asset, cap)` — opt-in per-asset cap on a single user's bet in one round.

## Layout

```
worldbet/
├── contracts/
│   ├── PriceOracle.sol     M-of-N EIP-712 signed price feed
│   └── WorldBet.sol        multi-asset pari-mutuel rounds + fee split + burn
├── scripts/deploy.js       deploy Oracle + WorldBet, register WL/BTC/ETH
├── oracle/index.js         CEX sampler + median + EIP-712 sign + post
├── keeper/index.js         permissionless lockRound / settleRound driver
├── test/                   Foundry fuzz + stateful invariant tests
├── frontend/               Next.js + wagmi/viem (cards, burn counter, ref link)
├── hardhat.config.js       seoul (103) + gwangju (10395), London EVM, 0.8.24
├── foundry.toml            Solidity 0.8.24, fuzz=1000 / invariant=100×50
└── README.md
```

## Install & deploy

```bash
npm install

# 0. Verify CEX listings before anything else. Each market needs >= 2
#    healthy venues for the median to work. Fix symbols / drop markets
#    if any asset is short.
npm run check:cex            # WL, BTC, ETH

# 1. Three signer setup (one key per host in production):
export DEPLOYER_KEY=0x...                    # funded WLC on Seoul
export ORACLE_SIGNERS=0xAAA...,0xBBB...,0xCCC...
export ORACLE_THRESHOLD=2

# 2. Compile + deploy
npx hardhat compile
npx hardhat run scripts/deploy.js --network seoul   # mainnet
# Gwangju is currently inactive; redirect to seoul.
```

`deployments.json` is written next to the package with the addresses, signer set, and registered asset keys.

### Conservative initial caps (post-deploy, before announcing)

While the dApp is in soft-launch (pre-bridge, WLC has no exchange price), set tight caps so a bad oracle post or bug only loses bounded WLC. The owner can loosen them after monitoring the first 24 hours.

```bash
# from a hardhat console on the deployer key:
npx hardhat console --network seoul
> const wb = await ethers.getContractAt("WorldBet", "0x...");
> const cap = ethers.parseEther("10");   // 10 WLC per user per round
> for (const k of ["WL/USD","BTC/USD","ETH/USD"]) await wb.setMaxBetPerRound(ethers.id(k), cap);
```

### Deployment safety reminders (pre-bridge regime)

- **No emergency pause.** Once funds are bet, only the existing refund paths can return them (one-sided pool, tie, oracle missed past grace). For a critical bug the owner can `setMaxBetPerRound(asset, 1)` to block new bets per asset; in-flight rounds still settle on whatever oracle posts. Add a real `pause()` + `emergencyRefund()` before the WL→WLC bridge goes live (= before WLC has fiat value).
- **Audit before bridge launch.** Self-checked with 32 unit/fuzz tests + 5 stateful invariants × 5000 calls. External audit ($5–10k single-contract scope) recommended before WLC has tradeable value.
- **Oracle must be 3-host.** Single-host combined mode with all keys is fine while WLC has no value; before bridge launch, distribute the 3 keys across separate machines and use the peer signature sidecar.

## Run the oracle bot

Combined mode (single host, holds 2 of 3 keys — fine for testnet, **not recommended for mainnet**):

```bash
export RPC_URL=https://seoul.worldland.foundation
export ORACLE_ADDR=0x...                     # from deployments.json
export SIGNER_KEYS=0xkey1,0xkey2             # >= threshold
node oracle/index.js
```

Distributed mode (one key per host, peers exchange signatures over HTTP):

```bash
# host A
SIGNER_KEYS=0xkeyA SIDECAR=1 PEER_PORT=8787 \
PEER_SIG_URLS=http://hostB:8787,http://hostC:8787 \
node oracle/index.js

# host B / C — same shape, different keys
```

The leader (any host) submits to chain once `>=` threshold valid signatures are gathered.

## Frontend

```bash
cd frontend
cp .env.example .env.local        # set NEXT_PUBLIC_WORLDBET_ADDRESS
npm install
npm run dev
```

The page reads pool sizes, locks countdown, your bet, the burn counter, and your referral link (`?ref=0x...`). Bets and burn are user-triggered; no admin keys are loaded.

## Operator runbook (per UTC hour)

For round `N` opened at hour `T`:

| When           | Who   | Action                                                            |
|----------------|-------|-------------------------------------------------------------------|
| `T` … `T+1h`   | users | place UP/DOWN bets via UI                                         |
| around `T+1h`  | bot   | post oracle price for `hourId = T/3600 + 1` (= round N's lock)    |
| any            | any   | call `lockRound(asset, N)` once lock price is on chain            |
| around `T+2h`  | bot   | post oracle price for `hourId = T/3600 + 2` (= round N's close)   |
| any            | any   | call `settleRound(asset, N)`                                      |
| any            | user  | `claim(asset, N)` to collect winnings or refund                   |
| any            | any   | `burn()` flushes `pendingBurn` to `0x...dEaD`                     |

The included `keeper/` does this automatically: it polls every 30s, calls `lockRound` once the oracle has posted, and `settleRound` once `closeTime` passes. Lock failures while the oracle is still pending are silently retried; after the 30-min grace, the contract auto-refunds.

```bash
export RPC_URL=https://seoul.worldland.foundation
export WORLDBET_ADDR=0x...
export KEEPER_KEY=0x...               # any funded WL key (no privileges needed)
node keeper/index.js
# or: npm run keeper
```

Run it on the same host as the oracle bot or independently — both are stateless and idempotent.

## Soft-launch checklist (pre-bridge regime)

WLC has no fiat price yet — Seoul mainnet acts as a high-fidelity live testnet for the dApp.

- [ ] `npm run check:cex` returns >= 2 venues for WL/USD; otherwise drop the WL/USD market or fix `oracle/index.js` symbol map
- [ ] `forge test` green (32 unit/fuzz + 5 invariants)
- [ ] Deploy to Seoul (chainId 103) with `ORACLE_THRESHOLD=2`, 3 distinct signer addresses
- [ ] Set `setMaxBetPerRound` to a low value (e.g. 10 WLC) on every asset before announcing
- [ ] Oracle bot + keeper bot running; manually verify the first hourly post lands on chain
- [ ] Dashboard / explorer link to the contract pinned in the community channel
- [ ] First 24h: monitor for one-sided rounds, oracle misses, gas anomalies

## Bridge-launch hardening (before WLC trades against fiat)

These become hard requirements once a single bet has real-money value:

- [ ] Add `pause()` + `emergencyRefund(asset, id)` admin functions; redo fuzz/invariants
- [ ] External audit ($5–10k) — single contract, ~370 LoC
- [ ] 3 signer keys on 3 separate hosts (not combined-mode); peer signature sidecar
- [ ] Lock/settle keeper redundancy (>= 2 instances)
- [ ] Initial liquidity bot to seed the first hours of each asset's pool
- [ ] Referral link landing page + Discord/Telegram bot
- [ ] Twitter thread template with the burn counter snapshot
- [ ] Weekly leaderboard cron: read `BetPlaced` / `Claimed` events, rank by net WLC, call `distributePrize(...)`
- [ ] Loosen `setMaxBetPerRound` after telemetry stabilizes

## Decisions on record

- **Oracle**: 2-of-3 EIP-712 multisig with median CEX pricing (no Chainlink/Pyth on WorldLand inner-tree at present).
- **Markets**: WL, BTC, ETH launched simultaneously — diversifies user mindshare and prevents single-asset stagnation.
- **Pari-mutuel** (not order-book or AMM): zero protocol risk, payouts capped to the pool.
- **Burn destination**: `0x...dEaD`, permissionless trigger so anyone can flush for the social-proof event.

## Out of scope (follow-ups)

- Foundry fuzz tests on payout math, oracle threshold edge cases, refund paths.
- Auto-lock/settle keeper.
- Production signer-relay infra (HSM, signature sidecar hardening).
- Front-end deployment (Vercel) + analytics.
