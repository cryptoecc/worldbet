import { JsonRpcProvider, Contract, ZeroAddress } from "ethers";

const p = new JsonRpcProvider("https://bsc-dataseed.binance.org");
const WL = "0x8aaB31fbc69C92fa53f600910Cf0f215531F8239";
const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
];
const c = new Contract(WL, ABI, p);

console.log(`WL @ ${WL}\n`);
for (const fn of ["name","symbol","decimals","totalSupply"]) {
  try { console.log(fn.padEnd(13), await c[fn]()); } catch(e){ console.log(fn,"ERR",e.shortMessage||e.message); }
}
for (const fn of ["owner","getOwner"]) {
  try { const o = await c[fn](); if (o && o !== ZeroAddress) { console.log((fn+"()").padEnd(14), o); break; } } catch{}
}

const code = (await p.getCode(WL)).toLowerCase();
console.log("\nBytecode probe:");
for (const sel of ["0x42966c68","0x79cc6790"])
  console.log(`  burn ${sel}: ${code.includes(sel.slice(2)) ? "YES" : "no"}`);
const taxes = ["ddca3f43","4549b039","3bd5d173","13114a9d","5342acb4","515a3818","a073d37f"];
const hits = taxes.filter(s => code.includes(s)).length;
console.log(`Fee-on-transfer markers: ${hits === 0 ? "none (likely vanilla ERC-20)" : hits + " (LIKELY fee-on-transfer)"}`);
