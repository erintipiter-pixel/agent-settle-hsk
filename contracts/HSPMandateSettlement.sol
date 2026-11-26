// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HSPMandateSettlement
/// @notice Agent-to-agent payment settlement in the shape of the HashKey
///         Settlement Platform (HSP) flow described on the official
///         HSK Chain Horizon (DoraHacks) Track 2 brief:
///
///         1. The receiving (payee) agent publishes Payment Terms.
///         2. The paying agent reads the terms and creates a Payment Mandate
///            bound to the hash of those terms.
///         3. The paying agent signs the mandate with its wallet (EIP-712).
///         4. A gateway verifies the signature and executes the on-chain
///            payment (this contract is the verification + execution point;
///            the relayer calling `settle` plays the gateway role).
///         5. Settlement writes a Receipt that anyone can verify against
///            the mandate hash — the on-chain hash becomes the auditable
///            financial document, mirroring HSP's stated design goal.
///
/// @dev HSK Chain testnet (chainId 133) is the deployment target during the
///      hackathon. This contract is chain-agnostic; the EIP-712 domain
///      binds signatures to the deploying chain and this contract address.
contract HSPMandateSettlement {
    // ------------------------------------------------------------------ types

    /// @notice Payment terms published by the receiving agent (off-chain
    ///         document; only its hash is bound into the mandate).
    struct PaymentTerms {
        address payee; // receiving agent wallet
        address token; // ERC-20 token address; address(0) = native HSK
        uint256 amount; // amount in the token's smallest unit
        bytes32 memoHash; // keccak256 of the invoice / service description
        uint256 expiry; // terms are void after this unix timestamp
    }

    /// @notice A payer-signed authorization to pay, bound to one terms hash.
    struct PaymentMandate {
        address payer; // paying agent wallet (the signer)
        address payee; // must equal terms.payee
        address token; // must equal terms.token
        uint256 amount; // must equal terms.amount
        bytes32 termsHash; // hashTerms(terms)
        uint256 nonce; // payer-scoped replay protection
        uint256 deadline; // mandate is void after this unix timestamp
    }

    /// @notice Immutable record of one executed settlement.
    struct Receipt {
        bytes32 mandateHash; // EIP-712 struct hash of the settled mandate
        address payer;
        address payee;
        address token;
        uint256 amount;
        bytes32 termsHash;
        uint64 settledAt; // block timestamp at settlement
    }

    // ------------------------------------------------------------- EIP-712

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _TERMS_TYPEHASH =
        keccak256("PaymentTerms(address payee,address token,uint256 amount,bytes32 memoHash,uint256 expiry)");
    bytes32 private constant _MANDATE_TYPEHASH = keccak256(
        "PaymentMandate(address payer,address payee,address token,uint256 amount,bytes32 termsHash,uint256 nonce,uint256 deadline)"
    );

    bytes32 public immutable domainSeparator;

    // ----------------------------------------------------------------- state

    Receipt[] public receipts;

    /// @notice mandateHash => receipt id + 1 (0 = not settled).
    mapping(bytes32 => uint256) public receiptByMandate;

    /// @notice payer => nonce => consumed.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    /// @notice termsHash => payee that published it on-chain (optional anchor).
    mapping(bytes32 => address) public termsPublisher;

    // ---------------------------------------------------------------- events

    event TermsPublished(bytes32 indexed termsHash, address indexed payee, address token, uint256 amount);
    event PaymentSettled(
        uint256 indexed receiptId,
        bytes32 indexed mandateHash,
        address indexed payer,
        address payee,
        address token,
        uint256 amount,
        bytes32 termsHash
    );

    // ---------------------------------------------------------------- errors

    error ZeroAmount();
    error ZeroPayee();
    error TermsMismatch();
    error TermsExpired(uint256 expiry);
    error MandateExpired(uint256 deadline);
    error InvalidSignature();
    error NonceUsed(address payer, uint256 nonce);
    error AlreadySettled(bytes32 mandateHash);
    error NativeValueMismatch(uint256 expected, uint256 sent);
    error TransferFailed();

    constructor() {
        domainSeparator = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes("HSPAgentSettlement")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // -------------------------------------------------------------- hashing

    /// @notice Hash of a payee's payment terms (EIP-712 struct hash).
    function hashTerms(PaymentTerms calldata terms) public pure returns (bytes32) {
        return keccak256(abi.encode(_TERMS_TYPEHASH, terms.payee, terms.token, terms.amount, terms.memoHash, terms.expiry));
    }

    /// @notice EIP-712 struct hash of a mandate.
    function hashMandate(PaymentMandate calldata m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(_MANDATE_TYPEHASH, m.payer, m.payee, m.token, m.amount, m.termsHash, m.nonce, m.deadline)
        );
    }

    /// @notice Full EIP-712 signing digest of a mandate.
    function mandateDigest(PaymentMandate calldata m) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, hashMandate(m)));
    }

    // ----------------------------------------------------------------- flow

    /// @notice Optional on-chain anchor for a payee's terms, so a payer can
    ///         confirm the terms hash was published by the payee itself.
    function publishTerms(PaymentTerms calldata terms) external returns (bytes32 termsHash) {
        if (terms.payee == address(0)) revert ZeroPayee();
        if (terms.amount == 0) revert ZeroAmount();
        termsHash = hashTerms(terms);
        termsPublisher[termsHash] = msg.sender;
        emit TermsPublished(termsHash, terms.payee, terms.token, terms.amount);
    }

    /// @notice Verify a payer-signed mandate and execute the payment.
    /// @dev The caller plays the HSP Gateway role: it relays the mandate and
    ///      the payer's signature; this contract performs verification and
    ///      the on-chain settlement, then issues the receipt.
    /// @param terms the payee's payment terms the mandate is bound to.
    /// @param m the payment mandate created by the payer agent.
    /// @param signature payer's EIP-712 signature over `mandateDigest(m)`.
    /// @return receiptId id of the issued settlement receipt.
    function settle(PaymentTerms calldata terms, PaymentMandate calldata m, bytes calldata signature)
        external
        payable
        returns (uint256 receiptId)
    {
        // 1. The mandate must be bound to exactly these terms.
        if (hashTerms(terms) != m.termsHash) revert TermsMismatch();
        if (terms.payee != m.payee || terms.token != m.token || terms.amount != m.amount) {
            revert TermsMismatch();
        }
        if (m.amount == 0) revert ZeroAmount();
        if (block.timestamp > terms.expiry) revert TermsExpired(terms.expiry);
        if (block.timestamp > m.deadline) revert MandateExpired(m.deadline);

        // 2. Replay protection.
        bytes32 mandateHash = hashMandate(m);
        if (receiptByMandate[mandateHash] != 0) revert AlreadySettled(mandateHash);
        if (usedNonce[m.payer][m.nonce]) revert NonceUsed(m.payer, m.nonce);

        // 3. The payer agent's wallet signature authorizes this exact mandate.
        if (_recover(mandateDigest(m), signature) != m.payer) revert InvalidSignature();

        usedNonce[m.payer][m.nonce] = true;

        // 4. Execute the payment.
        if (m.token == address(0)) {
            if (msg.value != m.amount) revert NativeValueMismatch(m.amount, msg.value);
            (bool ok,) = m.payee.call{value: m.amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (msg.value != 0) revert NativeValueMismatch(0, msg.value);
            _transferFrom(m.token, m.payer, m.payee, m.amount);
        }

        // 5. Issue the verifiable receipt.
        receiptId = receipts.length;
        receipts.push(
            Receipt({
                mandateHash: mandateHash,
                payer: m.payer,
                payee: m.payee,
                token: m.token,
                amount: m.amount,
                termsHash: m.termsHash,
                settledAt: uint64(block.timestamp)
            })
        );
        receiptByMandate[mandateHash] = receiptId + 1;

        emit PaymentSettled(receiptId, mandateHash, m.payer, m.payee, m.token, m.amount, m.termsHash);
    }

    // ------------------------------------------------------------ verification

    /// @notice Total number of settlements executed.
    function receiptCount() external view returns (uint256) {
        return receipts.length;
    }

    /// @notice Full receipt record by id.
    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        require(receiptId < receipts.length, "unknown receipt");
        return receipts[receiptId];
    }

    /// @notice Anyone can verify a claimed settlement: recompute the mandate
    ///         hash from the mandate itself and compare it with the receipt.
    function verifyReceipt(uint256 receiptId, PaymentMandate calldata m) external view returns (bool ok) {
        if (receiptId >= receipts.length) return false;
        Receipt storage r = receipts[receiptId];
        return r.mandateHash == hashMandate(m) && r.payer == m.payer && r.payee == m.payee && r.amount == m.amount
            && r.termsHash == m.termsHash;
    }

    // -------------------------------------------------------------- internal

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Reject malleable signatures (EIP-2 low-s rule).
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _transferFrom(address token, address from, address to, uint256 amount) internal {
        // Minimal ERC-20 transferFrom call; accepts tokens that return
        // nothing (USDT-style) as well as standard bool-returning tokens.
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount)); // transferFrom(address,address,uint256)
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
