# Cascade Test Deployment and Hand-Run Keeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small `ops/` tool that dry-runs, deploys, checks and then operates the four Cascade contracts on Base and Bittensor mainnet from the throwaway test wallet, sending every transaction through Foundry so our code never touches the key.

**Architecture:** TypeScript run directly by Node 24 (type stripping, no build step), viem for ABI encoding and decoding over one throttled JSON-RPC choke point, and one send function that checks chain id and nonce, estimates on the node, then shells out to `forge create` / `cast send` with the keystore and password file. Pure logic (plan, budget, read-back comparison, keeper decisions, payout rebuild) is separated from I/O so vitest covers it with fakes; a rehearsal on two local anvil forks is the integration test.

**Tech Stack:** Node 24.11, pnpm 11.23.0, TypeScript 5.9.3, viem 2.57.7, vitest 5.0.5, @types/node 24.19.2 (the web app's exact versions); Foundry 1.7 (`forge`, `cast`, `anvil`) at `C:\Users\danie\.foundry\bin`; Solidity 0.8.24 for the rehearsal stand-ins.

**Spec:** `docs/superpowers/specs/2026-10-24-cascade-test-deployment-design.md` (revised after the builder check). Contracts are on main `f14319c`.

## Global Constraints

- Our code never reads, prints, logs or copies the private key, the keystore contents or the password. The password file and keystore are passed to Foundry by path only (`--keystore <path> --password-file <path>`); `--private-key` never appears anywhere.
- Every transaction is preceded by: `eth_chainId` equals the target's expected id; the wallet's pending nonce equals the planned nonce; a raw `eth_estimateGas` with exactly `{from, to?, data, value?}` (never a gas price) succeeds. Any failure stops before Foundry is called.
- Live sends require the `--live` flag; without it every send refuses unless both RPC URLs are on `127.0.0.1` or `localhost`.
- Gas limit = `ceil(estimate × 1.25)`. Bittensor sends are `--legacy` with `--gas-price` from `eth_gasPrice`; Base sends use Foundry's EIP-1559 defaults.
- Foundry is invoked with `child_process.execFile` (no shell), binaries `forge.exe` / `cast.exe` / `anvil.exe` in `OPS_FOUNDRY_BIN` (default `<home>/.foundry/bin`).
- Defaults: keystore `<home>/.foundry/keystores/9ffde5b1-4193-4175-9eb3-a26f9d027214` (`OPS_KEYSTORE`), password file `<home>/.foundry/cascade-test.pw` (`OPS_PASSWORD_FILE`), wallet `0x770932787DD3bcE64f14E31f4746bCe22E214fFF`. The `sf-mainnet` keystore is never referenced.
- RPCs: Base `https://mainnet.base.org`, Bittensor `https://lite.chain.opentensor.ai` (`OPS_BASE_RPC`, `OPS_BITTENSOR_RPC`). Bittensor requests are spaced at least 600 ms apart; HTTP 429 retries up to 6 times with a 20 s backoff.
- Live addresses and selectors are copied from `contracts/test/fork/ForkBase.sol:58-70`; chain ids 8453 (Base) and 964 (Bittensor) are the contracts' logical ids in every constructor argument, in rehearsal too.
- Test settings (spec table): Base adapter gas 540,000 / 26,450, `minSendAmount` 1e16; Bittensor adapter gas 120,000 / 29,900; `batchInterval` 600; `minDeposit` 1e16; `depositCap` 15e16; `redeemRequestFee` 1e14; hotkey `0x58aef7b1efb44806fe14c6c58d0c1eb634a59fd2513f0ced6f2d10e0569af40d`; `minDirectDeposit` 1e16; `payoutDelay` 3600; adapter reserve 1e12 wei; vault reserve 1.5e12 wei through `0x0000000000000000000000000000000000000800` `transfer(bytes32)`.
- Every address printed names its chain ("Base 0x…", "Bittensor 0x…"): with nonces 0/0 the adapters share one address and the front door and vault share another.
- Output is plain language, one line per action: what, where, estimated or actual cost in TAO or ETH.
- `ops/deployments/` is git-ignored. Live record `ops/deployments/test-2026-10.json`; rehearsal record `ops/deployments/rehearsal.json`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`.

## Review Focus

1. The process dies, or the RPC fails, after a transaction was sent but before the record was written: a re-run must recognise the landed effect and never send that step again (Task 5 test `resume recovers a landed step whose record was lost`).
2. A transaction is not mined within the wait: the tool must stop, print the hash, mark the step pending, and refuse to send anything at that nonce or above until it is mined or dropped (Task 4 test `a receipt timeout stops with the hash`; Task 5 test `a pending step blocks the run`).
3. A command aimed at the wrong network (rehearsal RPC with `--live`, live RPC without it, or an RPC whose chain id is not the target's) must refuse before any estimate (Task 4 tests).
4. A mistyped SS58 or Base address at the sweep must be refused, not sent (Task 11 tests).
5. The keeper loop meets an action whose estimate fails (clock not yet past the delay, AlphaVault paused): no transaction, one plain line saying why, and the loop stops rather than retrying the same thing every minute (Task 10 test `run stops on a failed estimate`).

---

### Task 1: Rehearsal stand-ins for Bittensor's precompiles

**Files:**
- Create: `contracts/test/rehearsal/RehearsalPrecompiles.sol`
- Test: `contracts/test/rehearsal/RehearsalPrecompiles.t.sol`

**Interfaces:**
- Produces: contracts `RehearsalAddressMapping`, `RehearsalStaking`, `RehearsalBalanceTransfer` (and helper `ForceSend`), whose `deployedBytecode` Task 7 installs with `anvil_setCode` at `0x…080C`, `0x…0805` and `0x…0800` on the Bittensor fork. Mapping rule: `addressMapping(a) = bytes32(uint256(uint160(a)))`.

- [ ] **Step 1: Write the failing tests** in `RehearsalPrecompiles.t.sol` (etch the three runtimes at the precompile addresses in `setUp`):
  - `test_mappingPadsTheAddress`: `addressMapping(0x770932787DD3bcE64f14E31f4746bCe22E214fFF) == bytes32(uint256(uint160(that)))`.
  - `test_vaultDeploysOnTheStandIns`: `new CascadeVault(mapping of predicted address, HK, bridge, owner, guardian, 1e16, 8453, fd)` succeeds and `coldkey()` equals the padded address.
  - `test_transferForcesBalanceIntoAVaultThatRefusesPlainTransfers`: a plain `call{value: 1}` to that vault reverts; `RehearsalBalanceTransfer(0x…0800).transfer{value: 1.5e12}(vault.coldkey())` succeeds and the vault's balance rises by exactly 1.5e12.
  - `test_stakingReadsAndRefusesWrites`: `getDefaultMinStake() == 2_000_000`, `getNominatorMinRequiredStake() == 20_000_000`, `getStake(any, any, 0) == 0`, `setRejectStakingHotkeyGrowth(true)` does not revert, `addStake` reverts with `"rehearsal: no staking"`.
- [ ] **Step 2: Run** `forge test --match-path test/rehearsal/RehearsalPrecompiles.t.sol` (in `contracts/`). Expected: compile failure (contracts missing).
- [ ] **Step 3: Implement** the three contracts. `RehearsalBalanceTransfer.transfer(bytes32 dest) external payable` creates `new ForceSend{value: msg.value}(payable(address(uint160(uint256(dest)))))`, whose constructor `selfdestruct`s to the target (Cancun still moves the balance without running the target's code); add the lint-disable comment for `selfdestruct`. `RehearsalStaking` implements the `IStaking` selectors the vault calls (`setRejectStakingHotkeyGrowth`, `getStake`, `getDefaultMinStake`, `getNominatorMinRequiredStake`; writes revert).
- [ ] **Step 4: Run** the same command, then the full `forge test`, `forge fmt --check`, `forge lint src test`. Expected: 4 new tests pass; suite 356 passed, 12 skipped; fmt and lint clean.
- [ ] **Step 5: Commit** `test(rehearsal): stand-ins for Bittensor precompiles on a local fork`.

### Task 2: `ops/` package, configuration and artifact loading

**Files:**
- Create: `ops/package.json`, `ops/tsconfig.json`, `ops/vitest.config.ts`, `ops/.gitignore`, `ops/src/config.ts`, `ops/src/artifacts.ts`
- Test: `ops/test/artifacts.test.ts`, `ops/test/config.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `type ChainName = 'base' | 'bittensor'`; `LIVE` constants (`ROUTER`, `TOKEN`, `OFFRAMP`, `SELECTOR`, `CHAIN_ID` per chain, `ALPHA_VAULT`, `PRECOMPILE.{addressMapping, staking, balanceTransfer}`); `SETTINGS` (every Global Constraints test setting, as `bigint`/`number`); `WALLET`; `interface ChainTarget { name: ChainName; rpcUrl: string; chainId: number; legacy: boolean }`; `targets(env): { live: Record<ChainName, ChainTarget>; rehearsal: Record<ChainName, ChainTarget> }` (rehearsal: Base `http://127.0.0.1:8545` id 31337, Bittensor `http://127.0.0.1:8547` id 31338; `legacy` true only for Bittensor); `paths(env): { keystore; passwordFile; foundryBin; contractsDir; deploymentsDir }`.
  - `artifacts.ts`: `loadArtifact(contractsDir, name) → { abi; bytecode: Hex; deployedBytecode: Hex; immutableRanges: {start: number; length: number}[] }` from `contracts/out/<Name>.sol/<Name>.json` (rehearsal contracts from `RehearsalPrecompiles.sol/<Name>.json`); `maskImmutables(code: Hex, ranges) → Hex` (zeroes each byte range).
- `package.json`: `"type": "module"`, `"packageManager": "pnpm@11.23.0"`, scripts `"ops": "node src/cli.ts"`, `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`; dependencies pinned exactly as the Tech Stack line. `tsconfig.json`: `"module": "nodenext"`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"erasableSyntaxOnly": true`, `"strict": true`. `.gitignore`: `node_modules/`, `deployments/`.

- [ ] **Step 1: Write the failing tests.**
  - `artifacts.test.ts`: `loadArtifact(dir, 'CascadeVault')` has an ABI entry `processPayouts` and non-empty `immutableRanges` (the vault has immutables, e.g. `coldkey`); `maskImmutables('0x11223344', [{start: 1, length: 2}]) === '0x11000044'`; masking keeps the length.
  - `config.test.ts`: `LIVE.base.SELECTOR === 15971525489660198786n`, `LIVE.bittensor.ROUTER` equals `ForkBase.sol`'s `BIT_ROUTER`; `SETTINGS.depositCap === 150000000000000000n`, `SETTINGS.payoutDelay === 3600`; `targets({}).rehearsal.bittensor.chainId === 31338`; `paths({OPS_PASSWORD_FILE: 'x'}).passwordFile === 'x'`; `paths({})` never names `sf-mainnet`.
- [ ] **Step 2: Run** `pnpm install` then `pnpm test` (in `ops/`). Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `config.ts` and `artifacts.ts` (immutable ranges from the artifact's `deployedBytecode.immutableReferences`).
- [ ] **Step 4: Run** `forge build` (in `contracts/`), then `pnpm test` and `pnpm typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(ops): package scaffold, live constants, test settings, artifact loader` (include `ops/pnpm-lock.yaml`).

### Task 3: RPC choke point and the deployment plan

**Files:**
- Create: `ops/src/types.ts`, `ops/src/rpc.ts`, `ops/src/plan.ts`
- Test: `ops/test/rpc.test.ts`, `ops/test/plan.test.ts`

**Interfaces:**
- Consumes: `ChainTarget`, `LIVE`, `SETTINGS`, `WALLET` (Task 2).
- Produces:
  - `rpc.ts`: `interface Rpc { request(chain: ChainName, method: string, params: unknown[]): Promise<unknown> }`; `createRpc(targets: Record<ChainName, ChainTarget>, opts?: { minIntervalMs?: Partial<Record<ChainName, number>>; retries?: number; backoffMs?: number; fetch?: typeof fetch }): Rpc` (Bittensor default 600 ms spacing, 6 retries on HTTP 429 with 20,000 ms backoff); helpers `read(rpc, chain, { address, abi, functionName, args }) → Promise<unknown>` (an `eth_call` at `latest`), `nonceOf(rpc, chain, addr) → Promise<number>` (`eth_getTransactionCount` at `pending`), `balanceOf`, `codeAt`, `chainIdOf`.
  - `types.ts`: `interface CreateRequest { chain: ChainName; nonce: number; label: string; contract: string /* e.g. 'src/CascadeVault.sol:CascadeVault' */; args: unknown[] }`; `interface CallRequest { chain: ChainName; nonce: number; label: string; to: Address; abi: Abi; functionName: string; args: unknown[]; value?: bigint }`; `type StepId = 'baseAdapter' | 'frontDoor' | 'bitAdapter' | 'vault' | 'adapterReserve' | 'vaultReserve' | 'setKeeper' | 'setPayoutDelay'`; `type PlannedStep = { id: StepId } & (({ kind: 'create' } & CreateRequest) | ({ kind: 'call' } & CallRequest))`. The `vaultReserve` step's ABI is the one-item `transfer(bytes32 data) payable`.
  - `plan.ts`: `interface Plan { baseNonce: number; bitNonce: number; addresses: { baseAdapter: Address; frontDoor: Address; bitAdapter: Address; vault: Address }; steps: PlannedStep[] }`; `buildPlan(baseNonce: number, bitNonce: number, vaultColdkey: Hex): Plan`.
  - Step order, nonces and arguments exactly as the spec's deployment table: Base `baseNonce` → `baseAdapter` (`remoteAdapter` = `bitAdapter`), `baseNonce+1` → `frontDoor` (`bridge` = `baseAdapter`, `vaultChain` 964, `vault` = `vault`, owner and guardian `WALLET`); Bittensor `bitNonce` → `bitAdapter` (`remoteAdapter` = `baseAdapter`, `alphaVault` `LIVE.ALPHA_VAULT`), `bitNonce+1` → `vault` (`expectedColdkey` = `vaultColdkey`, bridge `bitAdapter`, initial front door `(8453, frontDoor)`), then `adapterReserve` (`fundReserve`, value 1e12), `vaultReserve` (`PRECOMPILE.balanceTransfer.transfer(vaultColdkey)`, value 1.5e12), `setKeeper(WALLET)`, `setPayoutDelay(3600)` at `bitNonce+2…+5`. Addresses from viem `getContractAddress({ from: WALLET, nonce })`.

- [ ] **Step 1: Write the failing tests.**
  - `plan.test.ts` with `buildPlan(3, 5, coldkey)` (different nonces on purpose): `addresses.baseAdapter` = create address at nonce 3, `frontDoor` at 4, `bitAdapter` at 5, `vault` at 6; the Base adapter's `remoteAdapter` arg is `addresses.bitAdapter`; the front door's `vault` arg is `addresses.vault` and `vaultChain` 964; the Bittensor adapter's `remoteAdapter` is `addresses.baseAdapter`; the vault's last two args are `8453` and `addresses.frontDoor`; step nonces are `[3,4,5,6,7,8,9,10]` with chains `[base, base, bittensor ×6]`; `vaultReserve` has `value === 1500000000000n` and `to === 0x…0800`; every `SETTINGS` value appears in the matching constructor argument.
  - `rpc.test.ts` with a fake `fetch`: two Bittensor requests are at least 600 ms apart (fake timers); a 429 then 200 succeeds after one backoff; seven 429s throw an error naming the chain and method; `nonceOf` asks for `pending`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `rpc.ts` (JSON-RPC over `fetch`, a per-chain promise queue for spacing) and `plan.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): throttled RPC and the nonce-predicted deployment plan`.

### Task 4: The single send path

**Files:**
- Create: `ops/src/send.ts`
- Test: `ops/test/send.test.ts`

**Interfaces:**
- Consumes: `Rpc` helpers, `CreateRequest`, `CallRequest` (Task 3); `paths`, `ChainTarget`, `loadArtifact` (Task 2) for creation data.
- Produces:
  - `interface Runner { run(file: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> }` and `execFileRunner` (real, `child_process.execFile`, no shell).
  - `interface Ctx { live: boolean; targets: Record<ChainName, ChainTarget>; rpc: Rpc; runner: Runner; paths: ReturnType<typeof paths>; log(line: string): void; receiptTimeoutMs: number /* default 300_000 */ }`.
  - `interface Sent { hash: Hex; block: number; gasUsed: bigint; costWei: bigint; address?: Address }`.
  - Keeper actions (Task 10) build a `CallRequest` (Task 3's `types.ts`) with the nonce read fresh.
  - `castArg(value: unknown, param: AbiParameter) → string`: integers in decimal, addresses and bytes as 0x-hex, booleans `true`/`false`, tuples `(a,b,…)`, arrays `[a,b,…]`, recursively; the signature is viem's `toFunctionSignature` of the ABI item.
  - `sendCreate(ctx, req: CreateRequest, predicted: Address) → Promise<Sent>`: `forge create <contract> --rpc-url --keystore --password-file --nonce --gas-limit [--legacy --gas-price] --broadcast --json --constructor-args <castArg each…>` (`--constructor-args` last: it takes the rest of the line) with `cwd` = `contractsDir`; estimate data = `encodeDeployData` of the artifact.
  - `sendCall(ctx, req: CallRequest) → Promise<Sent>`: `cast send <to> <signature> <castArg each…> [--value] --rpc-url --keystore --password-file --nonce --gas-limit [--legacy --gas-price] --json`.
  - `class SendRefused extends Error { reason: 'not-live' | 'chain-id' | 'nonce' | 'estimate' }`, `class ReceiptTimeout extends Error { hash: Hex }`.
- Order inside both: live gate (refuse if `ctx.live` is false and any RPC host is not `127.0.0.1`/`localhost`, or `ctx.live` is true and an RPC host is local) → chain id → nonce → estimate → one log line `"<Chain>: <label> — est. <gas> gas ≈ <cost> <TAO|ETH>"` → Foundry → wait for the receipt (poll `eth_getTransactionReceipt`, up to `receiptTimeoutMs`) → require `status` success; for a create require `contractAddress === predicted` and non-empty code. Gas cost uses `eth_gasPrice` on both chains for the estimate line.

- [ ] **Step 1: Write the failing tests** (fake `Rpc`, fake `Runner` that records calls):
  - `refuses a live RPC without --live` and `refuses a local RPC with --live`: `SendRefused('not-live')`, zero RPC and runner calls.
  - `refuses a wrong chain id`: fake `eth_chainId` returns 1; reason `chain-id`; runner not called.
  - `refuses a nonce that differs from the plan`: reason `nonce`; no estimate requested; runner not called.
  - `refuses when the estimate fails`: reason `estimate`; runner not called.
  - `estimates with no gas price`: the `eth_estimateGas` params object has exactly the keys `from`, `data` (create) or `from`, `to`, `data`, `value` (call).
  - `passes key material by path only`: write a temp file containing the sentinel `NEVER-PRINT-ME` and use it as `passwordFile`; the runner args contain `--password-file <that path>` and `--keystore <path>`, never `--private-key`; no log line and no thrown message contains `NEVER-PRINT-ME`; the source files under `ops/src` never call `readFile`/`readFileSync` on `passwordFile` (grep assertion in the test).
  - `sets the gas limit to 1.25× the estimate, legacy on Bittensor`: estimate 1,000,001 → `--gas-limit 1250002`; Bittensor args include `--legacy` and `--gas-price`; Base args include neither.
  - `a create landing at another address fails` and `a reverted receipt fails`.
  - `castArg formats the Base adapter Config tuple`: the Base adapter's Config from `buildPlan` formats as `(0x881e…,0xf308…,8453,964,2135107236357186872,<bitAdapter>,540000,26450)` (full addresses); a `Payout[]` with one entry formats as `[(0x…,5,7)]`.
  - `a receipt timeout stops with the hash`: receipt never appears → `ReceiptTimeout` carrying the hash Foundry printed.
- [ ] **Step 2: Run** `pnpm test test/send.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `send.ts`. Parse Foundry's `--json` output for the hash (`transactionHash`); on a non-zero exit, throw with Foundry's stderr (never the argument list).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): one send path — live gate, chain id, nonce, node estimate, Foundry signs`.

### Task 5: Deployment record and the resumable deploy

**Files:**
- Create: `ops/src/record.ts`, `ops/src/deploy.ts`
- Test: `ops/test/deploy.test.ts`

**Interfaces:**
- Consumes: `buildPlan`, `Plan`, `PlannedStep` (Task 3); `sendCreate`, `sendCall`, `Ctx`, `ReceiptTimeout` (Task 4).
- Produces:
  - `record.ts`: `interface DeploymentRecord { target: 'live' | 'rehearsal'; wallet: Address; createdAt: string; plan: Plan; done: Partial<Record<StepId, Sent & { recovered?: true }>>; pending?: { step: StepId; hash: Hex }; verify?: VerifyResult; rehearsalClose?: { gasUsed: bigint; fee: bigint } }` (named so it does not shadow TypeScript's `Record`); `loadRecord(path) → DeploymentRecord | null`, `saveRecord(path, rec)` (write to a temp file, then rename), `archiveRecord(path) → string` (renames to `<name>.abandoned-<ISO time>.json`).
  - `deploy.ts`: `deploy(ctx, recordPath, opts: { newPlan: boolean }) → Promise<DeploymentRecord>`; `effectPresent(ctx, plan, step) → Promise<boolean>` (create: code at the planned address; `adapterReserve`: Bittensor adapter balance ≥ 5e11; `vaultReserve`: vault balance ≥ 1e12; `setKeeper`: `keeper() == WALLET`; `setPayoutDelay`: `payoutDelay() == 3600`).
- Behaviour: no record (or `newPlan`, which archives the old one first) → read both nonces, read the vault coldkey from `PRECOMPILE.addressMapping` at the predicted vault address on the target's Bittensor RPC, `buildPlan`, save. Then for each step in order: done → skip; `effectPresent` → record `{recovered: true}` and skip; current nonce ≠ step nonce → stop with "the plan no longer matches the wallet (nonce N, expected M); run deploy --new-plan to start over from the current nonces"; else send, save after every step. A `pending` entry blocks the run until its hash has a receipt (then it is recorded as done if successful, or the run stops if reverted). `ReceiptTimeout` saves `pending` and stops.

- [ ] **Step 1: Write the failing tests** (fake send functions and fake effect reads):
  - `deploys every step in order and saves after each`.
  - `resume skips recorded steps`.
  - `resume recovers a landed step whose record was lost`: effect present, not in `done` → marked `recovered`, no send.
  - `a nonce mismatch stops before sending` with the message above.
  - `--new-plan archives the old record and plans from the current nonces`.
  - `a pending step blocks the run` until its receipt exists.
- [ ] **Step 2: Run** `pnpm test test/deploy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `record.ts` and `deploy.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): resumable deployment with a crash-safe record`.

