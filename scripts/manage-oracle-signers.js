// Utility to inspect and manage PriceOracle signers
//
// Usage (with environment variables):
//   COMMAND=list npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet
//   COMMAND=add SIGNER=0xABC... npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet
//   COMMAND=remove SIGNER=0xABC... npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet
//   COMMAND=set-threshold THRESHOLD=2 npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet
//   COMMAND=transfer-owner OWNER=0xNEW... npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet
//
// Or pass as inline env vars:
//   COMMAND=list node scripts/manage-oracle-signers.js
//   COMMAND=add SIGNER=0x... node scripts/manage-oracle-signers.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ORACLE_ABI = [
  "function owner() public view returns (address)",
  "function threshold() public view returns (uint8)",
  "function signerCount() public view returns (uint256)",
  "function signers(uint256 index) public view returns (address)",
  "function isSigner(address) public view returns (bool)",
  "function addSigner(address s) external",
  "function removeSigner(address s) external",
  "function setThreshold(uint8 t) external",
  "function setOwner(address _owner) external",
];

async function main() {
  const command = process.env.COMMAND;

  if (!command) {
    console.error("Usage: COMMAND=<cmd> [ARGS...] npx hardhat run scripts/manage-oracle-signers.js --network <NETWORK>");
    console.error("\nCommands:");
    console.error("  COMMAND=list                            - List all signers and threshold");
    console.error("  COMMAND=get-threshold                   - Get current threshold (M-of-N)");
    console.error("  COMMAND=add SIGNER=0x...                - Add a new signer");
    console.error("  COMMAND=remove SIGNER=0x...             - Remove a signer");
    console.error("  COMMAND=set-threshold THRESHOLD=<num>   - Change M-of-N threshold");
    console.error("  COMMAND=transfer-owner OWNER=0x...      - Transfer oracle ownership");
    console.error("\nExamples:");
    console.error("  COMMAND=list npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet");
    console.error("  COMMAND=add SIGNER=0xABC... npx hardhat run scripts/manage-oracle-signers.js --network bscTestnet");
    process.exit(1);
  }

  // Load deployment info
  const deployPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deployPath)) {
    throw new Error(`deployments.json not found. Run deploy.js first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));

  if (deployment.chainId !== Number(network.config.chainId)) {
    throw new Error(
      `Deployment chainId mismatch: ${deployment.chainId} in deployments.json but ${network.config.chainId} in hardhat config`
    );
  }

  const oracleAddr = deployment.oracle;
  console.log(`Network:        ${network.name} (chainId ${network.config.chainId})`);
  console.log(`PriceOracle:    ${oracleAddr}`);
  console.log("");

  const [signer] = await ethers.getSigners();
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);

  // Commands
  if (command === "list") {
    await listSigners(oracle);
  } else if (command === "get-threshold") {
    await getThreshold(oracle);
  } else if (command === "add") {
    const newSigner = process.env.SIGNER;
    if (!newSigner || !ethers.isAddress(newSigner)) {
      throw new Error("SIGNER env var not set or invalid address");
    }
    await addSigner(oracle, newSigner, signer);
  } else if (command === "remove") {
    const toRemove = process.env.SIGNER;
    if (!toRemove || !ethers.isAddress(toRemove)) {
      throw new Error("SIGNER env var not set or invalid address");
    }
    await removeSigner(oracle, toRemove, signer);
  } else if (command === "set-threshold") {
    const threshold = parseInt(process.env.THRESHOLD, 10);
    if (isNaN(threshold) || threshold < 1) {
      throw new Error("THRESHOLD env var not set or invalid (must be >= 1)");
    }
    await setThreshold(oracle, threshold, signer);
  } else if (command === "transfer-owner") {
    const newOwner = process.env.OWNER;
    if (!newOwner || !ethers.isAddress(newOwner)) {
      throw new Error("OWNER env var not set or invalid address");
    }
    await transferOwner(oracle, newOwner, signer);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

async function listSigners(oracle) {
  const owner = await oracle.owner();
  const threshold = await oracle.threshold();
  const count = await oracle.signerCount();

  console.log(`Owner:          ${owner}`);
  console.log(`Threshold:      ${threshold}-of-${count}`);
  console.log("");
  console.log("Signers:");

  for (let i = 0; i < count; i++) {
    const addr = await oracle.signers(i);
    console.log(`  [${i}] ${addr}`);
  }
}

async function getThreshold(oracle) {
  const threshold = await oracle.threshold();
  const count = await oracle.signerCount();
  console.log(`${threshold}-of-${count}`);
}

async function addSigner(oracle, newSigner, signer) {
  console.log(`Adding signer: ${newSigner}`);

  const is = await oracle.isSigner(newSigner);
  if (is) {
    console.error("Error: address is already a signer");
    process.exit(1);
  }

  console.log("Sending transaction...");
  const tx = await oracle.addSigner(newSigner);
  const receipt = await tx.wait();

  console.log(`✓ Signer added at tx ${receipt.hash}`);
  console.log("");
  await listSigners(oracle);
}

async function removeSigner(oracle, toRemove, signer) {
  console.log(`Removing signer: ${toRemove}`);

  const is = await oracle.isSigner(toRemove);
  if (!is) {
    console.error("Error: address is not a signer");
    process.exit(1);
  }

  const threshold = await oracle.threshold();
  const count = await oracle.signerCount();

  if (count <= threshold) {
    console.error(`Error: Cannot remove signer. Would fall below threshold (${threshold}-of-${count})`);
    process.exit(1);
  }

  console.log("Sending transaction...");
  const tx = await oracle.removeSigner(toRemove);
  const receipt = await tx.wait();

  console.log(`✓ Signer removed at tx ${receipt.hash}`);
  console.log("");
  await listSigners(oracle);
}

async function setThreshold(oracle, newThreshold, signer) {
  const count = await oracle.signerCount();
  const current = await oracle.threshold();

  if (newThreshold < 1 || newThreshold > count) {
    console.error(`Error: threshold must be between 1 and ${count}`);
    process.exit(1);
  }

  console.log(`Setting threshold: ${current}-of-${count} → ${newThreshold}-of-${count}`);
  console.log("Sending transaction...");

  const tx = await oracle.setThreshold(newThreshold);
  const receipt = await tx.wait();

  console.log(`✓ Threshold updated at tx ${receipt.hash}`);
  console.log("");
  await listSigners(oracle);
}

async function transferOwner(oracle, newOwner, signer) {
  const currentOwner = await oracle.owner();

  console.log(`Current owner: ${currentOwner}`);
  console.log(`New owner:     ${newOwner}`);
  console.log("Sending transaction...");

  const tx = await oracle.setOwner(newOwner);
  const receipt = await tx.wait();

  console.log(`✓ Ownership transferred at tx ${receipt.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
