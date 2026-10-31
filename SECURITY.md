# Security

## Status

Cascade has been live on Base and Bittensor mainnet since 2026-10-30. It is early: so far it holds
only the founder's own money, and deposits are capped. The contracts have been reviewed many times
internally but are **not professionally audited**. Their source (`contracts/src/` here) is verified
as an exact match on Sourcify for all six contracts, and on the Bittensor explorer (taostats) for the
two Bittensor contracts. Basescan verification is still pending, so Basescan doesn't show the Base
contracts' source yet; use the Sourcify links below.

Launch limits:

- Deposits are capped at 40 TAO in total, and a batch carries at most 10 TAO.
- Payouts wait 24 hours before they are sent.
- One unstake carries at most 10 TAO, and unstakes are limited to 20% of the staked TAO a day, or
  10 TAO if that is more.

## The contracts (v3-launch)

| Contract | Chain | Address | Verified source |
|---|---|---|---|
| Front door (`CascadeFrontDoor`) | Base (8453) | [`0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA`](https://basescan.org/address/0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA) | [Sourcify](https://repo.sourcify.dev/8453/0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA) |
| Staker (`CascadeStaker`) | Base (8453) | [`0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E`](https://basescan.org/address/0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E) | [Sourcify](https://repo.sourcify.dev/8453/0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E) |
| TWAP oracle (`CascadeTwapOracle`) | Base (8453) | [`0xcAa85F00b6e470Dd28a31FBa982267B820736eBc`](https://basescan.org/address/0xcAa85F00b6e470Dd28a31FBa982267B820736eBc) | [Sourcify](https://repo.sourcify.dev/8453/0xcAa85F00b6e470Dd28a31FBa982267B820736eBc) |
| Base CCIP adapter (`CcipBaseAdapter`) | Base (8453) | [`0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92`](https://basescan.org/address/0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92) | [Sourcify](https://repo.sourcify.dev/8453/0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92) |
| Vault (`CascadeVault`) | Bittensor EVM (964) | [`0x450cD94401B45c72C09734071fe683F6b74Aea72`](https://evm.taostats.io/address/0x450cD94401B45c72C09734071fe683F6b74Aea72) | [Sourcify](https://repo.sourcify.dev/964/0x450cD94401B45c72C09734071fe683F6b74Aea72), [taostats](https://evm.taostats.io/address/0x450cD94401B45c72C09734071fe683F6b74Aea72?tab=contract) |
| Bittensor CCIP adapter (`CcipBittensorAdapter`) | Bittensor EVM (964) | [`0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1`](https://evm.taostats.io/address/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1) | [Sourcify](https://repo.sourcify.dev/964/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1), [taostats](https://evm.taostats.io/address/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1?tab=contract) |

**Only these addresses are Cascade.** Anything else is not Cascade's product, including Cascade's
own old test deployments (`v3-test` and `test-2026-10`), which still exist on-chain. Don't send money
to them. The only site is https://cascadefi.xyz.

Roles:

| Role | Address | What it can do |
|---|---|---|
| Owner | `0x478965abDe80ef000e0f3e60008B43ac46130bFC` | A single hardware-wallet account, the same on both chains. No multisig and no timelock, so its setting changes take effect at once (within the bounds in the code). A new front door or bridge still waits 7 days in public, and the guardian can veto it. A Safe multisig plus a timelock is planned before Cascade takes other people's money. |
| Guardian | `0xf996A598B75ab25B140bC50989C76eBB56B0187F` | Stop only: pause, remove a front door, disable a bridge, cancel a proposal. |
| Keeper | `0xBE2a34FE20C3006E759537922C807c228707DC23` | Times batches, staking, reward claims and USDC deliveries. It cannot take funds. |
| Treasury | `0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6` | Receives Cascade's fees and reward cut. |

The full trust model, what each role and outside party can and cannot do, and the known soft spots
are in [`contracts/README.md`](contracts/README.md).

## Reporting a vulnerability

Report privately through GitHub: https://github.com/Kedawgs/cascade/security/advisories/new (the
"Security" tab, then "Report a vulnerability"). Please don't open a public issue or discuss it in
public before it is fixed.

Include the affected contract or file and function, the scenario, and a proof of concept (a Foundry
test is ideal) if you have one. If money is at risk right now, say so in the title: the guardian can
pause at once.

We respond on a best-effort basis, within 72 hours.

## Scope

In scope:

- The v3-launch contracts above (source in `contracts/src/`), including how they use the outside
  contracts they depend on.
- The site, https://cascadefi.xyz (source in `web/`).
- The ops keeper (`ops/`) and the monitor (`indexer/`).

Out of scope:

- The old test deployments (`v3-test`, `test-2026-10`), unless the same bug affects v3-launch.
- Third-party contracts and services: Chainlink CCIP, ForeverMoney's bridged TAO and `AlphaVault`,
  Uniswap, the Bittensor chain and its precompiles, wallets, RPC providers and Cloudflare. Please
  report bugs in them to their owners; notes on how Cascade's use of them could fail are welcome here.
- Attacks that need the owner's key, or behaviour already listed as a soft spot or trust assumption
  in `contracts/README.md`, unless you show it is worse than written there.
- Denial of service by traffic, spam, social engineering or phishing of the team, and reports from
  automated scanners without a working exploit.
- Research notes, reports, design specs and plans in `docs/`, `reports/` and `research_notes/`.