### Task 6: Read-back check

**Files:**
- Create: `ops/src/verify.ts`
- Test: `ops/test/verify.test.ts`

**Interfaces:**
- Consumes: `DeploymentRecord`, `Plan` (Tasks 3, 5); `read`, `codeAt`, `balanceOf` (Task 3); `loadArtifact`, `maskImmutables` (Task 2).
- Produces: `interface VerifyResult { ok: boolean; failures: string[]; checkedAt: string }`; `verify(ctx, rec: DeploymentRecord) → Promise<VerifyResult>`; pure `compare(expected: Expectation[], actual: Map<string, unknown>) → string[]` where `Expectation = { chain: ChainName; contract: string; field: string; expected: unknown }`.
- Checks, exactly the spec's list: adapters `router`, `token`, `localChainId`, `remoteChainId`, `remoteSelector`, `remoteAdapter`, `gasBase`, `gasPerEntry`, Base `minSendAmount`, Bittensor `alphaVault`; front door `vault`, `vaultChain`, `primaryBridge`, `asset`, `owner`, `guardian`, `batchInterval`, `minDeposit`, `depositCap`, `redeemRequestFee`; vault `coldkey` == live `addressMapping(vault)`, `stakeHotkey`, `primaryBridge`, `owner`, `guardian`, `keeper`, `frontDoorActive(peerId(bitAdapter.remoteChainId(), frontDoor))` true, exactly one `FrontDoorActivated(8453, frontDoor)` log in the vault's creation receipt, `payoutDelay` 3600; Bittensor adapter balance ≥ 5e11 and vault balance ≥ 1e12; each contract's masked runtime code equals its artifact's masked `deployedBytecode`. Each failure reads `"<Chain> <contract>.<field>: expected <x>, found <y>"`.

