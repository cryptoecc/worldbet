import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useReadContract, useReadContracts, useWriteContract, useChainId } from "wagmi";
import { keccak256, parseUnits, formatUnits, toBytes, zeroAddress, maxUint256 } from "viem";
import { WORLDBET_ABI, ERC20_ABI, ORACLE_ABI } from "../lib/abi";
import { ASSETS, WORLDBET_ADDRESS, WL_TOKEN_ADDRESS, ORACLE_ADDRESS, DEFAULT_CHAIN_ID } from "../lib/chain";

const assetKey = (label) => keccak256(toBytes(label));

function useReferrer() {
  const [ref, setRef] = useState(zeroAddress);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("ref");
    if (r && /^0x[0-9a-fA-F]{40}$/.test(r)) {
      setRef(r);
      try { localStorage.setItem("worldbet:ref", r); } catch {}
    } else {
      try {
        const cached = localStorage.getItem("worldbet:ref");
        if (cached && /^0x[0-9a-fA-F]{40}$/.test(cached)) setRef(cached);
      } catch {}
    }
  }, []);
  return ref;
}

function fmtWL(v, decimals = 18) {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, decimals));
  if (n === 0) return "0";
  if (n < 0.001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function AssetCard({ label, account, referrer, allowance, onApprove }) {
  const key = useMemo(() => assetKey(label), [label]);
  const { data: roundId } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "currentRoundId",
    query: { refetchInterval: 5000 },
  });
  const { data: rv } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "roundView",
    args: roundId !== undefined ? [key, roundId, account || zeroAddress] : undefined,
    query: { enabled: roundId !== undefined, refetchInterval: 5000 },
  });
  const { writeContract, isPending } = useWriteContract();

  const [amount, setAmount] = useState("100");
  const amountWei = useMemo(() => {
    try { return parseUnits(amount || "0", 18); } catch { return 0n; }
  }, [amount]);

  const needsApprove = account && amountWei > 0n && (allowance ?? 0n) < amountWei;

  const placeBet = (dir) => {
    if (!WORLDBET_ADDRESS || !account || amountWei === 0n) return;
    writeContract({
      address: WORLDBET_ADDRESS, abi: WORLDBET_ABI,
      functionName: "bet",
      args: [key, dir, referrer || zeroAddress, amountWei],
    });
  };

  const round = rv?.[0];
  const bet = rv?.[1];
  const lockTs = round?.lockTime ? Number(round.lockTime) : 0;
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const secLeft = Math.max(0, lockTs - now);
  const upPool = round?.upPool ?? 0n;
  const downPool = round?.downPool ?? 0n;
  const total = upPool + downPool;
  const upPct = total > 0n ? Number((upPool * 10000n) / total) / 100 : 50;

  return (
    <div className="card">
      <div className="row between">
        <h2>{label}</h2>
        <div className="muted">round #{roundId?.toString?.() ?? "—"}</div>
      </div>
      <div className="row between mt8">
        <div>UP pool: <b>{fmtWL(upPool)}</b> WL</div>
        <div>DOWN pool: <b>{fmtWL(downPool)}</b> WL</div>
      </div>
      <div className="bar mt8"><div style={{ width: `${upPct}%` }} /></div>
      <div className="row between mt8 muted">
        <span>{upPct.toFixed(1)}% UP</span>
        <span>locks in {Math.floor(secLeft / 60)}:{String(secLeft % 60).padStart(2, "0")}</span>
      </div>
      <div className="bet-row mt12">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="WL amount" />
        <div className="bet-btns">
          {needsApprove ? (
            <button onClick={onApprove} disabled={!account || isPending} className="approve">Approve WL</button>
          ) : (
            <>
              <button onClick={() => placeBet(0)} disabled={!account || isPending}>UP</button>
              <button onClick={() => placeBet(1)} disabled={!account || isPending} className="down">DOWN</button>
            </>
          )}
        </div>
      </div>
      {bet && (Number(bet.upAmount) > 0 || Number(bet.downAmount) > 0) && (
        <div className="muted mt8">
          your bet: UP {fmtWL(bet.upAmount)} / DOWN {fmtWL(bet.downAmount)}
          {bet.claimed ? " (claimed)" : ""}
        </div>
      )}
    </div>
  );
}

// ── Bet History ───────────────────────────────────────────────────────────────

const HISTORY_LOOKBACK = 24; // rounds to scan (= last 24 hours)
const HISTORY_MAX = 5;       // rows to display

const STATUS_LABEL = ["Open", "Locked", "UP Wins", "DOWN Wins", "Refund"];

