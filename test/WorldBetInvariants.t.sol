// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WorldBet} from "../contracts/WorldBet.sol";
import {MockOracle} from "./MockOracle.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Action wrapper that Foundry's invariant fuzzer drives.
contract Handler is Test {
    WorldBet immutable wb;
    MockOracle immutable oracle;
    MockERC20 immutable wl;
    bytes32 immutable asset;

    uint64 constant ROUND_DURATION = 3600;

    address[] public users;
    uint64[]  public knownRounds;

    // ---- ghosts ----
    uint256 public ghostInflow;
    uint256 public ghostClaimedOut;
    uint256 public ghostBurnedOut;
    uint256 public ghostRefClaimedOut;
    mapping(address => address) public ghostReferrer;

    constructor(WorldBet _wb, MockOracle _oracle, MockERC20 _wl, bytes32 _asset, address[] memory _users) {
        wb = _wb;
        oracle = _oracle;
        wl = _wl;
        asset = _asset;
        for (uint256 i = 0; i < _users.length; i++) users.push(_users[i]);
    }

    function _user(uint256 idx) internal view returns (address) {
        return users[idx % users.length];
    }

    function _knownRound(uint256 idx) internal view returns (uint64) {
        if (knownRounds.length == 0) return 0;
        return knownRounds[idx % knownRounds.length];
    }

    function _trackRound(uint64 id) internal {
        for (uint256 i = 0; i < knownRounds.length; i++) {
            if (knownRounds[i] == id) return;
        }
        knownRounds.push(id);
    }

    function bet(uint8 userIdx, uint8 refIdx, uint8 dirSeed, uint96 amount) external {
        amount = uint96(bound(amount, 1 wei, 100 ether));
        address user = _user(userIdx);
        address ref = refIdx < users.length ? users[refIdx] : address(0);
        WorldBet.Direction dir = (dirSeed & 1) == 0 ? WorldBet.Direction.Up : WorldBet.Direction.Down;

        uint64 id = wb.currentRoundId();
        ( WorldBet.Round memory r, ) = wb.roundView(asset, id, user);
        if (r.lockTime != 0 && block.timestamp >= r.lockTime) return;

        // Mint + approve + bet.
        wl.mint(user, amount);
        vm.prank(user);
        wl.approve(address(wb), type(uint256).max); // idempotent
        vm.prank(user);
        try wb.bet(asset, dir, ref, amount) {
            ghostInflow += amount;
            _trackRound(id);
            if (ghostReferrer[user] == address(0) && ref != address(0) && ref != user) {
                ghostReferrer[user] = ref;
            }
        } catch {
            // expected revert (cap, etc.) — wl was minted but not consumed.
            // Burn that surplus to keep ghosts clean.
            vm.prank(user);
            wl.transfer(address(0xdead0001), amount); // sink unused mint
        }
    }

    function warp(uint16 secs) external {
        secs = uint16(bound(secs, 1, 4 * 3600));
        vm.warp(block.timestamp + secs);
    }

    function lockRound(uint8 idx, uint128 priceSeed) external {
        if (knownRounds.length == 0) return;
        uint64 id = _knownRound(idx);
        ( WorldBet.Round memory r, ) = wb.roundView(asset, id, address(0));
        if (r.status != 0) return;
        if (block.timestamp < r.lockTime) return;

        if (priceSeed % 2 == 0) {
            uint128 px = uint128(bound(uint256(priceSeed), 1, 1e18));
            oracle.set(asset, uint64(r.lockTime / ROUND_DURATION), px);
        }
        try wb.lockRound(asset, id) {} catch {}
    }

    function settleRound(uint8 idx, uint128 priceSeed) external {
        if (knownRounds.length == 0) return;
        uint64 id = _knownRound(idx);
        ( WorldBet.Round memory r, ) = wb.roundView(asset, id, address(0));
        if (r.status >= 2) return;
        if (block.timestamp < r.closeTime) return;

        if (priceSeed % 2 == 0) {
            uint128 px = uint128(bound(uint256(priceSeed), 1, 1e18));
            oracle.set(asset, uint64(r.closeTime / ROUND_DURATION), px);
        }
        try wb.settleRound(asset, id) {} catch {}
    }

    function claim(uint8 userIdx, uint8 roundIdx) external {
        if (knownRounds.length == 0) return;
        address user = _user(userIdx);
        uint64 id = _knownRound(roundIdx);

        uint256 balBefore = wl.balanceOf(user);
        vm.prank(user);
        try wb.claim(asset, id) {
            ghostClaimedOut += wl.balanceOf(user) - balBefore;
        } catch {}
    }

    function burnIt() external {
        uint256 deadBefore = wl.balanceOf(address(0xdEaD));
        try wb.burn() {
            ghostBurnedOut += wl.balanceOf(address(0xdEaD)) - deadBefore;
        } catch {}
    }

    function claimRef(uint8 userIdx) external {
        address user = _user(userIdx);
        uint256 balBefore = wl.balanceOf(user);
        vm.prank(user);
        try wb.claimReferral() {
            ghostRefClaimedOut += wl.balanceOf(user) - balBefore;
        } catch {}
    }

    function userCount() external view returns (uint256) { return users.length; }
}

