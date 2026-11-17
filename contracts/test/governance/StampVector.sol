// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";

// The owner-signed stamp's pinned vector (spec §3.6; rulings B5 and C4): the EIP-712 domain separator, the
// struct hash, the digest and the owner's signature for one fixed stamp on each target, computed OUTSIDE
// the contracts, never with their formula. Stamp.t.sol's test_domainAndTypehashMatchLocalComputation
// checks the contracts and both lenses against these constants, and Task 48's ops signer copies them
// (its hashesMatchTheContract test).
//
// The inputs: the owner is the fixtures' makeAddrAndKey("owner") (its key is uint256(keccak256("owner")));
// the stamp is OwnerStamp(asOf = 1798761600, 2027-01-01T00:00:00Z); the domain is
// EIP712Domain(name "Cascade", version "3.2", chainId, verifyingContract) for the vault on Bittensor
// (chain 964, at VAULT_ADDRESS) and the front door on Base (chain 8453, at DOOR_ADDRESS); the test deploys
// each target at its address with deployCodeTo.
//
// How they were computed (2026-11-01, once; the three agree on every value):
//   1. viem 2.57.7 (web/node_modules/viem): hashDomain({ domain, types: { EIP712Domain } }),
//      hashStruct({ types: { OwnerStamp: [{ name: 'asOf', type: 'uint64' }] }, primaryType: 'OwnerStamp',
//      data: { asOf } }), hashTypedData(...) for the digest, keccak256(toHex('OwnerStamp(uint64 asOf)')) for
//      the typehash, and privateKeyToAccount(keccak256(toBytes('owner'))).signTypedData(...) for the
//      signature (RFC 6979, so deterministic);
//   2. cast 1.7.1, the same typed data as JSON: `cast wallet sign --data --from-file vault.json
//      --private-key $(cast keccak owner)` (alloy's EIP-712), giving the same signatures;
//   3. cast 1.7.1, by hand: TYPEHASH=$(cast keccak "OwnerStamp(uint64 asOf)");
//      STRUCT=$(cast keccak $(cast abi-encode "f(bytes32,uint64)" $TYPEHASH 1798761600));
//      DS=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)"
//        $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
//        $(cast keccak Cascade) $(cast keccak 3.2) 964 0xCA5cADE000000000000000000000000000000964));
//      DIGEST=$(cast keccak 0x1901${DS#0x}${STRUCT#0x}); cast wallet sign --no-hash --private-key
//      $(cast keccak owner) $DIGEST   (and 8453 with DOOR_ADDRESS for the front door's).

// The owner's key and address: makeAddrAndKey("owner").
uint256 constant STAMP_VECTOR_OWNER_KEY = 0x02016836a56b71f0d02689e69e326f4f4c1b9057164ef592671cf0d37c8040c0;
address constant STAMP_VECTOR_OWNER = 0x7c8999dC9a822c1f0Df42023113EDB4FDd543266;

// keccak256("OwnerStamp(uint64 asOf)").
bytes32 constant STAMP_VECTOR_TYPEHASH = 0x4a2ff47f9ebab098e58b19433a88d005ec2123b12ee173beccfe13a7b0a94ebf;
// The stamp's as-of time, 2027-01-01T00:00:00Z.
uint64 constant STAMP_VECTOR_AS_OF = 1798761600;
// keccak256(abi.encode(STAMP_VECTOR_TYPEHASH, STAMP_VECTOR_AS_OF)), the same for both targets.
bytes32 constant STAMP_VECTOR_STRUCT_HASH = 0xc758607de90d4c32798d08e2665888f960549e4056311f113a2ed144d52cea92;

// The vault on Bittensor.
uint256 constant STAMP_VECTOR_VAULT_CHAIN_ID = 964;
address constant STAMP_VECTOR_VAULT_ADDRESS = 0xCA5cADE000000000000000000000000000000964;
bytes32 constant STAMP_VECTOR_VAULT_DOMAIN_SEPARATOR =
    0xf8fbbff19b87cd1783cd59e6bb525df7d8b0ae27bd5c6ef8e087a2688e10dc8f;
bytes32 constant STAMP_VECTOR_VAULT_DIGEST = 0x424b3ac38a739512242e3af08f69ef6a369425dfc523f081e86c899461ca299a;
// The owner's signature of the vault's digest: r, s, v (v = 27).
bytes constant STAMP_VECTOR_VAULT_SIG =
    hex"a3a968c7f3f4fc461bbc512e2e7686a0fbedbecb06da1fb7c588ef7b998299cd62fe248d0304e4769d47608d4b72ff2bac69a214c64f4869b3eee7a0ee3b71761b";

// The front door on Base.
uint256 constant STAMP_VECTOR_DOOR_CHAIN_ID = 8453;
address constant STAMP_VECTOR_DOOR_ADDRESS = 0xcA5cAdE000000000000000000000000000008453;
bytes32 constant STAMP_VECTOR_DOOR_DOMAIN_SEPARATOR =
    0x250114fdfbfaf4d09a0e86d6d983b53832962f05688abee0deb82861e448ed13;
bytes32 constant STAMP_VECTOR_DOOR_DIGEST = 0x5547690fc2a2a65c0cf61b749687f9f5b4e98680b030aedb9ede91afe17ef50b;
// The owner's signature of the front door's digest: r, s, v (v = 27).
bytes constant STAMP_VECTOR_DOOR_SIG =
    hex"ca8b6f10fdb3406e540f0024bd2b14bc75502b2c58e5855fd01ffad7bba189176b2dc80f685a9ae1958a260e530035735433e67d7cc4cceb7b6eef8f85a321f31b";

/// Test only: an owner stamp's digest and signature for any target, chain and time, for the tests that
/// relay stamps (Stamp.t.sol, and the governance campaigns of Tasks 39 to 41). The digest is EIP-712's,
/// written out here; Stamp.t.sol pins it to the vector above (test_domainAndTypehashMatchLocalComputation),
/// so a test signing with it signs what an outside signer would.
library Stamps {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Cascade"),
                keccak256("3.2"),
                chainId,
                verifyingContract
            )
        );
    }

    function digest(uint256 chainId, address verifyingContract, uint64 asOf) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(keccak256("OwnerStamp(uint64 asOf)"), asOf));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(chainId, verifyingContract), structHash));
    }

    /// `key`'s 65-byte signature of `d`: r, s, v (v 27 or 28, s in the lower half, as vm.sign gives).
    function sign(uint256 key, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }

    /// `key`'s stamp as of `asOf` for `target` on this chain.
    function signed(uint256 key, address target, uint64 asOf) internal view returns (bytes memory) {
        return sign(key, digest(block.chainid, target, asOf));
    }
}