- [ ] **Step 1: Write the failing tests** for `compare` and the code check: all equal → `[]`; one wrong `remoteAdapter` → exactly one failure naming `Base CcipBaseAdapter.remoteAdapter`; two `FrontDoorActivated` logs → a failure; code differing only inside an immutable range → no failure; code differing outside → failure; adapter balance 4.99e11 → failure, 5e11 → none.
- [ ] **Step 2: Run** `pnpm test test/verify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `verify.ts`; save the result into the record.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): read-back check of every setting and the deployed code`.

### Task 7: Rehearsal on local forks and the budget

**Files:**
- Create: `ops/src/rehearse.ts`, `ops/src/budget.ts`
- Test: `ops/test/budget.test.ts`

**Interfaces:**
- Consumes: `deploy`, `verify`, `Ctx` (Tasks 4–6); stand-in artifacts (Task 1); `nonceOf`, `read` (Task 3). (Task 10 Step 5 later adds a batch-close rehearsal and stores `rehearsalClose` in the record.)
- Produces:
  - `rehearse(env) → Promise<DeploymentRecord>`: start `anvil --fork-url <live Base RPC> --port 8545 --chain-id 31337` and `anvil --fork-url https://archive.chain.opentensor.ai --port 8547 --chain-id 31338 --retries 12 --fork-retry-backoff 20000 --timeout 60000`; wait until both answer; `anvil_setCode` the three stand-ins' `deployedBytecode` at `0x…080C`, `0x…0805`, `0x…0800` on the Bittensor fork; `anvil_setBalance(WALLET, 1e18)` on both; run `deploy` and `verify` with the rehearsal targets and `rehearsal.json`; stop both anvils (also on failure). Nonces on the forks are the live ones, so the rehearsal plan equals the live plan.
  - `budget.ts`: pure `computeBudget(i: BudgetInputs) → Budget` and `gatherBudgetInputs(ctx, rehearsal: DeploymentRecord) → Promise<BudgetInputs>`. `BudgetInputs = { bitCreateGas: { bitAdapter: bigint; vault: bigint }; bitConfigGas: bigint /* Σ rehearsal gasUsed of steps 5–8 */; baseDeployGas: bigint /* Σ rehearsal gasUsed of steps 1–2 */; closeGas: bigint; bitGasPrice: bigint; baseGasPrice: bigint; baseFeeQuote: bigint; taoBalance: bigint; ethBalance: bigint }`.
  - `closeGas` and `baseFeeQuote` are the record's `rehearsalClose.gasUsed` and `.fee` (the `fee` field of the rehearsed `BatchClosed`), or 400,000 gas and 1e15 wei until Task 10 adds that rehearsal; the Bittensor creates are live estimates; the rest come from the rehearsal record and live gas prices and balances.
  - Formula: `taoNeed = ceil1.3((bitCreateGas.bitAdapter + bitCreateGas.vault + bitConfigGas + 2×500_000 + 3_000_000 + 30_000) × bitGasPrice + 1e12 + 1.5e12)`; `ethNeed = ceil1.3((baseDeployGas + 3×closeGas) × baseGasPrice + 3×baseFeeQuote×1.25) + 2e14` (2e14 = L1 data-fee allowance); `taoToSend = max(0, taoNeed − taoBalance)` rounded up to 1e15 (0.001 TAO); `ethToSend = max(0, ethNeed − ethBalance)` rounded up to 1e14. `ceil1.3(x) = ceil(x × 13 / 10)`. Live Bittensor create estimates use the wallet's current nonce: the vault's estimate uses `addressMapping(getContractAddress(WALLET, currentBitNonce))` as `expectedColdkey`.
  - `formatBudget(b) → string[]`: e.g. `"Send 0.071 TAO to the test wallet's Bittensor address 5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2"` and `"Send 0.0021 ETH on Base to 0x770932787DD3bcE64f14E31f4746bCe22E214fFF"`.

