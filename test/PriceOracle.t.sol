// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PriceOracle} from "../contracts/PriceOracle.sol";

contract PriceOracleTest is Test {
    PriceOracle oracle;

    address owner = address(0xA11CE);

    // Three deterministic signers via vm.addr.
    uint256 constant K1 = 0xA1;
    uint256 constant K2 = 0xA2;
    uint256 constant K3 = 0xA3;
    uint256 constant K_INTRUDER = 0xBAD;

    address s1; address s2; address s3; address intruder;

    bytes32 constant ASSET = keccak256("WL/USD");

    function setUp() public {
        s1 = vm.addr(K1); s2 = vm.addr(K2); s3 = vm.addr(K3);
        intruder = vm.addr(K_INTRUDER);

        address[] memory signers = new address[](3);
        signers[0] = s1; signers[1] = s2; signers[2] = s3;

        vm.prank(owner);
        oracle = new PriceOracle(owner, signers, 2);
    }

    // ---------- helpers ----------

    function _digest(bytes32 asset, uint64 hourId, uint128 price, uint64 ts) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("Price(bytes32 asset,uint64 hourId,uint128 price,uint64 timestamp)");
        bytes32 structHash = keccak256(abi.encode(typeHash, asset, hourId, price, ts));
        return keccak256(abi.encodePacked("\x19\x01", oracle.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---------- happy path ----------

    function test_PostWithThresholdSigs() public {
        uint64 hourId = 1;
        uint128 price = 250e8;
        uint64 ts = 1_700_000_000;

        bytes32 d = _digest(ASSET, hourId, price, ts);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K2, d);

        oracle.postPrice(ASSET, hourId, price, ts, sigs);

        (uint128 p, uint64 t, bool posted) = oracle.priceAt(ASSET, hourId);
        assertEq(p, price);
        assertEq(t, ts);
        assertTrue(posted);
    }

    function test_PostWithExtraSigs() public {
        // 3 valid sigs when threshold is 2 → still accepted (early break).
        uint64 hourId = 1;
        uint128 price = 250e8;
        uint64 ts = 1_700_000_000;
        bytes32 d = _digest(ASSET, hourId, price, ts);

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K2, d);
        sigs[2] = _sign(K3, d);

        oracle.postPrice(ASSET, hourId, price, ts, sigs);
        (, , bool posted) = oracle.priceAt(ASSET, hourId);
        assertTrue(posted);
    }

    // ---------- threshold edges ----------

    function test_RevertsBelowThreshold() public {
        uint64 hourId = 1;
        bytes32 d = _digest(ASSET, hourId, 250e8, 1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(K1, d);

        vm.expectRevert(bytes("PO: < threshold"));
        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);
    }

    function test_RevertsOnDuplicateSigner() public {
        // Two sigs but both from same signer → counts as 1.
        uint64 hourId = 1;
        bytes32 d = _digest(ASSET, hourId, 250e8, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K1, d);

        vm.expectRevert(bytes("PO: not enough valid sigs"));
        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);
    }

    function test_RevertsOnIntruderSig() public {
        uint64 hourId = 1;
        bytes32 d = _digest(ASSET, hourId, 250e8, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K_INTRUDER, d); // not a registered signer

        vm.expectRevert(bytes("PO: not enough valid sigs"));
        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);
    }

    function test_RevertsOnTamperedDigest() public {
        // Sigs are over (ASSET, hourId=1, ...). We post with hourId=2 → digest mismatch.
        bytes32 d = _digest(ASSET, 1, 250e8, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K2, d);

        vm.expectRevert(bytes("PO: not enough valid sigs"));
        oracle.postPrice(ASSET, 2, 250e8, 1, sigs);
    }

    function test_RevertsOnReplay() public {
        uint64 hourId = 1;
        bytes32 d = _digest(ASSET, hourId, 250e8, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K2, d);

        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);

        vm.expectRevert(bytes("PO: posted"));
        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);
    }

    function test_RevertsOnZeroPrice() public {
        bytes32 d = _digest(ASSET, 1, 0, 1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(K1, d);
        sigs[1] = _sign(K2, d);

        vm.expectRevert(bytes("PO: zero price"));
        oracle.postPrice(ASSET, 1, 0, 1, sigs);
    }

    // ---------- malleability ----------

    /// Flipping s to (n - s) while adjusting v should be rejected (high-s guard).
    function test_RejectsHighSMalleability() public {
        uint64 hourId = 1;
        bytes32 d = _digest(ASSET, hourId, 250e8, 1);

        (uint8 v1, bytes32 r1, bytes32 s1Raw) = vm.sign(K1, d);
        (uint8 v2, bytes32 r2, bytes32 s2Raw) = vm.sign(K2, d);

        // Flip s2 to its high counterpart.
        uint256 secp256k1n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2High = bytes32(secp256k1n - uint256(s2Raw));
        uint8 v2Flip = v2 == 27 ? 28 : 27;

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(r1, s1Raw, v1);
        sigs[1] = abi.encodePacked(r2, s2High, v2Flip);

        // Second sig is rejected as high-s → only 1 valid → < threshold.
        vm.expectRevert(bytes("PO: not enough valid sigs"));
        oracle.postPrice(ASSET, hourId, 250e8, 1, sigs);
    }

    // ---------- admin ----------

    function test_AddRemoveSigner() public {
        address newSigner = address(0xDEAD0001);
        vm.prank(owner);
        oracle.addSigner(newSigner);
        assertTrue(oracle.isSigner(newSigner));

        vm.prank(owner);
        oracle.removeSigner(newSigner);
        assertFalse(oracle.isSigner(newSigner));
    }

    function test_CannotRemoveBelowThreshold() public {
        // 3 signers with threshold 2; remove two → would be 1 < threshold.
        vm.startPrank(owner);
        oracle.removeSigner(s1); // 2 signers left, OK
        vm.expectRevert(bytes("PO: under threshold"));
        oracle.removeSigner(s2); // would leave 1 < 2
        vm.stopPrank();
    }

    function test_OnlyOwnerCanAdmin() public {
        vm.expectRevert(bytes("PO: not owner"));
        oracle.addSigner(address(0xBEEF));

        vm.expectRevert(bytes("PO: not owner"));
        oracle.setThreshold(1);
    }

    // ---------- fuzz: any 2 distinct signer keys must produce a valid post ----------

    function testFuzz_AnyTwoOfThreeAccepted(uint8 a, uint8 b) public {
        a = uint8(bound(a, 0, 2));
        b = uint8(bound(b, 0, 2));
        vm.assume(a != b);

        uint256[3] memory keys = [K1, K2, K3];

        uint64 hourId = uint64(bound(uint256(a) + uint256(b), 1, type(uint32).max));
        uint128 price = uint128(bound(uint256(a) * 1e8 + uint256(b) * 1e7 + 1, 1, type(uint64).max));
        bytes32 d = _digest(ASSET, hourId, price, 1);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(keys[a], d);
        sigs[1] = _sign(keys[b], d);

        oracle.postPrice(ASSET, hourId, price, 1, sigs);
        (, , bool posted) = oracle.priceAt(ASSET, hourId);
        assertTrue(posted);
    }
}
