# Cascade Web Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The website stakes USDC (swapped to TAO on Uniswap, deposited in the live front door) and unstakes back to USDC from the user's own wallet, and every figure on it comes from Base and Bittensor.

**Architecture:** Reads stay behind `CascadeData` (`web/src/lib/cascade/`), now a live implementation over viem public clients (public RPCs, Multicall3, no Base logs). Writes become wallet flows (wagmi core actions) driven by a local operation log that also feeds the activity trails. Pure math, trail derivation and call building are separate modules with unit tests; the mock and the demo go.

**Tech Stack:** Next.js 16 (static export), wagmi 3.7.7 + viem 2.57.7, @tanstack/react-query 5, vitest 5; the `ops/` tool for the config file.

**Spec:** `docs/superpowers/specs/2026-10-25-cascade-web-wiring-design.md` (revised after the builder check).

## Global Constraints

- Every on-screen figure is read from the chain or derived from chain data; a value the chain cannot give is hidden, never filled with a sample. No mock, demo account, `SampleTag` or `DemoBanner` remains in the app.
- No RPC key in the site: Base `https://mainnet.base.org`, Bittensor `https://lite.chain.opentensor.ai`; **no `eth_getLogs` on Base** (the public RPC refuses it); Bittensor logs in windows of at most 1,000 blocks.
- Chain amounts are `bigint` (TAO wei 1e18, csTAO share units 1e24, USDC units 1e6, ETH wei); JS numbers only for display.
- Deposit amounts are whole rao (`% 1e9 == 0`), at least `minDeposit`, within `depositCap − netForwarded − openBatch().totalDeposits`.
- Slippage 0.5% (50 bps) on both swaps. Swap path out: USDC –500→ WETH –3000→ TAO; back: TAO –3000→ WETH –500→ USDC. SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`, QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`.
- Approvals: SwapRouter02 may get `maxUint256` for USDC and TAO; the front door only ever the exact deposit amount.
- `requestRedeem` value = `redeemRequestFee` if `redeemOf(account) == 0`, else 0. Minimum unstake 0.005 TAO; a partial unstake leaves 0 or at least 0.005 TAO.
- Batched path (EIP-5792 `sendCalls`) when the wallet reports atomic support on Base; otherwise sequential, resuming from the operation log. The wallet is switched to Base first.
- Tokens: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH `0x4200000000000000000000000000000000000006`, TAO `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67`; OffRamps Base `0x16E577f1724AE2598F9b43a52C19E6f67eE13808`, Bittensor `0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9`; Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` on both chains.
- Copy follows the existing design (plain sentences, no jargon); commit trailer as in the ops plan.

## Review Focus

1. A wallet that rejects or drops a step halfway through a sequential stake: the flow stops, the record shows which step is waiting, and resuming never repeats a confirmed step (Task 7 tests).
2. A price move between quote and swap beyond 0.5%: the swap reverts in the wallet's simulation, nothing is deposited, and the screen says to try again (Task 7 test on the error mapping).
3. A partial unstake that would strand a sub-floor payout or leave a sub-minimum remainder is refused with "unstake all" offered (Task 2 tests).
4. A second redeem request in the same open batch sends 0 ETH (Task 7 test).
5. The site opened with no `web/.env.local`: every screen says it isn't connected to a deployment, no figure appears (Task 8 test on `readDeployment`).

---

### Task 1: `pnpm ops web-config`

**Files:** Create `ops/src/webconfig.ts`; Modify `ops/src/args.ts`, `ops/src/cli.ts`; Test `ops/test/webconfig.test.ts`.

**Interfaces:** Produces `webEnv(rec: DeploymentRecord): string` — lines `NEXT_PUBLIC_CASCADE_FRONT_DOOR`, `_BASE_ADAPTER`, `_VAULT`, `_BIT_ADAPTER`, `_BIT_BLOCK` (Bittensor adapter's deploy block), `_VAULT_SS58` (`5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu` computed from the vault's coldkey: SS58 prefix 42 encoding added to `ss58.ts` as `encodeSs58(key: Hex): string`), `_HOTKEY_SS58`; refuses a record whose `verify` is not ok. The command writes `web/.env.local`.

- [ ] Test: `webEnv` of a fixture record gives exactly those lines; `encodeSs58(decodeSs58(x)) === x` for the wallet's and Alice's addresses; an unverified record throws. Run `pnpm test` → FAIL.
- [ ] Implement; wire `web-config [--live]` into args/cli and usage. Run tests → PASS; run `pnpm ops web-config --live` → writes `web/.env.local`.
- [ ] Commit `feat(ops): web-config writes the site's deployment settings`.

### Task 2: Deployment config and exact unit math (web)

**Files:** Create `web/src/lib/cascade/config.ts`, `web/src/lib/cascade/units.ts`; Test `units.test.ts`, `config.test.ts`.

