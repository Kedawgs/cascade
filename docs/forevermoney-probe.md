# ForeverMoney conversion probe (2026-10-23)

Read-only investigation of whether a third-party contract can turn ForeverMoney's bridged TAO into
native TAO on Bittensor EVM, and back, without ForeverMoney's gateway. Every result below came from
public source, on-chain reads, and `eth_call` simulations against mainnet state. No transaction was
sent.

## Answer

**Yes, both directions, permissionlessly, 1:1 for TAO.** The adapter never needs ForeverMoney's
gateway contracts at all.

| Leg | Call | Who may call | Simulated result |
|---|---|---|---|
| Bridged TAO → native TAO | `AlphaVault.withdrawLiquid(token, wad, minTaoOut)` | anyone holding the token; the vault burns from `msg.sender` without approval | 1e18 in → exactly 1e18 native TAO out (`minTaoOut = 1e18` satisfied) |
| Native TAO → bridged TAO | `AlphaVault.depositLiquid{value}(token, minAlphaRao)` | anyone | 1e17 in → exactly 1e17 token minted; 180,457 gas |

Addresses (chain 964): AlphaVault `0x11837459896D96F821a8D88eC93a3C8D152033D4`; TAO token (netuid 0)
`0xC5b6C1632d34901239396F5E1BDe54B342900256`; LockRelease pool `0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e`
(router `0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8`). Base: token `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67`,
BurnMint pool `0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794` (router `0x881e3A65B4d4a04dD529061dd0071cf975F58bCD`).

Source: https://github.com/ForeverMoney-Ai/bridge-contracts (README: snapshot of the mainnet
deployment published for the Hackerbane audit). Bytecode-vs-source verification: see the end of this
note.

## What the source says (AlphaVault.sol, AlphaToken.sol, SpokeGateway.sol, ExitPayload.sol)

- `withdrawLiquid(address token, uint256 wad, uint256 minTaoOut) external returns (uint256 taoOut)` —
  modifiers `whenNotHalted`, `nonReentrant`, `onlyListed(token)`; no role check. Reverts: `ZeroAmount`,
  `NotWholeRao` (`wad % 1e9 != 0`), `InsufficientBalance(have, want)`, `Insolvent` (more than the
  staked position), `Slippage` (`taoOut < minTaoOut || taoOut == 0`), `NativeTransferFailed` (the
  caller must accept native TAO). It burns `wad` from `msg.sender`, unstakes from their validator
  through the staking precompile, measures the native delta, and pays it with `call`.
- `depositLiquid(address token, uint256 minAlphaRao) external payable` — `whenNotHalted`,
  `whenNotMigrating`, `nonReentrant`, `onlyListed`; `msg.value % 1e9 == 0`; stakes immediately on
  their validator, mints the measured stake increase × 1e9. For TAO (root) that is 1:1.
- `AlphaToken.burn/mint` are `onlyVault` (immutable vault address); plain OpenZeppelin ERC-20 with no
  hooks, fees, pause or blacklist. 18 decimals.
- `ExitPayload` (the data their spoke sends) is a fixed tuple `(bytes32 ss58, address evmFallback,
  bool wantLiquid, uint256 minTaoOut)` with no free-form field and no EVM recipient for liquid TAO —
  so their gateway path cannot carry Cascade's batch message. Not needed.
- `SpokeGateway.bridgeToFinney` hard-codes the receiver to their hub. Not needed: the Base pool has
  no sender allowlist (`getAllowListEnabled() == false`), so Cascade's Base adapter calls the CCIP
  router directly with the token plus the `BATCH` data and `receiver = Cascade's Bittensor adapter`.

## Live reads (2026-10-23)

- `isPaused() == false`, `isListed(TAO) == true`.
- Backing: `stakedValueRao(TAO) = 13,008,348,379,878` rao vs token `totalSupply = 13,001.14 TAO` →
  100.055% backed (`Insolvent` cannot trip at these numbers).
