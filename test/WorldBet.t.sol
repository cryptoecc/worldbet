// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WorldBet} from "../contracts/WorldBet.sol";
import {MockOracle} from "./MockOracle.sol";
import {MockERC20} from "./MockERC20.sol";

contract WorldBetTest is Test {
    WorldBet wb;
    MockOracle oracle;
    MockERC20 wl;

    bytes32 constant ASSET = keccak256("WL/USD");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address owner = address(0xA11CE);
    address alice = address(0xA);
    address bob   = address(0xB);
    address carol = address(0xC);

    uint64 constant ROUND_DURATION = 3600;

    function setUp() public {
        vm.warp(1_700_000_000);

        oracle = new MockOracle();
        wl = new MockERC20();
        vm.prank(owner);
        wb = new WorldBet(address(oracle), address(wl), owner);

        vm.prank(owner);
        wb.registerAsset(ASSET);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            wl.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            wl.approve(address(wb), type(uint256).max);
        }
    }

    function _bet(address user, uint256 amount, WorldBet.Direction dir, address ref) internal {
        vm.prank(user);
        wb.bet(ASSET, dir, ref, amount);
    }

    function _advanceToLock(uint64 id) internal {
        vm.warp((uint256(id) + 1) * ROUND_DURATION);
    }

    function _advanceToClose(uint64 id) internal {
        vm.warp((uint256(id) + 2) * ROUND_DURATION);
    }

    function _settleWith(uint64 id, uint128 lockPrice, uint128 closePrice) internal {
        oracle.set(ASSET, id + 1, lockPrice);
        oracle.set(ASSET, id + 2, closePrice);
        _advanceToLock(id);
        wb.lockRound(ASSET, id);
        _advanceToClose(id);
        wb.settleRound(ASSET, id);
    }

    // ---------- fee split fuzz ----------

    function testFuzz_FeeSplitConservation(uint96 amount) public {
        amount = uint96(bound(amount, 1 wei, 1_000_000 ether));
        wl.mint(alice, amount);

        uint256 totalBefore = wb.prizePool() + wb.pendingBurn();
        _bet(alice, amount, WorldBet.Direction.Up, address(0));

        uint64 id = wb.currentRoundId();
        (WorldBet.Round memory r, ) = wb.roundView(ASSET, id, alice);

        uint256 net = uint256(r.upPool);
        uint256 totalAfter = wb.prizePool() + wb.pendingBurn();
        uint256 fees = totalAfter - totalBefore;

        assertEq(net + fees, amount, "fee conservation");
        assertLe(fees * 10000, uint256(amount) * 300, "fee <= 3%");
        uint256 nominal = (uint256(amount) * 300) / 10000;
        assertGe(fees + 3, nominal, "fee >= 3% - 3 wei");
    }

    function testFuzz_FeeSplit_NoReferrer_RebateToBurn(uint96 amount) public {
        amount = uint96(bound(amount, 10_000 wei, 1_000_000 ether));
        wl.mint(alice, amount);

        uint256 burnBefore = wb.pendingBurn();
        uint256 prizeBefore = wb.prizePool();

        _bet(alice, amount, WorldBet.Direction.Up, address(0));

        uint256 prizePart = (uint256(amount) * 100) / 10000;
        uint256 burnPart  = (uint256(amount) * 170) / 10000;
        uint256 refPart   = (uint256(amount) * 30) / 10000;

        assertEq(wb.prizePool() - prizeBefore, prizePart, "prize accumulator");
        assertEq(wb.pendingBurn() - burnBefore, burnPart + refPart, "burn accumulator");
    }

    function testFuzz_FeeSplit_WithReferrer(uint96 amount) public {
        amount = uint96(bound(amount, 10_000 wei, 1_000_000 ether));
        wl.mint(alice, amount);
        _bet(alice, amount, WorldBet.Direction.Up, carol);
        uint256 refPart = (uint256(amount) * 30) / 10000;
        assertEq(wb.referralBalance(carol), refPart, "referrer balance");
        assertEq(wb.referrer(alice), carol, "sticky referrer");
    }

    // ---------- referrer stickiness ----------

    function test_ReferrerStickyAfterFirstSet() public {
        _bet(alice, 1 ether, WorldBet.Direction.Up, carol);
        assertEq(wb.referrer(alice), carol);
        _bet(alice, 1 ether, WorldBet.Direction.Down, bob);
        assertEq(wb.referrer(alice), carol, "sticky");
    }

    function test_ReferrerSelfIgnored() public {
        _bet(alice, 1 ether, WorldBet.Direction.Up, alice);
        assertEq(wb.referrer(alice), address(0), "self-ref ignored");
    }

    // ---------- payout math fuzz (UP wins) ----------

    function testFuzz_Payout_UpWins(uint96 upAmt, uint96 downAmt) public {
        upAmt   = uint96(bound(upAmt,   1e15, 1e23));
        downAmt = uint96(bound(downAmt, 1e15, 1e23));

        wl.mint(alice, upAmt);
        wl.mint(bob,   downAmt);

        uint64 id = wb.currentRoundId();
        _bet(alice, upAmt,   WorldBet.Direction.Up,   address(0));
        _bet(bob,   downAmt, WorldBet.Direction.Down, address(0));

        (WorldBet.Round memory rBefore, ) = wb.roundView(ASSET, id, alice);
        uint128 upPool = rBefore.upPool;
        uint128 downPool = rBefore.downPool;

        _settleWith(id, 100e8, 110e8);

        uint256 expectedAlice = uint256(upPool) + (uint256(upPool) * uint256(downPool)) / uint256(upPool);

        uint256 balBefore = wl.balanceOf(alice);
        vm.prank(alice);
        wb.claim(ASSET, id);
        assertEq(wl.balanceOf(alice) - balBefore, expectedAlice, "alice payout");

        vm.expectRevert(bytes("WB: nothing"));
        vm.prank(bob); wb.claim(ASSET, id);
    }

    function testFuzz_Payout_ProRataSplit(uint96 a, uint96 b, uint96 c) public {
        a = uint96(bound(a, 1e16, 1e22));
        b = uint96(bound(b, 1e16, 1e22));
        c = uint96(bound(c, 1e16, 1e22));

        wl.mint(alice, a);
        wl.mint(bob,   b);
        wl.mint(carol, c);

        uint64 id = wb.currentRoundId();
        _bet(alice, a, WorldBet.Direction.Up, address(0));
        _bet(bob,   b, WorldBet.Direction.Up, address(0));
        _bet(carol, c, WorldBet.Direction.Down, address(0));

        (WorldBet.Round memory r, ) = wb.roundView(ASSET, id, alice);
        uint128 up = r.upPool;
        uint128 down = r.downPool;
        (, WorldBet.Bet memory aBet) = wb.roundView(ASSET, id, alice);
        (, WorldBet.Bet memory bBet) = wb.roundView(ASSET, id, bob);

        _settleWith(id, 100e8, 110e8);

        uint256 aBefore = wl.balanceOf(alice);
        vm.prank(alice); wb.claim(ASSET, id);
        uint256 aPayout = wl.balanceOf(alice) - aBefore;

        uint256 bBefore = wl.balanceOf(bob);
        vm.prank(bob); wb.claim(ASSET, id);
        uint256 bPayout = wl.balanceOf(bob) - bBefore;

        uint256 totalPool = uint256(up) + uint256(down);
        assertLe(aPayout + bPayout, totalPool, "payout <= pool");
        assertGe(aPayout, aBet.upAmount, "alice >= stake");
        assertGe(bPayout, bBet.upAmount, "bob >= stake");
        assertGe(totalPool, aPayout + bPayout);
        assertLe(totalPool - (aPayout + bPayout), 2);
    }

    // ---------- refund paths ----------

    function test_Refund_OneSidedPool() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up, address(0));

        oracle.set(ASSET, id + 1, 100e8);
        _advanceToLock(id);
        wb.lockRound(ASSET, id);

        oracle.set(ASSET, id + 2, 110e8);
        _advanceToClose(id);
        wb.settleRound(ASSET, id);

        (WorldBet.Round memory r, ) = wb.roundView(ASSET, id, alice);
        assertEq(r.status, 4, "refund status");

        uint256 before = wl.balanceOf(alice);
        vm.prank(alice); wb.claim(ASSET, id);
        assertEq(wl.balanceOf(alice) - before, r.upPool, "refund = net stake");
    }

    function test_Refund_TiePrice() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up,   address(0));
        _bet(bob,   1 ether, WorldBet.Direction.Down, address(0));
        _settleWith(id, 100e8, 100e8);

        (WorldBet.Round memory r, ) = wb.roundView(ASSET, id, alice);
        assertEq(r.status, 4, "tie -> refund");
    }

    function test_Refund_OracleLockMissedPastGrace() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up,   address(0));
        _bet(bob,   1 ether, WorldBet.Direction.Down, address(0));

        vm.warp((uint256(id) + 1) * ROUND_DURATION + 1801);
        wb.lockRound(ASSET, id);

        (WorldBet.Round memory r, ) = wb.roundView(ASSET, id, alice);
        assertEq(r.status, 4, "lock-oracle-missed -> refund");
    }

    function test_LockRevertsBeforeGrace() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up, address(0));
        _advanceToLock(id);
        vm.expectRevert(bytes("WB: oracle pending"));
        wb.lockRound(ASSET, id);
    }

    // ---------- claim guarantees ----------

    function test_DoubleClaimReverts() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up,   address(0));
        _bet(bob,   1 ether, WorldBet.Direction.Down, address(0));
        _settleWith(id, 100e8, 110e8);
        vm.prank(alice); wb.claim(ASSET, id);
        vm.expectRevert(bytes("WB: claimed"));
        vm.prank(alice); wb.claim(ASSET, id);
    }

    function test_ClaimRevertsBeforeSettle() public {
        uint64 id = wb.currentRoundId();
        _bet(alice, 1 ether, WorldBet.Direction.Up, address(0));
        vm.expectRevert(bytes("WB: not final"));
        vm.prank(alice); wb.claim(ASSET, id);
    }

    // ---------- anti-whale cap ----------

    function test_MaxBetCap() public {
        vm.prank(owner);
        wb.setMaxBetPerRound(ASSET, 0.5 ether);
        _bet(alice, 0.5 ether, WorldBet.Direction.Up, address(0));
        vm.expectRevert(bytes("WB: cap"));
        _bet(alice, 0.5 ether, WorldBet.Direction.Up, address(0));
    }

    // ---------- burn ----------

    function test_BurnFlushesPending() public {
        _bet(alice, 100 ether, WorldBet.Direction.Up, address(0));
        uint256 pending = wb.pendingBurn();
        assertGt(pending, 0);

        uint256 deadBefore = wl.balanceOf(DEAD);
        wb.burn();

        assertEq(wb.pendingBurn(), 0, "flushed");
        assertEq(wb.totalBurned(), pending, "totalBurned");
        assertEq(wl.balanceOf(DEAD) - deadBefore, pending, "dEaD got it");
    }

    function test_BurnRevertsWhenZero() public {
        vm.expectRevert(bytes("WB: zero"));
        wb.burn();
    }

    // ---------- access control ----------

    function test_OnlyOwnerCanRegister() public {
        bytes32 newAsset = keccak256("DOGE/USD");
        vm.expectRevert(bytes("WB: not owner"));
        vm.prank(alice);
        wb.registerAsset(newAsset);
    }

    function test_OnlyOwnerCanDistributePrize() public {
        _bet(alice, 100 ether, WorldBet.Direction.Up, address(0));
        address[] memory r = new address[](1); r[0] = bob;
        uint256[] memory a = new uint256[](1); a[0] = 1 wei;

        vm.expectRevert(bytes("WB: not owner"));
        vm.prank(alice);
        wb.distributePrize(r, a);

        vm.prank(owner);
        wb.distributePrize(r, a);
    }

    // ---------- solvency invariant (single-round) ----------

    function testFuzz_Solvency_SingleRound(uint96 upAmt, uint96 downAmt) public {
        upAmt   = uint96(bound(upAmt,   1e16, 1e22));
        downAmt = uint96(bound(downAmt, 1e16, 1e22));

        wl.mint(alice, upAmt);
        wl.mint(bob,   downAmt);

        uint64 id = wb.currentRoundId();
        _bet(alice, upAmt,   WorldBet.Direction.Up,   address(0));
        _bet(bob,   downAmt, WorldBet.Direction.Down, address(0));

        _settleWith(id, 100e8, 110e8);
        vm.prank(alice); wb.claim(ASSET, id);

        vm.expectRevert(bytes("WB: nothing"));
        vm.prank(bob); wb.claim(ASSET, id);

        uint256 expectedRemaining = wb.prizePool() + wb.pendingBurn();
        uint256 actual = wl.balanceOf(address(wb));
        assertLe(actual - expectedRemaining, 2, "no leak > 2 wei");
        assertGe(actual, expectedRemaining, "no underfund");
    }
}