**Interfaces:**
- `readDeployment(env: Record<string, string | undefined>): Deployment | null` (`{ frontDoor, baseAdapter, vault, bitAdapter: Address; bitBlock: bigint; vaultSs58, hotkeySs58: string }`, strict checksummed addresses, else null) and `DEPLOYMENT = readDeployment({...the NEXT_PUBLIC_ values})` (Next inlines each `process.env.NEXT_PUBLIC_*` by name); constants `TOKENS`, `UNISWAP`, `OFFRAMP`, `MULTICALL3`, `RPC`, `SLIPPAGE_BPS = 50n`, `MIN_UNSTAKE_WEI = 5n * 10n ** 15n`, `PATH_BUY`, `PATH_SELL` (`encodePacked` paths).
- `units.ts`: `RAO = 10n ** 9n`; `floorRao(wei)`; `lessSlippage(x, bps = SLIPPAGE_BPS)`; `sharesFor(taoWei, totalAssets, totalSupply)` (floor; `taoWei` when supply is 0); `taoFor(shares, totalAssets, totalSupply)` (floor; 0 when supply 0); `capFree({ depositCap, netForwarded, openTotal })` floored at 0; `checkUnstake(requestWei, availableWei): { ok: true; all: boolean } | { ok: false; reason: string; offerAll: boolean }` (below 0.005 TAO → refuse; leaves 0 < rest < 0.005 TAO → refuse with `offerAll`; above available → refuse); `toDisplay(x: bigint, decimals: number): number`.

- [ ] Tests with exact values: `floorRao(1_234_567_891_234n) === 1_234_000_000_000n`; `lessSlippage(10_000n) === 9_950n`; `sharesFor(10n**16n, 0n, 0n) === 10n**16n`; with `totalAssets 2e16, totalSupply 2e22` 0.01 TAO → 1e22 shares and back; `capFree` floors at 0; `checkUnstake` for 0.004 TAO (refuse), all of 0.0788 (ok, all), 0.077 of 0.0788 (refuse, offerAll: leaves 0.0018), 0.07 of 0.0788 (ok); `readDeployment` null without values, null for a lowercase address, the object for the real values. → FAIL, implement, PASS.
- [ ] Commit `feat(web): deployment config and exact unit math`.

### Task 3: Chain clients and reads

**Files:** Create `web/src/lib/cascade/abi.ts`, `web/src/lib/cascade/chain.ts`, `web/src/lib/cascade/reads.ts`; Test `reads.test.ts`.

**Interfaces:**
- `chain.ts`: `bittensor` viem chain (id 964, Multicall3 above), `createClients(): { base: PublicClient; bittensor: PublicClient }` (http transports with `batch: true`, client `batch: { multicall: true }`, retries with backoff).
- `reads.ts` (each takes the clients and a deployment): `readFrontDoor(c, d, account?)` → `{ depositOf, redeemOf, claimable, openBatchId, openTotal, netForwarded, depositCap, minDeposit, redeemRequestFee, canClose }`; `readVault(c, d, account?)` → `{ shares, totalAssets, totalSupply, rootStakeWei, pendingPayouts, balanceWei, stakeHotkey }`; `readWallet(c, account)` → `{ usdc, eth, tao, usdcAllowance, taoRouterAllowance, taoFrontDoorAllowance }`; `quoteBuy(c, usdcUnits)` → TAO wei; `quoteSell(c, taoWei)` → USDC units; `taoPriceUsd(c)` = `quoteSell(0.01 TAO) × 100` as a display number. Base reads in one multicall per call.
- [ ] Test the pure parts with a fake `PublicClient` (`multicall`/`readContract` stubs): `readFrontDoor` maps the tuple and `openBatch()`; `taoPriceUsd` scales the 0.01-TAO quote by 100 and USDC decimals. → FAIL, implement, PASS. Then one live smoke script (`pnpm tsx`-free: a vitest file skipped unless `LIVE=1`) reading `readVault` and `taoPriceUsd` from mainnet.
- [ ] Commit `feat(web): chain clients and reads`.

### Task 4: Operation log

**Files:** Create `web/src/lib/cascade/oplog.ts`; Test `oplog.test.ts`.