- [ ] **Step 1: Write the failing tests** for `computeBudget` on a fixture (bitAdapter 1,835,528; vault 6,038,421; bitConfigGas 300,000; baseDeployGas 5,000,000; closeGas 400,000; bitGasPrice 5e9; baseGasPrice 6e6; baseFeeQuote 6.19e14; taoBalance 7.9995e15; ethBalance 0): assert the exact `taoNeed`, `ethNeed`, `taoToSend`, `ethToSend` computed by hand from the formula, and that `formatBudget` names the SS58 address and the Base address with their chains.
- [ ] **Step 2: Run** `pnpm test test/budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `budget.ts` and `rehearse.ts` (`anvil` via `execFile`-spawned child processes; `anvil_*` methods through `Rpc`).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`, then the real rehearsal `pnpm ops rehearse` (network needed). Expected: unit tests PASS; the rehearsal prints one line per step (8 steps), "Read-back check: all N checks passed", and leaves `deployments/rehearsal.json`. If the Bittensor fork hits HTTP 429, re-run (the record resumes). The rehearsal's transactions are signed for chain ids 31337 and 31338, so they can never be replayed on Base or Bittensor.
- [ ] **Step 5: Commit** `feat(ops): rehearsal on local forks and the top-up budget`.

### Task 8: Pre-flight checks

