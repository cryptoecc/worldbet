// Deploy MockWL on a TEST network (BSC testnet chainId 97 or local anvil).
// Refuses to run on BSC mainnet — there the real WL token already exists.
// Mints 10M tWL to the deployer for seed liquidity.
//
// Usage:
//   npx hardhat run scripts/deploy-mock-wl.js --network bscTestnet
// Then:
//   npx hardhat run scripts/deploy.js --network bscTestnet
// (deploy.js auto-loads mock-wl.json if WL_ADDRESS unset.)

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "bsc") {
    throw new Error(
      "Refusing to deploy MockWL to BSC mainnet. Use the real WL at 0x8aaB31fbc69C92fa53f600910Cf0f215531F8239."
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const MockWL = await ethers.getContractFactory("MockWL");
  const wl = await MockWL.deploy();
  await wl.waitForDeployment();
  const wlAddr = await wl.getAddress();
  console.log(`MockWL deployed: ${wlAddr}`);

  // Seed deployer with 1M tWL (per-call faucet cap is 1M; re-run mint-tWL.js
  // for more). 1M tWL ~ $8k at current WL price — plenty for testnet seed.
  const seed = ethers.parseEther("1000000");
  await (await wl.mint(deployer.address, seed)).wait();
  console.log(`Minted ${ethers.formatEther(seed)} tWL to deployer`);

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId),
    mockWL: wlAddr,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "mock-wl.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`\nNext: npx hardhat run scripts/deploy.js --network ${network.name}`);
  console.log(`(deploy.js will pick up the MockWL address from mock-wl.json automatically)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