**Interfaces:** `type Operation = DepositOp | WithdrawalOp | ClaimOp` with `id`, `kind`, `createdAt`, `account`, and per kind: deposit `{ usdcIn: bigint; targetTao: bigint; priceUsd: number; hashes: Partial<Record<"approveUsdc" | "swap" | "approveTao" | "deposit" | "batch", Hex>>; batchId?: bigint; mode: "batch" | "sequential" }`; withdrawal `{ shares: bigint; taoEstimate: bigint; hash?: Hex; batchId?: bigint; fee: bigint }`; claim `{ withdrawalId?: string; amount: bigint; keepTao: boolean; hashes: …; usdcOut?: bigint }`. `createOpLog(storage: Pick<Storage, "getItem" | "setItem">, frontDoor: Address)` → `{ list(account), get(account, id), put(op), update(account, id, patch) }`, keyed `cascade.ops.<frontDoor>.<account>` (lowercase), bigint as `{"$bigint": "…"}`; storage failure falls back to memory.
- [ ] Tests: put/get/update round-trip with bigints; two accounts stay apart; a throwing storage still works in memory. → FAIL, implement, PASS. Commit `feat(web): local operation log`.

### Task 5: Trails from the log and the chain

**Files:** Create `web/src/lib/cascade/trail.ts`, `web/src/lib/cascade/facts.ts`; Test `trail.test.ts`, `facts.test.ts`.

**Interfaces:**
- `facts.ts`: `depositFacts(c, d, op)` → `{ swapped: boolean; batchClosed: boolean; delivered?: { at: Date; messageId?: Hex; txHash: Hex; shares?: bigint }; staked?: { at: Date }; waitingForMinimum: boolean; bounced?: boolean }`; `withdrawalFacts(c, d, op)` → `{ batchClosed; redeemed?: { at; taoWei: bigint }; skipped?: "skipped" | "deferred"; payout?: { messageId: Hex; state: 0 | 1 | 2 | 3 }; claimable: bigint; claimed?: { at; hash } }`; `chainDeposits(c, d, account)` (vault `Deposited` for the account on Bittensor). Bittensor scans from `d.bitBlock`, 1,000-block windows; Base only by `eth_call`/receipts.
- `trail.ts` (pure): `depositRecord(op | chainOnly, facts, priceUsd): DepositRecord` and `withdrawalRecord(op, facts, quoteUsdc?): WithdrawalRecord` with step keys `received/swapped/bridged/staked` and `requested/unstaked/returned/paid`, statuses `done/active/pending/failed/action`, `txUrl` (basescan / taostats) where a hash is known.
- [ ] Tests (pure, `trail.test.ts`): a deposit at each stage (only swapped; batch closed; delivered; staked; waiting for the 0.02-TAO minimum; bounced → failed); a withdrawal at each stage (requested; redeemed; payout in flight; payout FAILURE → failed; claimable → `action` and status `ready`; claimed → paid); a chain-only deposit hides USD fields. `facts.test.ts`: log windows never exceed 1,000 blocks and never touch Base `getLogs` (fake client). → FAIL, implement, PASS. Commit `feat(web): activity trails from the log and the chain`.

### Task 6: Live `CascadeData` and the new data contract

**Files:** Modify `web/src/lib/cascade/types.ts`, `index.ts`, `context.tsx`, `hooks.ts`; Create `live.ts`; Delete `mock.ts`, `mock.test.ts`, `src/lib/use-usdc-balance.ts`, `src/lib/usdc-balance.ts` (+ test) once nothing imports them; Test `live.test.ts`.

**Interfaces (types.ts):** `CascadeData` keeps `getProtocolStats`, `getPosition`, `getProof`, `listRewards`, `listDeposits`, `getDeposit`, `listWithdrawals`, `getWithdrawal`, `quoteDeposit(usdcUnits: bigint)`, `quoteWithdrawal(shares: bigint)`; adds `getLimits(account?): Promise<{ minTao: bigint; maxTao: bigint; minUsd: number; maxUsd: number }>` and `getBalances(account): Promise<{ usdc: bigint; eth: bigint; tao: bigint }>`; drops `limits`, `source`, `getUsdcBalance`, `startDeposit`, `startWithdrawal`. `Position` gains `shares`, `availableShares`, `taoWei`, `availableTaoWei` (bigint). `DepositQuote` gains `usdcIn`, `targetTao` (bigint); `WithdrawalQuote` gains `shares`, `taoWei`, `fee` (bigint, the ETH to send). `DepositRecord.amountUsd/feesUsd/taoPriceUsd` optional, `rewardsTao` removed; `WithdrawalRecord.status` adds `"ready"`, gains `claimable: bigint`; `StepStatus` adds `"failed" | "action"`. `createCascadeData()` returns `createLiveCascadeData(DEPLOYMENT)` or, when `DEPLOYMENT` is null, an adapter whose every call rejects with `NotConfiguredError`.
- [ ] Tests (`live.test.ts`, injected fake reads/facts): position values and `available*` subtracting `redeemOf` and in-flight withdrawals; limits from `capFree` and `minDeposit` at a price; stats hide APR and stakers; proof `allStaked` rule; `NotConfiguredError` adapter. → FAIL, implement, PASS; `pnpm typecheck` lists every screen to update (fixed in Tasks 7–8). Commit `feat(web): live data and the new data contract`.