**Files:**
- Create: `ops/src/preflight.ts`
- Test: `ops/test/preflight.test.ts`

**Interfaces:**
- Consumes: `Rpc`, `read`, `nonceOf`, `balanceOf` (Task 3); `DeploymentRecord`/`Plan` (Tasks 3, 5); `Budget` (Task 7).
- Produces: `preflight(ctx, rec: DeploymentRecord | null, budget?: Budget) → Promise<{ ok: boolean; lines: string[] }>`; pure `checkOffRamps(list: { sourceChainSelector: bigint; offRamp: Address }[], source: bigint, expected: Address, typeAndVersion: string) → string | null` (null = ok: exactly one entry for that source, equal to `expected`, and `typeAndVersion === 'OffRamp 2.0.0'`); pure `checkAlphaVault({ isPaused, migrationReadyAt, migrationFinished }) → string | null`.
- Live checks: each Router's `getOffRamps()` (Base Router for source Bittensor → `BASE_OFFRAMP`; Bittensor Router for source Base → `BIT_OFFRAMP`) and the OffRamp's `typeAndVersion()`; `AlphaVault.isPaused() == false`, `migrationReadyAt() == 0`, `migrationFinished() == false`; both nonces reported, and when a live record exists they must equal its next undone step's nonce on each chain; balances cover the budget if given; then run `bash contracts/script/simulate_inbound.sh` with `REMOTE_ADAPTER` = the plan's Base adapter, `GAS_BASE=120000`, `GAS_PER_ENTRY=29900` and require `SIMULATION OK` in its output.