contract WorldBetInvariantsTest is Test {
    WorldBet wb;
    MockOracle oracle;
    MockERC20 wl;
    Handler handler;

    bytes32 constant ASSET = keccak256("WL/USD");

    function setUp() public {
        vm.warp(1_700_000_000);

        oracle = new MockOracle();
        wl = new MockERC20();
        wb = new WorldBet(address(oracle), address(wl), address(this));
        wb.registerAsset(ASSET);

        address[] memory users = new address[](5);
        users[0] = address(0xA11CE);
        users[1] = address(0xBEEF);
        users[2] = address(0xCAFE);
        users[3] = address(0xDEAD0001);
        users[4] = address(0xFADE);

        handler = new Handler(wb, oracle, wl, ASSET, users);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.bet.selector;
        selectors[1] = handler.warp.selector;
        selectors[2] = handler.lockRound.selector;
        selectors[3] = handler.settleRound.selector;
        selectors[4] = handler.claim.selector;
        selectors[5] = handler.burnIt.selector;
        selectors[6] = handler.claimRef.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Contract WL balance == inflow - all outflows.
    function invariant_BalanceConservation() public view {
        uint256 expected = handler.ghostInflow()
            - handler.ghostClaimedOut()
            - handler.ghostBurnedOut()
            - handler.ghostRefClaimedOut();
        assertEq(wl.balanceOf(address(wb)), expected, "balance leak");
    }

    function invariant_AccumulatorsBounded() public view {
        uint256 acc = wb.prizePool() + wb.pendingBurn();
        assertLe(acc, handler.ghostInflow(), "accumulators > inflow");
    }

    function invariant_BurnedMonotonic() public view {
        assertEq(wb.totalBurned(), handler.ghostBurnedOut(), "burned mismatch");
    }

    function invariant_ReferrerSticky() public view {
        for (uint256 i = 0; i < handler.userCount(); i++) {
            address u = handler.users(i);
            address gRef = handler.ghostReferrer(u);
            if (gRef != address(0)) {
                assertEq(wb.referrer(u), gRef, "referrer mutated");
            }
        }
    }

    function invariant_GlobalAccounting() public view {
        uint256 lhs = wb.prizePool() + wb.pendingBurn()
            + handler.ghostClaimedOut() + handler.ghostBurnedOut()
            + handler.ghostRefClaimedOut() + _sumReferralBalances();
        assertLe(lhs - _sumReferralBalances(), handler.ghostInflow(), "lhs > inflow");
    }

    function _sumReferralBalances() internal view returns (uint256 s) {
        for (uint256 i = 0; i < handler.userCount(); i++) {
            s += wb.referralBalance(handler.users(i));
        }
    }
}
