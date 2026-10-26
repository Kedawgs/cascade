# Cascade v3 website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the website to v3: stake in one signature through `CascadeStaker`, unstake with automatic USDC delivery, show delivery receipts, and put the TAO price and the price-risk note front and center.

**Architecture:** The data layer (`web/src/lib/cascade`) learns v3 addresses and ABIs, a v3 deposit quote (fees, net swap, a rao-rounded-up minimum), a permit-or-approve stake flow, an unstake that records a delivery preference, and delivery facts read from the front door (claimable, `deliveryOf`) plus `Delivered` logs from a public Base RPC that serves logs. Screens change only where the flow changed.

**Tech Stack:** Next.js (static export), React, wagmi/viem, react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-cascade-v3-design.md` (section "Website"); v3 contracts on branch `v3` (`contracts/src/CascadeStaker.sol`, `CascadeFrontDoor.sol`); plan 1 `docs/superpowers/plans/2026-10-26-cascade-v3-contracts-ops.md`.

## Global Constraints

- No RPC key in the bundle. Base reads: `https://mainnet.base.org` (calls) and `https://base-rpc.publicnode.com` (logs only, ≤ 2,000-block windows; CORS `*`, verified 2026-10-26). Bittensor: `https://archive.chain.opentensor.ai`.
- Amounts that feed a transaction are exact `bigint`s. `minTaoOut` is rounded UP to whole rao (1e9 wei) so the bound applies to what is deposited.
- USDC permit domain: name "USD Coin", version "2", chainId 8453, verifyingContract USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; deadline now + 30 minutes; value = `usdcIn`; spender = the staker.
- A wallet whose address has code (an EIP-7702 smart account, e.g. MetaMask's) uses the approve path: exact `approve(staker, usdcIn)` then `stake`, batched with EIP-5792 when the wallet supports it.
- Stake slippage 0.5% (`SLIPPAGE_BPS`); delivery minimum = today's net sell price per TAO less 2% (`DELIVERY_TOLERANCE_BPS = 200`), valid 7 days; destination `6` (Base, CCTP domain).
- Plain words; USDC-first; TAO price and "Your balance is TAO: its dollar value moves with TAO's price." visible on the Stake page before the first deposit.
- v2 deployments (no staker in the env) keep today's flows unchanged.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`

## Review Focus

1. A permit signature the wallet refuses or USDC rejects (smart account) falls back to approve-and-stake without a dead end. (Task 3)
2. A quote that moved between signing and sending reverts cleanly and the record offers "Stake again at today's price". (Task 3)
3. A payout whose delivery is skipped (price moved, preference expired) shows "Claim as USDC" instead of waiting forever. (Task 5)
4. A delivery receipt shows the USDC actually received from the `Delivered` log, and nothing when the log can't be read (never a guessed amount). (Task 5)
5. A v2 deployment in the env renders exactly as today. (Tasks 1–5)

---

### Task 1: v3 config and ABIs

**Files:** Modify `web/src/lib/cascade/config.ts`, `abi.ts`; Test `config.test.ts`

**Interfaces:**
- Produces: `Deployment` gains optional `staker?: Address; oracle?: Address` (env `NEXT_PUBLIC_CASCADE_STAKER`, `NEXT_PUBLIC_CASCADE_ORACLE`, written out by name like the others); `isV3(d: Deployment): boolean` (both present); `RPC.baseLogs = "https://base-rpc.publicnode.com"`; `DELIVERY_TOLERANCE_BPS = 200`, `DELIVERY_VALIDITY_S = 604_800`, `DESTINATION_BASE = 6`, `USDC_PERMIT = { name: "USD Coin", version: "2" }`; ABIs `STAKER` (`stake`, `stakeWithPermit`, `swapFeeBps`, `depositFeeUsdc`), `FRONT_DOOR` additions (`usdc`, `deliveryOf`, `setDelivery`, `requestRedeemWithDelivery`, `maxDeliverySlippageBps`, event `Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)`), `ERC20` additions (`nonces`), `VAULT` additions (`rewardCutBps`).
- [ ] Tests: `readDeployment` reads staker/oracle when set and `isV3` is true only with both; a v2 env (no staker) still reads and `isV3` is false; ABI fragments encode `stakeWithPermit` and `requestRedeemWithDelivery` with the v3 contract signatures (compare selectors with `cast sig` values written into the test).
- [ ] RED, implement, GREEN; `pnpm --dir web test`, `typecheck`, `lint`; commit `feat(web): v3 config and ABIs`.

### Task 2: v3 deposit and withdrawal quotes

**Files:** Modify `web/src/lib/cascade/live.ts`, `types.ts`, `reads.ts`, `units.ts`; Test `live.test.ts`, `units.test.ts`

**Interfaces:**
- Produces: `DepositQuote` gains `minTaoOut: bigint`, `depositFeeUsdc: bigint`, `swapFeeUsdc: bigint`, `cascadeFeesUsd: number`; `WithdrawalQuote` gains `minUsdcPerTao: bigint`, `deliveryDeadline: number`; `ceilRao(wei: bigint): bigint`.
- v3 `quoteDeposit(usdcIn)`: `depositFee = staker.depositFeeUsdc()`, `swapFee = (usdcIn − depositFee) × swapFeeBps / 10_000`, `rest = usdcIn − depositFee − swapFee`, `expectedTao = quoteBuy(rest)`, `minTaoOut = ceilRao(expectedTao × (10_000 − SLIPPAGE_BPS) / 10_000)`, `targetTao = floorRao(expectedTao)`; fees in USD include the pools' 0.35%.
- v3 `quoteWithdrawal`: as today, plus `minUsdcPerTao = netUsdcFor1Tao × (10_000 − 200) / 10_000` where `netUsdcFor1Tao` = `quoteSell(1e18)` less the staker's swap fee; `deliveryDeadline = now + 604_800`.
- [ ] Tests: with fees 50_000 and 15 bps and a mocked quote, 1_000e6 USDC gives `rest = 998_450_075` and the expected `minTaoOut` rounded up to whole rao (assert `minTaoOut % 1e9 == 0` and `>=` the exact 99.5% value); `ceilRao(1)` is `1e9`; withdrawal `minUsdcPerTao` equals the mocked net price × 0.98; v2 quotes unchanged.
- [ ] RED, implement, GREEN; suite; commit `feat(web): v3 deposit and withdrawal quotes`.

### Task 3: one-signature stake

**Files:** Modify `web/src/lib/cascade/flows.ts`, `use-flows.ts`, `oplog.ts`, `trail.ts`, `facts.ts`; Test `flows.test.ts`, `trail.test.ts`, `facts.test.ts`

**Interfaces:**
- Produces: `stakeV3Calls(q: DepositQuote, w: Balances, d: Deployment, account: Address, permit?: { deadline: bigint; v: number; r: Hex; s: Hex }): FlowCall[]` — with `permit`: one `stakeWithPermit` call; without: `approveUsdc` (exact `usdcIn` to the staker, skipped if the allowance covers it) then `stake`. `Balances` gains `usdcStakerAllowance`. `DepositOp` gains `v?: 3` and hash key `stake`.
- `useFlows.stake` on v3: reads `getCode(account)`; no code → read `nonces(account)`, `signTypedData` the permit (domain from Global Constraints), send `stakeV3Calls(..., permit)`; the user refusing the signature → record "needs you" (no fallback prompt loop); code present, or the permit path's simulation fails → approve path (batched when `canBatch`).
- Trail/facts for a v3 deposit: the `stake` receipt marks swap and deposit done together; `usdcSpent` = USDC transferred from the account in that receipt (fees included); `batchId` from the front door's `DepositRequested` in that receipt.
- [ ] Tests: permit path is one call to `stakeWithPermit` with `beneficiary = account`, `minTaoOut`, route 0, the deadlines; approve path is `[approve(staker, usdcIn), stake]` and drops the approve when the allowance covers it; a v3 op with a mined `stake` hash shows swap and deposit done and the batch from its receipt; a failed (reverted) stake offers "Stake again at today's price" (`restake`).
- [ ] RED, implement, GREEN; suite; commit `feat(web): one-signature stake through CascadeStaker`.

### Task 4: unstake with delivery

**Files:** Modify `web/src/lib/cascade/flows.ts`, `use-flows.ts`, `oplog.ts`; Test `flows.test.ts`

**Interfaces:**
- Produces: `unstakeV3Call(shares: bigint, redeemOf: bigint, fee: bigint, q: WithdrawalQuote, d: Deployment): FlowCall` → `requestRedeemWithDelivery(shares, q.minUsdcPerTao, q.deliveryDeadline, 6)` with `value = redeemOf == 0n ? fee : 0n`; `WithdrawalOp` gains `delivery?: { minUsdcPerTao: bigint; deadline: number }`.
- [ ] Tests: the call's arguments and value (first request pays the fee, a second in the same batch pays 0); the op records the preference.
- [ ] RED, implement, GREEN; suite; commit `feat(web): unstake with automatic USDC delivery`.

### Task 5: delivery facts and receipts

**Files:** Modify `web/src/lib/cascade/facts.ts`, `trail.ts`, `records.ts`, `chain.ts` (a logs client on `RPC.baseLogs`); Test `facts.test.ts`, `trail.test.ts`

**Interfaces:**
- Produces: `WithdrawalFacts.delivered?: { hash: Hex; at: Date; usdcOut: bigint }` read from the front door's `Delivered` logs for the user (topic-filtered, windows ≤ 2,000 blocks from the payout's landing block, through the logs client); `WithdrawalFacts.preference?: { minUsdcPerTao: bigint; deadline: number } | null` from `deliveryOf(user)`.
- Trail (v3): after "Return to Base" is done — delivered → step 4 "USDC delivered" done with `received.usdc` and a receipt link; preference live and claimable > 0 → step 4 active "USDC is being delivered to your wallet automatically"; preference expired or none and claimable > 0 → action "Claim as USDC" (today's manual path).
- [ ] Tests: each of the three states above; the received amount comes only from the log (no log readable → no amount shown, status still correct from `claimable == 0` and no claim op); v2 withdrawals unchanged.
- [ ] RED, implement, GREEN; suite; commit `feat(web): delivery receipts and the automatic-USDC trail`.

### Task 6: Stake and Unstake screens for v3

**Files:** Modify `web/src/components/app/StakeCard.tsx`, `StakeForm.tsx`, `UnstakeForm.tsx`, `ActivityScreen.tsx`, `components/app/StakeCard.module.css`; Test `web/src/lib/stake-form.test.ts` (any new pure helpers)

- [ ] Stake page: a price strip above the form — "TAO $252.40" and "Your balance is TAO: its dollar value moves with TAO's price." Fee rows: "Cascade fees: $0.05 + 0.15%" and "Pool fees: about 0.35%". A break-even line from the round-trip cost and `ROOT_YIELD_PCT = 5.9` (a config constant labelled "tao.bot's 30-day root yield, October 2026", replaced by the vault's measured rate once it has claims): "Covers its fees in about N days at today's yield". The submit button says "Stake $X" and the wallet asks once (permit) or twice (approve + stake).
- [ ] Unstake page: under the button, "USDC arrives in your wallet automatically, at least $Y (today's price less 2%). If the price falls further, you can claim by hand."
- [ ] Activity: the v3 receipt states from Task 5; the manual "Claim as USDC" appears only in the claim state.
- [ ] Run `pnpm --dir web test`, `typecheck`, `lint`, `build`; check the pages at 375 px and desktop in a browser; commit `feat(web): v3 stake and unstake screens`.

### Task 7: Rewards waiting

**Files:** Modify `web/src/lib/cascade/live.ts`, `reads.ts`, `types.ts`, `web/src/components/app/RewardsCard.tsx`; Test `live.test.ts`

**Interfaces:**
- Produces: `Position` gains `pendingRewardsTao?: number` = vault-wide `getUnclaimedRootTaoByHotkey(vaultColdkey, stakeHotkey)` (staking precompile `0x…0805`, wei) × the account's shares ÷ total supply × (1 − `rewardCutBps`/10_000); undefined when the read fails.
- [ ] Tests: the share arithmetic with a 10% cut; a failed read leaves it undefined and the rest of the position intact.
- [ ] Rewards page: "Earned, not yet collected: 0.000123 TAO ($0.03). Cascade collects rewards for everyone, at least monthly, and adds them to your balance."
- [ ] RED, implement, GREEN; suite; commit `feat(web): show rewards waiting to be collected`.

### Task 8: Docs

- [ ] `web/README.md` (v3 flows, the logs RPC), `docs/runbook-test-run.md` (v3: `OPS_DEPLOYMENT=v3-test pnpm ops web-config --live`, then the site's v3 flows); run all suites; commit `docs(web): v3 flows`.
