#!/usr/bin/env node
/* eslint-disable no-console */
// Standalone CEX availability + median sanity probe.
//
// Run BEFORE deploying / starting the oracle bot to confirm that
// WL/USDT is actually listed on enough venues for the 2-of-4 median
// to work. If a venue fails, edit oracle/index.js's SYM map or drop
// the WL/USD market from scripts/deploy.js.
//
// Usage:
//   node scripts/check-cex.js              # default: WL, BTC, ETH
//   node scripts/check-cex.js WL           # only WL
//   ASSETS=WL,BTC node scripts/check-cex.js

const https = require("https");

const SYM = {
  WL:  { kucoin: "WL-USDT",  gate: "WL_USDT",  mexc: "WLUSDT",  htx: "wlusdt"  },
  BTC: { kucoin: "BTC-USDT", gate: "BTC_USDT", mexc: "BTCUSDT", htx: "btcusdt" },
  ETH: { kucoin: "ETH-USDT", gate: "ETH_USDT", mexc: "ETHUSDT", htx: "ethusdt" },
};

const ASSETS = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => s.toUpperCase())
  : (process.env.ASSETS || "WL,BTC,ETH").split(",").map((s) => s.trim().toUpperCase());

function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`bad json: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

const probes = {
  kucoin: async (s) => {
    const r = await fetchJSON(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${s}`);
    if (!r?.data?.price) throw new Error("no price field");
    return Number(r.data.price);
  },
  gate: async (s) => {
    const r = await fetchJSON(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${s}`);
    if (!Array.isArray(r) || !r[0]?.last) throw new Error("empty array");
    return Number(r[0].last);
  },
  mexc: async (s) => {
    const r = await fetchJSON(`https://api.mexc.com/api/v3/ticker/price?symbol=${s}`);
    if (!r?.price) throw new Error("no price field");
    return Number(r.price);
  },
  htx: async (s) => {
    const r = await fetchJSON(`https://api.huobi.pro/market/detail/merged?symbol=${s}`);
    if (!r?.tick?.close) throw new Error("no tick.close");
    return Number(r.tick.close);
  },
};

async function checkOne(asset) {
  if (!SYM[asset]) {
    console.log(`[${asset}] no symbol map — skipping`);
    return;
  }
  console.log(`\n=== ${asset}/USD ===`);
  const out = await Promise.allSettled(
    Object.entries(probes).map(async ([venue, fn]) => {
      const px = await fn(SYM[asset][venue]);
      return { venue, px };
    })
  );
  const ok = [];
  out.forEach((r, i) => {
    const venue = Object.keys(probes)[i];
    if (r.status === "fulfilled" && Number.isFinite(r.value.px) && r.value.px > 0) {
      console.log(`  [OK]   ${venue.padEnd(7)} ${r.value.px}`);
      ok.push(r.value.px);
    } else {
      const msg = r.reason?.message || r.value?.err || "n/a";
      console.log(`  [FAIL] ${venue.padEnd(7)} ${msg}`);
    }
  });

  if (ok.length === 0) {
    console.log(`  RESULT: zero venues — REMOVE ${asset}/USD market or fix symbol map`);
    return false;
  }
  if (ok.length === 1) {
    console.log(`  RESULT: only 1 venue — oracle bot will refuse to post (needs >= 2 for median)`);
    return false;
  }
  ok.sort((a, b) => a - b);
  const med = ok.length % 2 === 0
    ? (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2
    : ok[(ok.length - 1) / 2];
  const lo = ok[0], hi = ok[ok.length - 1];
  const spread = ((hi - lo) / med) * 100;
  console.log(`  RESULT: ${ok.length}/4 venues, median=${med.toFixed(6)}, spread=${spread.toFixed(3)}%`);
  if (spread > 1) console.log(`  WARN: spread > 1% — beware of CEX divergence`);
  return ok.length >= 2;
}

async function main() {
  let allGreen = true;
  for (const a of ASSETS) {
    const ok = await checkOne(a);
    if (!ok) allGreen = false;
  }
  console.log("");
  if (allGreen) {
    console.log("All checked markets have >= 2 healthy venues. Safe to deploy.");
    process.exit(0);
  } else {
    console.log("FAIL: at least one market lacks 2 healthy venues.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
