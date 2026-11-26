// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HSPMandateSettlement} from "../contracts/HSPMandateSettlement.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

/// @notice Deploys HSPMandateSettlement. Optionally also deploys the
///         test-only MockERC20 (stand-in for a testnet stablecoin) when
///         the env var DEPLOY_MOCK_TOKEN=1 is set — used for the local
///         anvil demo; on HSK testnet the organizer-provided test USDC
///         address is used instead and no mock is deployed.
///
/// Usage (local anvil):
///   DEPLOY_MOCK_TOKEN=1 forge script script/Deploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil-key>
///
/// Usage (HSK testnet, chainId 133) is normally via
/// client/scripts/deploy-testnet.mjs, which reads the agent key
/// in-process; this script remains the canonical Foundry path.
contract Deploy is Script {
    function run() external {
        bool deployMock = vm.envOr("DEPLOY_MOCK_TOKEN", uint256(0)) == 1;

        vm.startBroadcast();
        HSPMandateSettlement settlement = new HSPMandateSettlement();
        console.log("HSPMandateSettlement:", address(settlement));

        if (deployMock) {
            MockERC20 token = new MockERC20();
            console.log("MockERC20 (test USDC stand-in):", address(token));
        }
        vm.stopBroadcast();
    }
}
