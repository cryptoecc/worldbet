// Deploy PriceOracle + WorldBet, register WL/USD, BTC/USD, ETH/USD.
// Env:
//   WL_ADDRESS        required, ERC-20 (BEP-20) WL token address.
//                     Mainnet BSC: 0x8aaB31fbc69C92fa53f600910Cf0f215531F8239
//   ORACLE_SIGNERS    comma-separated signer addresses (defaults to deployer)
//   ORACLE_THRESHOLD  M of N (default 2)
//   DEPLOYER_KEY      private key (set via hardhat network accounts)

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ASSETS = ["WL/USD", "BTC/USD", "ETH/USD"];

// Pre-known WL addresses per network. Override with WL_ADDRESS env.
const WL_BY_NETWORK = {
  bsc:        "0x8aaB31fbc69C92fa53f600910Cf0f215531F8239", // BNB Smart Chain mainnet
  bscTestnet: "",                                            // set via WL_ADDRESS
  seoul:      "",                                            // set via WL_ADDRESS once bridge live
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  let wlAddr = process.env.WL_ADDRESS || WL_BY_NETWORK[network.name] || "";

  // Fallback: on test networks (everything except BSC mainnet), look for a
  // MockWL deployment manifest written by scripts/deploy-mock-wl.js.
  if (!wlAddr && network.name !== "bsc") {
    const mockPath = path.join(__dirname, "..", "mock-wl.json");
    if (fs.existsSync(mockPath)) {
      const mock = JSON.parse(fs.readFileSync(mockPath, "utf8"));
      if (mock.chainId === Number(network.config.chainId) && ethers.isAddress(mock.mockWL)) {
        wlAddr = mock.mockWL;
        console.log(`Using MockWL from mock-wl.json: ${wlAddr}`);
      }
    }
  }

  if (!ethers.isAddress(wlAddr)) {
    throw new Error(`WL_ADDRESS not set for network ${network.name}. Set env, populate WL_BY_NETWORK, or run deploy-mock-wl.js first.`);
  }
  console.log(`WL token:   ${wlAddr}`);

  const signersCsv = process.env.ORACLE_SIGNERS || deployer.address;
  const signers = signersCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = parseInt(process.env.ORACLE_THRESHOLD || "2", 10);

  if (signers.length === 1 && threshold > 1) {
    console.log(`Note: ORACLE_SIGNERS has 1 signer; lowering threshold to 1 for dev.`);
  }
  const effThreshold = Math.min(threshold, signers.length);
  console.log(`Oracle: ${effThreshold}-of-${signers.length}`);

  const Oracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await Oracle.deploy(deployer.address, signers, effThreshold);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`PriceOracle deployed: ${oracleAddr}`);

  const WorldBet = await ethers.getContractFactory("WorldBet");
  const wb = await WorldBet.deploy(oracleAddr, wlAddr, deployer.address);
  await wb.waitForDeployment();
  const wbAddr = await wb.getAddress();
  console.log(`WorldBet deployed:    ${wbAddr}`);

  const assetMap = {};
  for (const name of ASSETS) {
    const key = ethers.id(name); // keccak256
    const tx = await wb.registerAsset(key);
    await tx.wait();
    assetMap[name] = key;
    console.log(`  registered ${name.padEnd(8)} ${key}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const ROUND = 3600;
  const nextHour = Math.ceil(now / ROUND) * ROUND;
  const firstLockableRound = Math.floor(now / ROUND);
  console.log("");
  console.log(`Current UTC hour:        ${new Date(Math.floor(now / ROUND) * ROUND * 1000).toISOString()}`);
  console.log(`Next UTC hour boundary:  ${new Date(nextHour * 1000).toISOString()} (in ${nextHour - now}s)`);
  console.log(`Oracle bot must post for hourId=${nextHour / ROUND} before that boundary`);
  console.log(`(this becomes the lockPrice for round ${firstLockableRound}).`);

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId),
    deployer: deployer.address,
    wl: wlAddr,
    oracle: oracleAddr,
    worldbet: wbAddr,
    signers,
    threshold: effThreshold,
    assets: assetMap,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
