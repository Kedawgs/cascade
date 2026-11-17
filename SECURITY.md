# Security

## Status

Cascade's live deployment is `v3.2-launch`, on Base and Bittensor mainnet since 2026-11-16. It is
early: so far it holds only the founder's own money, while a mainnet canary with small amounts runs,
and deposits are capped. The contracts have been reviewed many times internally but are **not
professionally audited**. Their source (`contracts/src/` here) was submitted to Sourcify with this
publication.
It is verified on Sourcify for all 13 contracts and libraries: an exact match for 11, and a match for the vault and `CascadePayoutLib`, the two that link libraries (the links are in the table below).

The previous deployment, `v3-launch` (live from 2026-10-30), is empty and is being retired: see
[the previous deployment](#the-previous-deployment-v3-launch).

Launch limits:

- Deposits are capped at 40 TAO in total, and a batch carries at most 10 TAO. The smallest deposit
  is 0.04 TAO.
- Payouts wait 24 hours before they are sent.
- One unstake carries at most 10 TAO, and unstakes through Base are limited to 20% of the staked TAO
  a day, or 10 TAO if that is more. An unstake request costs 0.0002 ETH.
- Cascade keeps 10% of the staking rewards. The stake is with the validator tao.bot.

## The contracts (v3.2-launch)

| Contract | Chain | Address | Verified source |
|---|---|---|---|
| Front door (`CascadeFrontDoor`) | Base (8453) | [`0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e`](https://basescan.org/address/0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e) | [Sourcify](https://repo.sourcify.dev/8453/0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e) |
| Staker (`CascadeStaker`) | Base (8453) | [`0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87`](https://basescan.org/address/0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87) | [Sourcify](https://repo.sourcify.dev/8453/0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87) |
| TWAP oracle (`CascadeTwapOracle`) | Base (8453) | [`0xDddd746237b923A0081630F4DcE7857De568696D`](https://basescan.org/address/0xDddd746237b923A0081630F4DcE7857De568696D) | [Sourcify](https://repo.sourcify.dev/8453/0xDddd746237b923A0081630F4DcE7857De568696D) |
| Base CCIP adapter (`CcipBaseAdapter`) | Base (8453) | [`0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E`](https://basescan.org/address/0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E) | [Sourcify](https://repo.sourcify.dev/8453/0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E) |
| Front door lens (`CascadeDoorLens`, read-only) | Base (8453) | [`0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f`](https://basescan.org/address/0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f) | [Sourcify](https://repo.sourcify.dev/8453/0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f) |
| Vault (`CascadeVault`) | Bittensor EVM (964) | [`0x56544AfF15fccea33b4db189cB5B3726DBac724e`](https://evm.taostats.io/address/0x56544AfF15fccea33b4db189cB5B3726DBac724e) | [Sourcify](https://repo.sourcify.dev/964/0x56544AfF15fccea33b4db189cB5B3726DBac724e) |
| Bittensor CCIP adapter (`CcipBittensorAdapter`) | Bittensor EVM (964) | [`0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027`](https://evm.taostats.io/address/0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027) | [Sourcify](https://repo.sourcify.dev/964/0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027) |
| Vault lens (`CascadeVaultLens`, read-only) | Bittensor EVM (964) | [`0xc8b3b74261489ff544cF18335778498cd6f32010`](https://evm.taostats.io/address/0xc8b3b74261489ff544cF18335778498cd6f32010) | [Sourcify](https://repo.sourcify.dev/964/0xc8b3b74261489ff544cF18335778498cd6f32010) |
| Library `CascadeBatchLib` (linked by the vault) | Bittensor EVM (964) | [`0xf8A59A42e8A67C5609714d6bC3fAeDC7F8a799CD`](https://evm.taostats.io/address/0xf8A59A42e8A67C5609714d6bC3fAeDC7F8a799CD) | [Sourcify](https://repo.sourcify.dev/964/0xf8A59A42e8A67C5609714d6bC3fAeDC7F8a799CD) |
| Library `CascadeStakeLib` (linked by the vault) | Bittensor EVM (964) | [`0xE52a9c0ea3DE0D4FF7249a65c8cFbeE78f68E01C`](https://evm.taostats.io/address/0xE52a9c0ea3DE0D4FF7249a65c8cFbeE78f68E01C) | [Sourcify](https://repo.sourcify.dev/964/0xE52a9c0ea3DE0D4FF7249a65c8cFbeE78f68E01C) |
| Library `CascadePayoutLib` (linked by the vault) | Bittensor EVM (964) | [`0xA141426E5DFf1F7C9Cc2019A0bD2AC0BD0809328`](https://evm.taostats.io/address/0xA141426E5DFf1F7C9Cc2019A0bD2AC0BD0809328) | [Sourcify](https://repo.sourcify.dev/964/0xA141426E5DFf1F7C9Cc2019A0bD2AC0BD0809328) |
| Library `CascadeHotkeyLib` (linked by the vault) | Bittensor EVM (964) | [`0xa499190631AeBFa8A2987764fFA4cb3A6B5dd0aa`](https://evm.taostats.io/address/0xa499190631AeBFa8A2987764fFA4cb3A6B5dd0aa) | [Sourcify](https://repo.sourcify.dev/964/0xa499190631AeBFa8A2987764fFA4cb3A6B5dd0aa) |
| Library `CascadePayoutMath` (linked by `CascadePayoutLib`) | Bittensor EVM (964) | [`0xEa16630ba8376bE307CEa231540E5A72295aa3B9`](https://evm.taostats.io/address/0xEa16630ba8376bE307CEa231540E5A72295aa3B9) | [Sourcify](https://repo.sourcify.dev/964/0xEa16630ba8376bE307CEa231540E5A72295aa3B9) |

**Only these addresses are Cascade.** Anything else is not Cascade's product, including the previous
deployment below and Cascade's own old test deployments (`v3-test` and `test-2026-10`), which still
exist on-chain. Don't send money to them. The only site is https://cascadefi.xyz.

Roles:

| Role | Address | What it can do |
|---|---|---|
| Owner | `0x478965abDe80ef000e0f3e60008B43ac46130bFC` | A single hardware-wallet account, the same on both chains. No multisig yet. In v3.2 its changes that loosen a protection wait on-chain, in public: 48 hours for a setting, 7 days for a new bridge or front door, 8 days for a new owner or guardian. Changes that tighten a protection, and a pause, apply at once; so do the swap fee, the deposit fee and the unstake request fee, up to their caps in the code. A Safe multisig as owner is recommended before Cascade takes other people's money. |
| Guardian | `0xf996A598B75ab25B140bC50989C76eBB56B0187F` | Stop only: pause, remove a front door, disable a bridge, cancel most of the owner's waiting changes. It can never move funds. For now it is a second account on the same hardware wallet as the owner, so it is not an independent check yet. |
| Keeper | `0x7070F6A27be2Fe8521146450B5EB65190f5C7c9d` | Times batches, staking, reward claims and USDC deliveries. It cannot take funds. |
| Treasury | `0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6` | Receives Cascade's fees and reward cut. |

The full trust model, what each role and outside party can and cannot do, and the known soft spots
are in [`contracts/README.md`](contracts/README.md).

## The previous deployment (v3-launch)

`v3-launch` was the live deployment from 2026-10-30 until `v3.2-launch` replaced it. It is empty (its
vault holds 0 shares and 0 TAO since the founder's test money left) and is being retired. **Don't
send money to it.** Its addresses, for the record:

| Contract | Chain | Address | Verified source |
|---|---|---|---|
| Front door (`CascadeFrontDoor`) | Base (8453) | [`0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA`](https://basescan.org/address/0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA) | [Sourcify](https://repo.sourcify.dev/8453/0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA) |
| Staker (`CascadeStaker`) | Base (8453) | [`0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E`](https://basescan.org/address/0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E) | [Sourcify](https://repo.sourcify.dev/8453/0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E) |
| TWAP oracle (`CascadeTwapOracle`) | Base (8453) | [`0xcAa85F00b6e470Dd28a31FBa982267B820736eBc`](https://basescan.org/address/0xcAa85F00b6e470Dd28a31FBa982267B820736eBc) | [Sourcify](https://repo.sourcify.dev/8453/0xcAa85F00b6e470Dd28a31FBa982267B820736eBc) |
| Base CCIP adapter (`CcipBaseAdapter`) | Base (8453) | [`0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92`](https://basescan.org/address/0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92) | [Sourcify](https://repo.sourcify.dev/8453/0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92) |
| Vault (`CascadeVault`) | Bittensor EVM (964) | [`0x450cD94401B45c72C09734071fe683F6b74Aea72`](https://evm.taostats.io/address/0x450cD94401B45c72C09734071fe683F6b74Aea72) | [Sourcify](https://repo.sourcify.dev/964/0x450cD94401B45c72C09734071fe683F6b74Aea72), [taostats](https://evm.taostats.io/address/0x450cD94401B45c72C09734071fe683F6b74Aea72?tab=contract) |
| Bittensor CCIP adapter (`CcipBittensorAdapter`) | Bittensor EVM (964) | [`0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1`](https://evm.taostats.io/address/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1) | [Sourcify](https://repo.sourcify.dev/964/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1), [taostats](https://evm.taostats.io/address/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1?tab=contract) |

Its owner, guardian and treasury are the accounts above; its keeper is
`0xBE2a34FE20C3006E759537922C807c228707DC23`. It runs the earlier contracts (v3.1), not
`contracts/src/` as it is now.

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

- The v3.2-launch contracts above (source in `contracts/src/`), including how they use the outside
  contracts they depend on.
- The site, https://cascadefi.xyz (source in `web/`).
- The keeper (`keeper/` and `ops/`) and the monitor (`indexer/`).

Out of scope:

- The previous deployment (`v3-launch`) and the old test deployments (`v3-test`, `test-2026-10`),
  unless the same bug affects v3.2-launch.
- Third-party contracts and services: Chainlink CCIP, ForeverMoney's bridged TAO and `AlphaVault`,
  Uniswap, the Bittensor chain and its precompiles, wallets, RPC providers and Cloudflare. Please
  report bugs in them to their owners; notes on how Cascade's use of them could fail are welcome here.
- Attacks that need the owner's key, or behaviour already listed as a soft spot or trust assumption
  in `contracts/README.md`, unless you show it is worse than written there.
- Denial of service by traffic, spam, social engineering or phishing of the team, and reports from
  automated scanners without a working exploit.
- Research notes, reports, design specs and plans in `docs/`, `reports/` and `research_notes/`.