- [ ] **Step 1: Write the failing tests** for `checkOffRamps` (ok; two entries for the source; wrong address; `OffRamp 1.6.0`) and `checkAlphaVault` (healthy; paused; `migrationReadyAt` 1; finished), each failure a plain sentence.
- [ ] **Step 2: Run** `pnpm test test/preflight.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `preflight.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`, then `pnpm ops preflight` against the live chains. Expected: unit tests PASS; live run prints every check passing including `SIMULATION OK`.
- [ ] **Step 5: Commit** `feat(ops): read-only pre-flight against the live chains`.

### Task 9: Keeper logic (pure)

**Files:**
- Create: `ops/src/keeper/batch.ts`, `ops/src/keeper/payouts.ts`, `ops/src/keeper/due.ts`
- Test: `ops/test/keeper-logic.test.ts`

**Interfaces:**
- Produces:
  - `batch.ts`: `encodeBatch(id: bigint, deposits: Entry[], redeems: Entry[]) → Hex` = `abi.encode(uint8 1, uint64 id, (address,uint256)[] deposits, (address,uint256)[] redeems)` (`CascadeMessages.sol:26-31`); `openBatchId(closedIds: bigint[]) → bigint` = max closed id + 1, or 1.
  - `payouts.ts`: `type PayoutLog = { kind: 'bounced' | 'redeemed'; key: Hex; user: Address; shares: bigint; assets: bigint; blockNumber: bigint; logIndex: number }`; `rebuildPayouts(logs: PayoutLog[], key: Hex) → Payout[]` (that key's bounced entries with shares 0 first, then its redeemed entries, each in (block, logIndex) order); `payoutsHash(list: Payout[]) → Hex` (h = 0x00…00; h = keccak256(abi.encode(bytes32 h, address user, uint256 shares, uint256 assets)) per entry, `CascadeVault.sol:804-817`). The keeper always passes `maxEntries = 100`.
  - `due.ts`: `type State = { now: number; frontDoor: { canClose: boolean; nDeposits: number; nRedeems: number; paused: boolean }; alphaVault: { healthy: boolean }; vault: { paused: boolean; available: bigint; minStakeWei: bigint; batches: { key: Hex; queuedAt: number; cursor: number; count: number }[]; payoutDelay: number } }`; `type Action = { kind: 'payouts'; key: Hex } | { kind: 'stake' } | { kind: 'close' }`; `decideNext(s: State) → { action: Action | null; reason: string }`. Priority: a batch with `cursor < count` and `now ≥ queuedAt + payoutDelay`, vault not paused, AlphaVault healthy → `payouts`; else `available ≥ minStakeWei` and vault not paused → `stake`; else `canClose` with at least one deposit or redeem, front door not paused, AlphaVault healthy → `close`; else `null` with a reason ("nothing due: next payout at 14:32", "batch empty", "AlphaVault is paused — not closing batches").

- [ ] **Step 1: Write the failing tests:**
  - `encodeBatch(1n, [{user: alice, amount: 10n**16n}], [])` equals `encodeAbiParameters` of the same tuple (and decodes back); `openBatchId([]) === 1n`, `openBatchId([1n, 3n, 2n]) === 4n`.
  - `rebuildPayouts` puts a bounced entry logged after a redeemed one first; ignores other keys; `payoutsHash([])` is 32 zero bytes; `payoutsHash` of one entry equals `keccak256(encodeAbiParameters([bytes32,address,uint256,uint256], [zero, user, shares, assets]))`.
  - `decideNext`: payout due beats stake beats close; a payout one second early yields `stake`/`close`/`null` with the time in the reason; AlphaVault unhealthy blocks `payouts` and `close` but not `stake`; an empty closable batch yields `null` "batch empty"; vault paused blocks `payouts` and `stake`.
- [ ] **Step 2: Run** `pnpm test test/keeper-logic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): keeper decisions, batch encoding and payout rebuild`.

### Task 10: Keeper actions, status, track, the run loop and the CLI

**Files:**
- Create: `ops/src/keeper/state.ts`, `ops/src/keeper/actions.ts`, `ops/src/keeper/status.ts`, `ops/src/cli.ts`
- Modify: `ops/src/rehearse.ts` (add the close rehearsal)
- Test: `ops/test/keeper-actions.test.ts`, `ops/test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 3–9.
- Produces:
  - `state.ts`: `readState(ctx, rec) → Promise<State & { detail: StatusDetail }>`: front door `canClose()`, `openDeposits()`, `openRedeems()`, `paused()`; AlphaVault health; vault `paused()`, `pendingPayouts()`, balance, `minStakeRao()`; queued batches from `PayoutBatchQueued` logs since the vault's deploy block, each read with `getPayoutBatch(key)` (dropped when `count == 0`, i.e. deleted); `available = balance − 1e12 − pendingPayouts` floored at 0; logs scanned in windows of 1,000 blocks (Bittensor) and 2,000 (Base) from the record's deploy blocks.
  - `actions.ts` (each action builds a `CallRequest`): `close(ctx, rec)`: value = `max(3 × quote, 1.5e15)` where quote = Base adapter `quoteFee(964, vault, encodeBatch(openBatchId, deposits, redeems), totalDeposits)`; refuses unless `decideNext` would allow `close`. `stake(ctx, rec)`: `stakeIdle()`. `payouts(ctx, rec, key)`: rebuild from `DepositBounced`/`Redeemed` logs, require `payoutsHash(list) === getPayoutBatch(key).payoutsHash` and `list.length === count`, then `processPayouts(key, list, 100)`. `track(ctx, rec, messageId)`: source `Sent` log found → destination OffRamp `getExecutionState(messageId)` polled every 30 s up to 2 hours, printing `UNTOUCHED / IN_PROGRESS / SUCCESS / FAILURE` changes; on FAILURE print the OffRamp's `ExecutionStateChanged` return data. All sends go through `sendCall` with the nonce read fresh (`nonceOf`) as the planned nonce.
  - `status.ts`: `formatStatus(detail) → string[]` (plain lines: open batch entries and total in TAO and when it can close, messages in flight, vault assets and stake, queued payouts and when each is due, claimable on Base for the wallet and any address given, wallet balances).
  - `cli.ts`: commands `preflight`, `rehearse`, `budget`, `deploy [--new-plan]`, `verify`, `status [--user <0x…>]`, `close`, `stake`, `payouts`, `track <messageId>`, `run`, `wind-down`, `sweep --tao-to <ss58> --eth-to <0x…>`; `--live` selects the live targets and record (otherwise rehearsal); unknown command or missing argument prints usage and exits 2. `run`: every 60 s, `readState` → `decideNext` → do the action or print the reason; stop on the first failed estimate or revert with one plain line; Ctrl-C stops cleanly.