function dirLabel(b) {
  const hasUp  = b.upAmount  > 0n;
  const hasDown = b.downAmount > 0n;
  if (hasUp && hasDown) return "UP+DOWN";
  return hasUp ? "UP" : "DOWN";
}

function BetHistory({ account }) {
  const { data: currentId } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "currentRoundId",
    query: { refetchInterval: 5000 },
  });

  // Build one roundView call per (asset × roundId).
  const calls = useMemo(() => {
    if (!account || currentId == null || !WORLDBET_ADDRESS) return [];
    const cur = Number(currentId);
    return ASSETS.flatMap(({ key }) =>
      Array.from({ length: HISTORY_LOOKBACK }, (_, i) => cur - i)
        .filter((id) => id >= 0)
        .map((id) => ({
          address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "roundView",
          args: [assetKey(key), BigInt(id), account],
        }))
    );
  }, [account, currentId]);

  const { data: results, refetch } = useReadContracts({
    contracts: calls,
    query: { enabled: calls.length > 0, refetchInterval: 10000 },
  });

  // Three separate write hooks so per-row pending state is trackable via `variables`.
  const { writeContract: writeClaim,  isPending: claimPending,  variables: claimVars  } = useWriteContract({ mutation: { onSuccess: () => refetch() } });
  const { writeContract: writeLock,   isPending: lockPending,   variables: lockVars   } = useWriteContract({ mutation: { onSuccess: () => refetch() } });
  const { writeContract: writeSettle, isPending: settlePending, variables: settleVars } = useWriteContract({ mutation: { onSuccess: () => refetch() } });

  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
  }, []);

  const rows = useMemo(() => {
    if (!results || currentId == null) return [];
    const cur = Number(currentId);
    const found = [];

    results.forEach((res, i) => {
      if (res.status !== "success" || !res.result) return;
      const [r, b] = res.result;
      if (b.upAmount === 0n && b.downAmount === 0n) return; // no bet this round

      const assetIdx   = Math.floor(i / HISTORY_LOOKBACK);
      const roundOffset = i % HISTORY_LOOKBACK;
      found.push({ asset: ASSETS[assetIdx], id: cur - roundOffset, r, b });
    });

    return found.sort((a, b) => b.id - a.id).slice(0, HISTORY_MAX);
  }, [results, currentId]);

  function rowStatus(r) {
    const status    = Number(r.status);
    const lockTime  = Number(r.lockTime);
    const closeTime = Number(r.closeTime);

    if (status === 0 && lockTime  > 0 && now >= lockTime)  return { label: "Overdue (Lock)",   code: status };
    if (status === 1 && closeTime > 0 && now >= closeTime) return { label: "Overdue (Settle)", code: status };

    if (status === 4) {
      let reason;
      if (r.upPool === 0n || r.downPool === 0n) {
        reason = "one-sided";
      } else if (r.closePrice !== 0n && r.closePrice === r.lockPrice) {
        reason = "tie";
      } else if (r.lockPrice === 0n || r.closePrice === 0n) {
        reason = "oracle missed";
      }
      return { label: "Refund", reason, code: status };
    }

    return { label: STATUS_LABEL[status] ?? "Unknown", code: status };
  }

  function calcPayout(status, r, b) {
    if (status === 4) return b.upAmount + b.downAmount;
    if (status === 2 && b.upAmount  > 0n) return b.upAmount  + (b.upAmount  * r.downPool / r.upPool);
    if (status === 3 && b.downAmount > 0n) return b.downAmount + (b.downAmount * r.upPool  / r.downPool);
    return 0n;
  }

  // Returns { amount: ReactNode, action: ReactNode }
  function rowAction(asset, id, r, b) {
    const status    = Number(r.status);
    const lockTime  = Number(r.lockTime);
    const closeTime = Number(r.closeTime);
    const key       = assetKey(asset.key);
    const idBig     = BigInt(id);

    const isMyAction = (vars) => vars?.args?.[0] === key && vars?.args?.[1] === idBig;

    const canClaim = !b.claimed && (
      (status === 4 && (b.upAmount > 0n || b.downAmount > 0n)) ||
      (status === 2 && b.upAmount  > 0n) ||
      (status === 3 && b.downAmount > 0n)
    );

    if (canClaim) {
      const mine   = isMyAction(claimVars) && claimPending;
      const payout = calcPayout(status, r, b);
      return {
        amount: <span className="claim-amount">{fmtWL(payout)} WL</span>,
        action: <button className="action-claim" disabled={mine} onClick={() => writeClaim({ address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "claim", args: [key, idBig] })}>{mine ? "…" : "Claim"}</button>,
      };
    }

    if (b.claimed) {
      const payout = calcPayout(status, r, b);
      return {
        amount: payout > 0n ? <span className="claim-amount">{fmtWL(payout)} WL</span> : null,
        action: <span className="badge-claimed">Claimed</span>,
      };
    }

    if (status === 0 && lockTime > 0 && now >= lockTime) {
      const mine = isMyAction(lockVars) && lockPending;
      return {
        amount: null,
        action: <button className="action-lock" disabled={mine} onClick={() => writeLock({ address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "lockRound", args: [key, idBig] })}>{mine ? "…" : "Lock"}</button>,
      };
    }

    if (status < 2 && closeTime > 0 && now >= closeTime) {
      const mine = isMyAction(settleVars) && settlePending;
      return {
        amount: null,
        action: <button className="action-settle" disabled={mine} onClick={() => writeSettle({ address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "settleRound", args: [key, idBig] })}>{mine ? "…" : "Settle"}</button>,
      };
    }

    return { amount: null, action: <span className="muted">—</span> };
  }

  if (!account) return null;

  return (
    <div className="card history-card">
      <h2>My Bet History</h2>
      {!results && <div className="muted mt8">Loading…</div>}
      {results && rows.length === 0 && (
        <div className="muted mt8">No bets found in the last {HISTORY_LOOKBACK} rounds.</div>
      )}
      {rows.length > 0 && (
        <table className="history-table mt8">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Round</th>
              <th>Dir</th>
              <th>Amount</th>
              <th>Status</th>
              <th className="th-amount">Payout</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ asset, id, r, b }) => {
              const { label, reason, code } = rowStatus(r);
              return (
                <tr key={`${asset.key}|${id}`} className={`status-${code}`}>
                  <td>{asset.label}</td>
                  <td className="muted">#{id}</td>
                  <td className={b.upAmount > 0n && b.downAmount === 0n ? "dir-up" : b.downAmount > 0n && b.upAmount === 0n ? "dir-down" : ""}>{dirLabel(b)}</td>
                  <td>{fmtWL(b.upAmount + b.downAmount)} WL</td>
                  <td>
                    <span className="muted">{label}</span>
                    {reason && <div className="status-reason">{reason}</div>}
                  </td>
                  {(() => { const { amount, action } = rowAction(asset, id, r, b); return (<><td className="td-amount">{amount}</td><td>{action}</td></>); })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Oracle Status ─────────────────────────────────────────────────────────────

const ORACLE_STALE_SECS = 30 * 60; // warn if no post within 30 min of hour boundary

function OracleStatus() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(id);
  }, []);

  const curHourId  = now > 0 ? Math.floor(now / 3600) : null;
  const prevHourId = curHourId != null ? curHourId - 1 : null;

  // Fetch current + previous hour for each asset (2 × 3 = 6 calls).
  const calls = useMemo(() => {
    if (!ORACLE_ADDRESS || curHourId == null) return [];
    return ASSETS.flatMap(({ key }) => [
      { address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: "priceAt", args: [assetKey(key), BigInt(curHourId)]  },
      { address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: "priceAt", args: [assetKey(key), BigInt(prevHourId)] },
    ]);
  }, [curHourId, prevHourId]);

  const { data: oracleData } = useReadContracts({
    contracts: calls,
    query: { enabled: calls.length > 0, refetchInterval: 60000 },
  });

  const { data: threshold } = useReadContract({
    address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: "threshold",
    query: { enabled: !!ORACLE_ADDRESS },
  });
  const { data: signerCount } = useReadContract({
    address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: "signerCount",
    query: { enabled: !!ORACLE_ADDRESS },
  });

  function assetHealth(curResult, prevResult) {
    // priceAt returns [price, timestamp, posted] as a positional array.
    const curRaw  = curResult?.status  === "success" ? curResult.result  : null;
    const prevRaw = prevResult?.status === "success" ? prevResult.result : null;
    const cur  = curRaw  ? { price: curRaw[0],  timestamp: curRaw[1],  posted: curRaw[2]  } : null;
    const prev = prevRaw ? { price: prevRaw[0], timestamp: prevRaw[1], posted: prevRaw[2] } : null;

    if (cur?.posted) {
      const age = now - Number(cur.timestamp);
      return { dot: "dot-green", label: "Live", detail: `${Math.floor(age / 60)} min ago`, price: cur.price };
    }
    const secsIntoHour = now % 3600;
    if (prev?.posted && secsIntoHour < ORACLE_STALE_SECS) {
      const age = now - Number(prev.timestamp);
      return { dot: "dot-yellow", label: "Pending", detail: `last ${Math.floor(age / 60)} min ago`, price: prev.price };
    }
    if (prev?.posted) {
      const age = now - Number(prev.timestamp);
      return { dot: "dot-red", label: "Stale", detail: `last ${Math.floor(age / 60)} min ago`, price: prev.price };
    }
    return { dot: "dot-red", label: "Down", detail: "no recent post", price: null };
  }

  if (!ORACLE_ADDRESS) return null;

  return (
    <div className="card">
      <div className="row between">
        <h2>Oracle</h2>
        {threshold != null && signerCount != null && (
          <span className="muted">{threshold?.toString()}-of-{signerCount?.toString()} signers</span>
        )}
      </div>
      <table className="oracle-table mt8">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Status</th>
            <th className="th-amount">Last Price</th>
            <th className="th-amount">Updated</th>
          </tr>
        </thead>
        <tbody>
          {ASSETS.map(({ key }, i) => {
            const cur  = oracleData?.[i * 2];
            const prev = oracleData?.[i * 2 + 1];
            const { dot, label, detail, price } = assetHealth(cur, prev);
            const priceStr = price != null ? `$${(Number(price) / 1e8).toFixed(6)}` : "—";
            return (
              <tr key={key}>
                <td>{key}</td>
                <td><span className="oracle-status-cell"><span className={`dot ${dot}`} />{label}</span></td>
                <td className="td-amount">{priceStr}</td>
                <td className="td-amount muted">{detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function useBurnStats() {
  const { data: total } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "totalBurned",
    query: { refetchInterval: 30000 },
  });
  const { data: pending } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "pendingBurn",
    query: { refetchInterval: 30000 },
  });
  return { total, pending };
}

function ReferralPanel({ account }) {
  const { data: claimable } = useReadContract({
    address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "referralBalance",
    args: account ? [account] : undefined,
    query: { enabled: !!account, refetchInterval: 10000 },
  });
  const { writeContract, isPending } = useWriteContract();
  const [link, setLink] = useState("");
  useEffect(() => {
    setLink(account ? `${window.location.origin}/?ref=${account}` : "");
  }, [account]);
  return (
    <div className="card">
      <h2>Referrals</h2>
      <div className="muted">share your link to credit the people you invite — once a player's referrer is set on their first bet, it stays attached for that account.</div>
      {link && (
        <input
          readOnly
          className="mt8 mono"
          value={link}
          onClick={(e) => e.target.select()}
        />
      )}
      <div className="row between mt12">
        <div>claimable: <b>{fmtWL(claimable)}</b> WL</div>
        <button
          disabled={!claimable || claimable === 0n || isPending}
          onClick={() => writeContract({ address: WORLDBET_ADDRESS, abi: WORLDBET_ABI, functionName: "claimReferral", args: [] })}
        >
          Claim
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const ref = useReferrer();
  const wrongChain = mounted && isConnected && chainId !== DEFAULT_CHAIN_ID;

  const { data: wlBalance } = useReadContract({
    address: WL_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!WL_TOKEN_ADDRESS, refetchInterval: 10000 },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: WL_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: address ? [address, WORLDBET_ADDRESS] : undefined,
    query: { enabled: !!address && !!WL_TOKEN_ADDRESS && !!WORLDBET_ADDRESS, refetchInterval: 10000 },
  });

  const { total: burnTotal, pending: burnPending } = useBurnStats();
  const { writeContract: writeApprove } = useWriteContract();
  const onApprove = () => {
    writeApprove({
      address: WL_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [WORLDBET_ADDRESS, maxUint256],
    }, {
      onSuccess: () => setTimeout(() => refetchAllowance(), 2000),
    });
  };

  return (
    <main>
      <header className="row between">
        <h1>WorldBet</h1>
        <div className="row">
          {mounted && isConnected && (
            <span className="muted mr8">
              {fmtWL(wlBalance)} WL
            </span>
          )}
          {!mounted ? null : isConnected ? (
            <button onClick={() => disconnect()}>{address.slice(0, 6)}…{address.slice(-4)}</button>
          ) : (
            connectors.map((c) => (
              <button key={c.uid} onClick={() => connect({ connector: c })}>
                Connect {c.name}
              </button>
            ))
          )}
        </div>
      </header>

      {!WORLDBET_ADDRESS && (
        <div className="warn">Set NEXT_PUBLIC_WORLDBET_ADDRESS in .env.local before betting.</div>
      )}
      {wrongChain && (
        <div className="warn">
          Wrong chain (got {chainId}, need {DEFAULT_CHAIN_ID}). Switch your wallet to BSC mainnet.
        </div>
      )}

      <section className="grid mt16">
        {ASSETS.map((a) => (
          <AssetCard
            key={a.key}
            label={a.key}
            account={address}
            referrer={ref}
            allowance={allowance}
            onApprove={onApprove}
          />
        ))}
      </section>

      <section className="mt16">
        <BetHistory account={address} />
      </section>

      <section className="grid mt16">
        <OracleStatus />
        <ReferralPanel account={address} />
      </section>

      <footer className="muted mt24">
        <div>Pari-mutuel, hourly rounds, WL (BEP-20). 3% fee = 1% prize / 0.3% referrer / 1.7% burn.</div>
        <div className="burn-strip mt8">
          🔥 <b>{fmtWL(burnTotal)}</b> WL burned
          <span className="burn-sep">·</span>
          <b>{fmtWL(burnPending)}</b> WL pending burn
        </div>
        <div className="mt8">Open-source reference dApp; play casually — not financial advice.</div>
      </footer>

      <style jsx global>{`
        :root { color-scheme: dark; }
        body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eaeaea; }
        main { max-width: 960px; margin: 0 auto; padding: 24px; }
        header h1 { margin: 0; font-size: 28px; letter-spacing: 0.5px; }
        h2 { margin: 0; font-size: 18px; }
        .row { display: flex; gap: 8px; align-items: center; }
        .between { justify-content: space-between; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
        .card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 16px; }
        .mt8 { margin-top: 8px; } .mt12 { margin-top: 12px; } .mt16 { margin-top: 16px; } .mt24 { margin-top: 24px; }
        .mr8 { margin-right: 8px; }
        .muted { color: #888; font-size: 13px; }
        .mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
        input { background: #0d0d0d; color: #eaeaea; border: 1px solid #2a2a2a; padding: 8px 10px; border-radius: 8px; flex: 1; }
        button { background: #2a7d2e; color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
        button.down { background: #b03030; }
        button.approve { background: #b88500; }
        .bet-row { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .bet-row input { width: 100%; box-sizing: border-box; flex: none; }
        .bet-btns { display: flex; gap: 8px; }
        .bet-btns button { flex: 1; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .bar { height: 6px; background: #b03030; border-radius: 3px; overflow: hidden; }
        .bar > div { height: 100%; background: #2a7d2e; }
        .warn { background: #2a1a00; border: 1px solid #553; color: #fc6; padding: 10px 12px; border-radius: 8px; margin-top: 12px; }
        footer { font-size: 12px; }
        .burn-strip { display: flex; align-items: center; gap: 6px; }
        .burn-sep { color: #444; }
        .history-card { width: 100%; box-sizing: border-box; }
        .history-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .history-table th { text-align: left; color: #666; font-weight: 500; padding: 4px 8px 8px; border-bottom: 1px solid #222; }
        .history-table td { padding: 8px; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
        .history-table tr:last-child td { border-bottom: none; }
        .dir-up   { color: #4caf50; font-weight: 600; }
        .dir-down { color: #e05252; font-weight: 600; }
        button.action-claim  { background: #1565a8; font-size: 12px; padding: 5px 10px; }
        button.action-lock   { background: #7a5c00; font-size: 12px; padding: 5px 10px; }
        button.action-settle { background: #4a2d7a; font-size: 12px; padding: 5px 10px; }
        .status-reason { font-size: 11px; color: #555; margin-top: 2px; }
        .oracle-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .oracle-table th { text-align: left; color: #666; font-weight: 500; padding: 4px 8px 8px; border-bottom: 1px solid #222; }
        .oracle-table td { padding: 7px 8px; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
        .oracle-table tr:last-child td { border-bottom: none; }
        .oracle-status-cell { display: flex; align-items: center; gap: 6px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .dot-green  { background: #4caf50; box-shadow: 0 0 6px #4caf5088; }
        .dot-yellow { background: #f0a500; box-shadow: 0 0 6px #f0a50088; }
        .dot-red    { background: #e05252; box-shadow: 0 0 6px #e0525288; }
        .claim-amount { font-size: 12px; color: #888; white-space: nowrap; }
        .th-amount { text-align: right; }
        .td-amount { text-align: right; white-space: nowrap; }
        .badge-claimed { font-size: 11px; color: #4caf50; border: 1px solid #2a5c2e; border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
      `}</style>
    </main>
  );
}