### Task 7: Wallet flows

**Files:** Create `web/src/lib/cascade/flows.ts`, `web/src/lib/cascade/use-flows.ts`; Test `flows.test.ts`.

**Interfaces:**
- Pure builders: `stakeCalls(q: DepositQuote, w: WalletReads, d)` → ordered `{ key: "approveUsdc" | "swap" | "approveTao" | "deposit"; to; abi; functionName; args; value? }[]` (approvals only when short; swap = SwapRouter02 `exactOutput({ path: PATH_SELL reversed for output, recipient: account, amountOut: targetTao, amountInMaximum: usdcIn })`; deposit `deposit(targetTao)`); `unstakeCall(q: WithdrawalQuote, redeemOf: bigint, fee: bigint)` (value rule); `claimCalls(claimable, minUsdc, w, keepTao)`; `cancelCalls(kind, amount)`.
- Runner: `runFlow(wallet: WalletPort, op, calls, log)` where `WalletPort = { switchToBase(); canBatch(): Promise<boolean>; sendBatch(calls): Promise<Hex[]>; send(call): Promise<Hex>; wait(hash): Promise<Receipt> }`; batch mode records the batch id and each receipt; sequential mode skips calls whose hash is already recorded and confirmed, records each hash before waiting, stops on rejection with the op marked "needs you"; the deposit receipt's `DepositRequested` fills `batchId`. `use-flows.ts` binds `WalletPort` to wagmi core (`switchChain`, `getCapabilities` atomic `supported`/`ready`, `sendCalls` + `waitForCallsStatus`, `writeContract`, `waitForTransactionReceipt`) and exposes `useStakeFlow`, `useUnstakeFlow`, `useClaimFlow`, `useCancel`.
- [ ] Tests: approvals omitted when allowances suffice; `exactOutput` args exact; second redeem sends 0 value; first sends the fee; runner sequential resume skips confirmed calls; a rejection leaves earlier hashes and marks the op; batch mode records the batch; a reverted swap maps to "the price moved; nothing was deposited, try again". → FAIL, implement, PASS. Commit `feat(web): wallet flows for stake, unstake, claim and cancel`.

### Task 8: Screens on live data, samples removed

**Files:** Modify `StakeForm.tsx`, `StakeCard.tsx`, `StakeScreen.tsx`, `UnstakeForm.tsx`, `UnstakeScreen.tsx`, `ActivityScreen.tsx`, `ActivityList.tsx`, `Trail.tsx` (+ css for `failed`/`action`), `ReceiptLink.tsx`, `WalletPill.tsx`, `WhereIsMyMoney.tsx`, `RewardsCard.tsx`, `RewardsScreen.tsx`, `StatsCard.tsx`, `landing/Hero.tsx`, `landing/MoneyFlow.tsx`, `landing/StakeSection.tsx`, `lib/account.ts`, `lib/lane.ts` (+ test), `lib/stake-form.ts` (+ test); Delete `SampleTag.*`, `DemoBanner.*`; Create `components/NotConnected.tsx`.

- [ ] `lane.ts` test first: the staked node shows the account's own TAO (`position.taoWei`), not the vault's; transit sums in-progress deposits. `stake-form.ts` tests: validation in USDC against `getLimits` and the wallet's USDC, button labels for "Stake" / "Continue (step 2 of 4)" / "Switch to Base". → FAIL, implement, PASS.
- [ ] Screens: stake form shows the live quote (TAO you'll stake, price, fees = pool fees + gas estimate, time) and, while a flow runs, its step list with resume; unstake form shows available, the minimum rule with "Unstake all", the fee in ETH and the time; activity shows the new statuses, "Claim as USDC" / "keep as TAO" when ready, "Cancel" for open-batch entries, hides absent USD fields; ETH-for-gas warning; `NotConnected` when `DEPLOYMENT` is null; remove demo state (`account.ts` keeps only wallet/none/loading), "See the demo", sample tags, demo banner, the mock's "#" receipt handling; the money-flow animation draws from a live quote or shows no numbers.
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → all pass. Commit `feat(web): screens on live data; samples and demo removed`.

### Task 9: Documentation and a local smoke run

**Files:** Modify `web/README.md`, `docs/runbook-test-run.md` (sections 5–7 use the site), `README.md` (status).

- [ ] Write: how to run the site for the test (`pnpm ops web-config --live`, `pnpm dev`), what each screen reads, the batched and step-by-step paths, the minimum unstake. Run `pnpm dev` and load `/`, `/stake/`, `/unstake/`, `/activity/` in the browser (Claude in Chrome if available, else the user) with no wallet connected: live total staked and TAO price appear, no "sample" anywhere, no console errors.
- [ ] Commit `docs: web wiring and the test-run runbook`.
