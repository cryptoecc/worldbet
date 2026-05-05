# WorldBet Foundry tests

Fuzz + unit tests for `contracts/PriceOracle.sol` and `contracts/WorldBet.sol`.

## One-time setup

Install Foundry (Linux/macOS/WSL):

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Windows: `winget install Foundry.Foundry` or use WSL.

Install `forge-std` (test helpers):

```bash
forge install foundry-rs/forge-std --no-commit
```

This populates `lib/forge-std/`. The remap is wired via `remappings.txt`.

## Run

```bash
forge test               # all tests, default 1000 fuzz runs
forge test -vv           # with logs
forge test --match-test testFuzz_Payout_UpWins -vvv
forge test --gas-report
```

Tune fuzz runs in `foundry.toml` (`fuzz.runs`) or per-invocation: `forge test --fuzz-runs 10000`.

## What's covered

### `WorldBet.t.sol`
- **Fee split conservation** (fuzz over amount): `net + prize + ref + burn == amount`, exactly.
- **Referral routing**: rebate goes to referrer or burn (no leak); sticky after first set; self-ref ignored.
- **Payout math** (fuzz over up/down amounts): single-winner pro-rata + multi-winner split, no overpayment.
- **Refund paths**: one-sided pool, tie price, oracle missed lock past 30-min grace.
- **Claim guarantees**: double-claim reverts, claim-before-settle reverts.
- **Anti-whale cap** via `setMaxBetPerRound`.
- **Burn**: flushes `pendingBurn` to `0x...dEaD`, increments `totalBurned`.
- **Access control**: only owner can register assets / distribute prize.
- **Single-round solvency** (fuzz): post-claim contract balance equals `prizePool + pendingBurn` (within 2 wei rounding).

### `PriceOracle.t.sol`
- Happy path with exactly threshold sigs and with extra sigs (early-break).
- Rejects: < threshold, duplicate signer, intruder signer, tampered digest, replay, zero price.
- **High-s malleability**: flipping `s` to `n - s` is rejected.
- Admin: add/remove signer, threshold floor, owner-only gating.
- Fuzz: any 2-of-3 distinct signer combination is accepted.

## Out of scope (follow-ups)

- Stateful invariant tests (`invariant_*` functions targeting `WorldBet` over random call sequences).
- Gas regression baseline.
- Integration test that drives the JS oracle bot's signed payload through the real `PriceOracle.postPrice`.
