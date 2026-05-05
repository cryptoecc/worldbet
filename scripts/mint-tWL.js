// Faucet helper: mint tWL to an address on a TEST network.
// Refuses on BSC mainnet (real WL is not mintable).
//
// Usage:
//   npx hardhat run scripts/mint-tWL.js --network bscTestnet
//     -> mints 10000 tWL to the signer
//   RECIPIENT=0xABC... AMOUNT=50000 npx hardhat run scripts/mint-tWL.js --network bscTestnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "bsc") {
    throw new Error("Refusing to call mint() on BSC mainnet — WL is not mintable.");
  }
  const mockPath = path.join(__dirname, "..", "mock-wl.json");
  if (!fs.existsSync(mockPath)) {
    throw new Error(`mock-wl.json not found. Run scripts/deploy-mock-wl.js first.`);
  }
  const mock = JSON.parse(fs.readFileSync(mockPath, "utf8"));
  if (mock.chainId !== Number(network.config.chainId)) {
    throw new Error(
      `mock-wl.json chainId=${mock.chainId} but current network chainId=${network.config.chainId}`
    );
  }

  const [signer] = await ethers.getSigners();
  const recipient = process.env.RECIPIENT || signer.address;
  const amount = ethers.parseEther(process.env.AMOUNT || "10000");

  const wl = await ethers.getContractAt("MockWL", mock.mockWL, signer);
  console.log(`Minting ${ethers.formatEther(amount)} tWL to ${recipient}`);
  const tx = await wl.mint(recipient, amount);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log(`Balance: ${ethers.formatEther(await wl.balanceOf(recipient))} tWL`);
}

main().catch((err) => { console.error(err); process.exit(1); });
