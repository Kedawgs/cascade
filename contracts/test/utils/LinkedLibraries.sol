// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {LibraryLink, LibraryLinks} from "./generated/LibraryLinks.sol";

/// I-32's run-time half (spec §8.1; Task 34a, ruling DB9): the vault's code names the deployed L1, L2, L3 and L4 at
/// its link offsets, L3's names the deployed payout math at its own, and the code at each linked address is that
/// library's deployed code (its artifact's runtime code, linked as forge linked the build, with the library's own
/// address in its call guard's words). Every reference to one library, in either code, names one address. The
/// offsets come from test/utils/generated/LibraryLinks.sol (script/gen-library-links.mjs), so no fs_permissions are
/// needed; the artifacts come from forge's own build through vm.getDeployedCode. Code cannot change after deploy
/// (Cancun: no SELFDESTRUCT that clears it), so a campaign asserts this once, in its setUp, not after every step.
library LinkedLibraries {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// The library L3 is in the vault's links.
    bytes32 private constant L3 = keccak256("CascadePayoutLib");

    /// Asserts I-32's run-time half for the vault at `vault`, whose runtime code's links are `vaultLinks`
    /// (LibraryLinks.cascadeVault() for a CascadeVault, LibraryLinks.vaultInternals() for its test-only subclass), and
    /// for the L3 it links (LibraryLinks.cascadePayoutLib()). Reverts, naming the library, on any difference.
    function assertLinked(address vault, LibraryLink[] memory vaultLinks) internal view {
        (string[] memory names, address[] memory addrs) = assertLinks(vault, vaultLinks);
        address l3;
        for (uint256 i; i < names.length; ++i) {
            if (keccak256(bytes(names[i])) == L3) l3 = addrs[i];
        }
        require(l3 != address(0), "I-32: the vault links no CascadePayoutLib");
        (string[] memory names3, address[] memory addrs3) = assertLinks(l3, LibraryLinks.cascadePayoutLib());
        // one library, one address, in either code (the graph links no library twice today; a later link must agree)
        for (uint256 i; i < names3.length; ++i) {
            for (uint256 j; j < names.length; ++j) {
                if (keccak256(bytes(names3[i])) != keccak256(bytes(names[j]))) continue;
                require(addrs3[i] == addrs[j], string.concat("I-32: the vault and L3 link two ", names[j]));
            }
        }
    }

    /// Asserts that `code`'s owner `target` names, at every offset of each of `links`, one address per library, and
    /// that the code there is that library's deployed code; returns the libraries' names and addresses, in `links`'
    /// order.
    function assertLinks(address target, LibraryLink[] memory links)
        internal
        view
        returns (string[] memory names, address[] memory addrs)
    {
        bytes memory code = target.code;
        require(code.length != 0, "I-32: no code at the linking address");
        names = new string[](links.length);
        addrs = new address[](links.length);
        for (uint256 i; i < links.length; ++i) {
            LibraryLink memory link = links[i];
            require(link.offsets.length != 0, string.concat("I-32: no offset for ", link.name));
            address a = addressAt(code, link.offsets[0]);
            for (uint256 j = 1; j < link.offsets.length; ++j) {
                require(addressAt(code, link.offsets[j]) == a, string.concat("I-32: two addresses for one ", link.name));
            }
            assertLibraryCode(link.name, a);
            names[i] = link.name;
            addrs[i] = a;
        }
    }

    /// Asserts that the code at `lib` is library `name`'s deployed code: its artifact's runtime code (forge links the
    /// payout math into L3's as it linked the build) with `lib` in each of its own-address words.
    function assertLibraryCode(string memory name, address lib) internal view {
        require(lib.code.length != 0, string.concat("I-32: nothing deployed where the code names ", name));
        bytes memory expected = vm.getDeployedCode(string.concat(name, ".sol:", name));
        uint256[] memory self = LibraryLinks.selfAddressWords(name);
        for (uint256 i; i < self.length; ++i) {
            putAddressWord(expected, self[i], lib);
        }
        require(
            keccak256(lib.code) == keccak256(expected),
            string.concat("I-32: the code where the vault's links name ", name, " is not its deployed code")
        );
    }

    /// The 20-byte address at byte `offset` of `code`.
    function addressAt(bytes memory code, uint256 offset) internal pure returns (address) {
        require(offset + 20 <= code.length, "I-32: a link offset past the code's end");
        uint160 a;
        for (uint256 i; i < 20; ++i) {
            a = (a << 8) | uint8(code[offset + i]);
        }
        return address(a);
    }

    /// Writes `a` as the 32-byte word at byte `offset` of `code` (its low 20 bytes), as the deploy fills a library's
    /// own address into its call guard.
    function putAddressWord(bytes memory code, uint256 offset, address a) internal pure {
        require(offset + 32 <= code.length, "I-32: an own-address word past the code's end");
        uint256 w = uint256(uint160(a));
        for (uint256 i; i < 32; ++i) {
            code[offset + i] = bytes1(uint8(w >> (8 * (31 - i))));
        }
    }
}