- [ ] **Step 1: Write the failing tests** (fakes):
  - `close attaches three times the quote, at least 0.0015 ETH`; `close refuses while AlphaVault is paused` (no send).
  - `payouts refuses a list whose hash does not match` (no send) and sends `processPayouts(key, list, 100)` when it matches.
  - `run stops on a failed estimate`: one action whose `sendCall` throws `SendRefused('estimate')` → loop ends after one plain line, no second attempt.
  - `formatStatus` on a fixture prints the open batch total as "0.0100 TAO" and a due payout time.
  - `cli` parses `deploy --live --new-plan` to `{ cmd: 'deploy', live: true, newPlan: true }`; `sweep` without `--tao-to` exits 2 with usage; `track` without an id exits 2.
- [ ] **Step 2: Run** `pnpm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the four modules and wire `cli.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Add the close rehearsal** to `rehearse.ts` after `verify`: impersonate `LIVE.base.POOL` (`0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794`, from `ForkBase.sol:68`) to transfer 1e16 TAO to anvil's first default account, which approves the front door and calls `deposit(1e16)` (impersonated sends via `cast send --unlocked --from`), `evm_increaseTime 600` + `evm_mine`, then the keeper's `close`, and require one `Sent` log from the Base adapter in its receipt; store `{ gasUsed, fee }` (fee from the receipt's `BatchClosed`) as the record's `rehearsalClose`. Run `pnpm ops rehearse`. Expected: as Task 7 plus "Rehearsed a batch close: message <id> sent".
- [ ] **Step 6: Commit** `feat(ops): hand-run keeper — status, close, stake, payouts, track, run`.

### Task 11: Wind-down and sweep

**Files:**
- Create: `ops/src/ss58.ts`, `ops/src/winddown.ts`
- Test: `ops/test/ss58.test.ts`, `ops/test/winddown.test.ts`

**Interfaces:**
- Consumes: `readState`, `sendCall` (Tasks 4, 10), `PRECOMPILE.balanceTransfer` (Task 2).
- Produces:
  - `ss58.ts`: `decodeSs58(addr: string) → Hex` (32-byte public key; prefix byte must be 42; checksum = first 2 bytes of blake2b-512 over `"SS58PRE" ‖ prefix ‖ key`, Node `crypto.createHash('blake2b512')`); throws a plain error on a bad character, length, prefix or checksum.
  - `winddown.ts`: `windDown(ctx, rec, users: Address[])`: refuses, listing what is outstanding, unless the open batch is empty, no payout batch is queued, and `claimable(user)` is 0 for each given user; then `pause()` and `setCaps(1e16, 0)` on the front door. `sweep(ctx, rec, taoTo: string, ethTo: Address)`: TAO value = balance − gasLimit × gasPrice − 1e12, floored to a multiple of 1e9, sent with `transfer(decodeSs58(taoTo))` to `0x…0800`; ETH value = balance − gasLimit × 2 × baseFee − 2e13, sent with `cast send <ethTo> --value`. Refuses if either value would be ≤ 0, and prints both destination addresses with their chains before sending.

- [ ] **Step 1: Write the failing tests:**
  - `decodeSs58('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY') === '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'` (Alice); the test wallet's `5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2` decodes to the `addressMapping` value recorded in the record fixture; one changed character → checksum error; a prefix-0 (Polkadot) address → prefix error.
  - `windDown refuses while a payout is queued` and lists it; `sweep floors TAO to whole rao`; `sweep refuses a non-checksummed Base address` (viem `isAddress(…, { strict: true })`).
- [ ] **Step 2: Run** `pnpm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `ss58.ts` and `winddown.ts`; wire `wind-down` and `sweep` in `cli.ts` (`wind-down --user <0x…>` repeatable).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): wind-down and sweep of the test wallet`.

### Task 12: Runbook and documentation

**Files:**
- Create: `docs/runbook-test-run.md`
- Modify: `contracts/README.md` (checklist items 11 and 28 point to the runbook and `ops`), `README.md` (one line on `ops/`)

**Interfaces:**
- Consumes: every command from Tasks 7–11 by its exact name.

- [ ] **Step 1: Write `docs/runbook-test-run.md`** in plain language, in this order: before you start (password file, what the test wallet is); pre-flight (`pnpm ops preflight`); fork tests (`FORK=1`, with the anvil cache recipe from `contracts/README.md`); the rehearsal (`pnpm ops rehearse`); the budget and the one top-up (TAO Kraken → Tangem → `5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2`; ETH on Base to `0x7709…4fFF`); the deployment (`pnpm ops deploy --live`, then `pnpm ops verify --live`); the deposits (first 0.01 TAO followed until staked: `status`, `close`, `track`, `stake`; then the rest); the redeem (request on the website, `close`, `track`, wait the hour, `payouts`, `track`, claim on the website); winding down (`wind-down --live --user <the user's address>`, then `sweep --live --tao-to <Tangem SS58> --eth-to <the user's Base wallet>`, then delete the password file with `Remove-Item $env:USERPROFILE\.foundry\cascade-test.pw`; keep the password until the sweep is done); if something stops halfway (resume, `--new-plan`, a pending transaction, a CCIP FAILURE needing `verifierResults` — checklist item 27).
- [ ] **Step 2: Check** every command named in the runbook exists in `cli.ts` usage (`pnpm ops` with no arguments prints usage; compare by hand) and every address matches `config.ts`.
- [ ] **Step 3: Update** the two READMEs.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` (ops), `forge test` (contracts), `pnpm test` (web). Expected: all green; contracts 356 passed, 12 skipped; web 62 passed.
- [ ] **Step 5: Commit** `docs: test-run runbook`.
