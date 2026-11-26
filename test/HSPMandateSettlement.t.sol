// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HSPMandateSettlement} from "../contracts/HSPMandateSettlement.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract HSPMandateSettlementTest is Test {
    HSPMandateSettlement internal settlement;
    MockERC20 internal token;

    uint256 internal payerKey = 0xB0B;
    uint256 internal strangerKey = 0xBAD;
    address internal payer;
    address internal payee = makeAddr("payeeAgent");
    address internal gateway = makeAddr("hspGateway"); // relayer role

    uint256 internal constant AMOUNT = 100_000000; // 100 mUSD (6 decimals)

    function setUp() public {
        settlement = new HSPMandateSettlement();
        token = new MockERC20();
        payer = vm.addr(payerKey);
        token.mint(payer, 1_000_000000);
        vm.prank(payer);
        token.approve(address(settlement), type(uint256).max);
        vm.deal(payer, 10 ether);
    }

    // ------------------------------------------------------------ helpers

    function _terms(address tok, uint256 amount) internal view returns (HSPMandateSettlement.PaymentTerms memory) {
        return HSPMandateSettlement.PaymentTerms({
            payee: payee,
            token: tok,
            amount: amount,
            memoHash: keccak256("invoice: research-report delivery, task #42"),
            expiry: block.timestamp + 1 days
        });
    }

    function _mandate(HSPMandateSettlement.PaymentTerms memory terms, uint256 nonce)
        internal
        view
        returns (HSPMandateSettlement.PaymentMandate memory)
    {
        return HSPMandateSettlement.PaymentMandate({
            payer: payer,
            payee: terms.payee,
            token: terms.token,
            amount: terms.amount,
            termsHash: settlement.hashTerms(terms),
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(uint256 key, HSPMandateSettlement.PaymentMandate memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.mandateDigest(m));
        return abi.encodePacked(r, s, v);
    }

    // -------------------------------------------------------- happy paths

    function test_SettleERC20_HappyPath() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(token), AMOUNT);
        settlement.publishTerms(terms);

        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 1);
        bytes memory sig = _sign(payerKey, m);

        uint256 payeeBefore = token.balanceOf(payee);
        vm.prank(gateway); // gateway relays; payer's signature authorizes
        uint256 receiptId = settlement.settle(terms, m, sig);

        assertEq(receiptId, 0);
        assertEq(token.balanceOf(payee), payeeBefore + AMOUNT);
        assertTrue(settlement.verifyReceipt(receiptId, m));

        HSPMandateSettlement.Receipt memory r = settlement.getReceipt(receiptId);
        assertEq(r.payer, payer);
        assertEq(r.payee, payee);
        assertEq(r.amount, AMOUNT);
        assertEq(r.termsHash, m.termsHash);
        assertEq(r.mandateHash, settlement.hashMandate(m));
    }

    function test_SettleNative_HappyPath() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(0), 1 ether);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 7);
        bytes memory sig = _sign(payerKey, m);

        uint256 payeeBefore = payee.balance;
        vm.prank(payer);
        uint256 receiptId = settlement.settle{value: 1 ether}(terms, m, sig);

        assertEq(payee.balance, payeeBefore + 1 ether);
        assertTrue(settlement.verifyReceipt(receiptId, m));
    }

    // ----------------------------------------------------- rejection paths

    function test_RevertBadSignature() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(token), AMOUNT);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 1);
        bytes memory sig = _sign(strangerKey, m); // signed by the wrong wallet

        vm.expectRevert(HSPMandateSettlement.InvalidSignature.selector);
        settlement.settle(terms, m, sig);
    }

    function test_RevertAmountMismatch() public {
        // Payee's real terms say AMOUNT + 1; the mandate was created against
        // terms for AMOUNT — the binding must break.
        HSPMandateSettlement.PaymentTerms memory signedTerms = _terms(address(token), AMOUNT);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(signedTerms, 1);
        bytes memory sig = _sign(payerKey, m);

        HSPMandateSettlement.PaymentTerms memory tamperedTerms = _terms(address(token), AMOUNT + 1);
        vm.expectRevert(HSPMandateSettlement.TermsMismatch.selector);
        settlement.settle(tamperedTerms, m, sig);
    }

    function test_RevertReplayNonce() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(token), AMOUNT);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 3);
        bytes memory sig = _sign(payerKey, m);

        settlement.settle(terms, m, sig);
        vm.expectRevert(abi.encodeWithSelector(HSPMandateSettlement.AlreadySettled.selector, settlement.hashMandate(m)));
        settlement.settle(terms, m, sig);
    }

    function test_RevertExpiredMandate() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(token), AMOUNT);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 1);
        m.deadline = block.timestamp - 1; // already expired (termsHash unchanged)
        bytes memory sig = _sign(payerKey, m);

        vm.expectRevert(abi.encodeWithSelector(HSPMandateSettlement.MandateExpired.selector, m.deadline));
        settlement.settle(terms, m, sig);
    }

    function test_VerifyReceipt_RejectsForeignMandate() public {
        HSPMandateSettlement.PaymentTerms memory terms = _terms(address(token), AMOUNT);
        HSPMandateSettlement.PaymentMandate memory m = _mandate(terms, 1);
        settlement.settle(terms, m, _sign(payerKey, m));

        HSPMandateSettlement.PaymentMandate memory other = _mandate(terms, 2);
        assertFalse(settlement.verifyReceipt(0, other));
    }
}