- `positionOf(TAO)` = validator hotkey `0x58aef7b1…af40d`, netuid 0 (root).
- Bittensor LockRelease pool holds 13,001.10 tokens (the circulating Base/Robinhood supply's lock).
- Simulating `withdrawLiquid` from a contract that cannot receive native TAO reverted
  `NativeTransferFailed` only — i.e. the burn and unstake succeeded and only the final send failed —
  so Cascade's adapter must have a payable `receive()` for exactly that credit.

## Adapter design this enables (replaces the spec's "Path A / Path C" discussion)

**Inbound (Base → vault), atomic in one CCIP delivery:**
1. Cascade's Base adapter: `asset.approve(router, amount)`; `router.ccipSend(BITTENSOR_SELECTOR,
   {receiver: bittensorAdapter, data: BATCH message, tokenAmounts: [(FM-TAO, amount)], extraArgs:
   gasLimit ≈ 6.5M + ~300k})`. Fee quoted via `router.getFee`.
2. Bittensor adapter `ccipReceive`: verify source chain + sender (the Base adapter); the pool has
   already released `amount` FM-TAO to the adapter; call `AlphaVault.withdrawLiquid(FM_TAO, amount,
   amount)` (exact 1:1 as `minTaoOut`); then `vault.onBridgeMessage{value: amount}(BASE, frontDoor,
   data, amount)`.
   - If ForeverMoney is paused (`IsHalted`) or their vault reverts, the whole delivery reverts and
     CCIP's manual re-execution retries later; money is held, not lost.
   - Keep a small owner-funded native float in the adapter to absorb a sub-rao shortfall if the
     chain ever credits one rao short; otherwise revert.

**Outbound (vault → Base), inside `processPayouts`' `send`:**
1. Bittensor adapter `send{value: net + fee}`: `AlphaVault.depositLiquid{value: net}(FM_TAO, net / 1e9)`
   → mints `net` FM-TAO; `approve(router, net)`; `router.ccipSend{value: fee}(BASE_SELECTOR,
   {receiver: baseAdapter, data: PAYOUTS message, tokenAmounts: [(FM-TAO, net)]})`.
   - `depositLiquid` has `whenNotMigrating`: during a ForeverMoney validator migration the payout leg
     pauses (the vault's `processPayouts` reverts and retries later).
2. Base adapter `ccipReceive`: tokens already minted to it by the BurnMint pool; `transfer` to the
   front door, then `frontDoor.onBridgeMessage(BITTENSOR, vault, data, net)`.

**Trust added by this path:** ForeverMoney's `GUARDIAN_ROLE` pause and `DEFAULT_ADMIN` migration
can stall either leg (already in the README's trust map); their validator choice is where the bridged
TAO is staked while in flight; their 2-of-3 Safe controls the CCIP pools. No ForeverMoney key can
take TAO that is in Cascade's vault.

**Gas:** inbound delivery = withdrawLiquid (~0.2–0.5M, includes one root unstake) + vault delivery
(4.52M measured for 100+100, 2.38M for 50+50). Under the ~7.2M lane budget; confirm on a fork.

## Open items (still worth asking ForeverMoney, now as a courtesy)

- Confirm they are fine with direct integration against `AlphaVault` (they expose an integrator-fee
  path on their gateway; we use none of it).
- Will they verify `AlphaVault`/`AlphaToken` on the explorer? (Our bytecode comparison below stands in
  until then.)
- How integrators hear about pauses, migrations and pool-limit changes.

## Bytecode vs source (2026-10-23)

The audit commit `e80a4432fc0d58f1e7ab94180137aace7f4286d2` (also `origin/main` HEAD) was compiled
with the repo's own settings (solc 0.8.26, evm paris, optimizer 200 runs; `foundry.toml` has no `ffi`
and no hooks) and compared byte-for-byte with the chain:

- **AlphaVault — match.** 19,129 bytes on chain and compiled. Every one of the 120 differing bytes
  sits in the 15 immutable slots (12 hold the staking precompile address `0x…0805`, 3 hold a bytes32
  constant); nothing unexplained. The CBOR metadata is identical and names solc 0.8.26.
- **AlphaToken (TAO) — match.** 2,450 bytes. All 80 differing bytes are the 4 immutable slots holding
  the AlphaVault address. Metadata identical.
- The selectors for `withdrawLiquid`, `depositLiquid`, `isPaused` and `isListed` are present in the
  on-chain vault bytecode.
- Caveats: this proves the runtime code, not constructor values, roles or storage state (those were
  read live above). The branch `origin/audit/hackerbane-fixes` is 3 commits ahead and changes
  `AlphaVault` (+81 lines); those fixes are **not deployed** — integrate against `e80a443`, and
  re-check if they redeploy.
