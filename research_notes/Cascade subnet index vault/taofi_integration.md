# TaoFi as an integration dependency for a multi-subnet index vault (cascade.fi)

Research date: 2026-10-20. "On-chain" values were read by me through public RPC `eth_call` (Bittensor EVM `lite.chain.opentensor.ai`, chain 964; Base; Arbitrum; Ethereum; Polygon; Unichain) and the taostats Blockscout API on that date. The explorer link given for each address is there so the reader can re-check it; it is not the place I read the value from. "Code" means the public repo `TaoFi-0x/taofi-swap` at HEAD `e51438f` (2026-01-19). Everything under "Inferences" is my reasoning, not a sourced fact.

**Headline finding that changes the premise:** TaoFi no longer operates as an independent protocol. **Astrid Intelligence PLC (AQSE: ASTR) bought it, announced 2026-01-20.** It was renamed "Astrid Bridge" (astrid.taofi.com). Astrid said it will keep swap, LP and USDC bridging and **wind down the "cross-chain subnet" product, which is exactly the Base → alpha staking rail cascade.fi planned to build on.** taofi.com still shows a banner: "support for these products will not be provided after February 28, 2026." The contracts and API still work today, but nobody supports them.

## 1. What exactly is TaoFi's integration surface (contracts, API, multi-subnet, contract-as-owner, fees, validator)?

### Takeaway
The surface has two parts.
- **Off-chain:** a keyless REST API (`taofi-api.web.app`). It returns ready-to-send calldata for **one subnet per call**.
- **On-chain:** a set of contracts:
  - an upgradeable "wrapper" on Base/Arbitrum/BSC (`SwapBridgeAndCallFromMain`). It bridges USDC through a Hyperlane warp route and sends a batch of calls to a per-sender Hyperlane ICA on Bittensor EVM.
  - `SwapAndStake` on Bittensor EVM (USDC→WTAO via Uniswap V3, then stake).
  - `StakingManager`, a **pooled custodian** that holds all stake under one coldkey and mints ERC-20 "AlphaToken" shares per (netuid, hotkey).

Both validator hotkey and integrator fee are free per-call parameters. Several subnets in one Base transaction are possible at the contract level, because the ICA call array is arbitrary, but the API does not do it. A contract (vault) can be the `msg.sender`, and nothing in the code requires an EOA.

### Cited Findings
**Docs and repos**
- TaoFi docs say: "Third-party interfaces that integrate TaoFi's API and/or smart contracts can set their own fee amount and choice of validator." TaoFi's own UI charges 0.1% and stakes to the "Sturdy Validator." — [docs.taofi.com/swap](https://docs.taofi.com/swap.md)
- Flow according to the docs: Base token → USDC → bridge to Bittensor EVM → USDC→TAO in TaoFi's pool → TAO→subnet token "via Bittensor's canonical EVM precompiles." Subnet tokens sit in Hyperlane interchain accounts. — [docs.taofi.com/swap](https://docs.taofi.com/swap.md)
- The GitHub org has 4 repos:
  - `taofi-swap`: last push 2026-01-19, the only active one.
  - `taofi-contracts`: last push 2025-06-08.
  - `workspace-public`.
  - a `DefiLlama-Adapters` fork.
  — [github.com/TaoFi-0x](https://github.com/TaoFi-0x) (via `gh api orgs/TaoFi-0x/repos`)
- Recent commit history:
  - "deploy to arb and bsc" (2025-10-28)
  - "alpha-token-migration" v2 (Oct 2025)
  - "add UnstakeAndSwap contract for solana sell logic" (2025-12-24)
  - "deploy: UniV3PoolFeeClaimer" (2026-01-12 to 2026-01-19, the last commits)
  — [taofi-swap commits](https://github.com/TaoFi-0x/taofi-swap/commits/main)

**Base-side entry: `SwapBridgeAndCallFromMain`** (Base proxy `0xC3697b332688b762bCBA6765A5b16fe5E8D8034F`; Arbitrum/BSC `0xEC7f9AACFBfF786DB3E2Ee6cA32d6115CE60f1e2`)
- `lifiSwapBridgeAndCall(SwapParams, RemoteCallsParams{router, ism, Call[] calls, hookMetadata}, bridgeCost)` takes the token, optionally swaps it through a **whitelisted** LiFi target, then does two things:
  - calls `transferRemote` on the USDC warp route to the sender's ICA address on domain 964;
  - calls `callRemoteWithOverrides(964, router, ism, calls, hookMetadata, salt)` with `salt = bytes32(msg.sender)`.

  The `calls` array is passed through **without** checking the whitelist. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- `remoteCall(RemoteCallsParams)` sends calls without bridging, but only for (target, selector) pairs that the owner has allowlisted in `allowedRemoteCalls`. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- `_bridgeAndCall` reverts if the bridged USDC amount is 0. So the "arbitrary calls" path needs a non-zero USDC transfer. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- On-chain config of the Base wrapper:
  - `bridge()` = `0x26af973a…6a87` (Hyperlane USDC collateral router)
  - `bridgeToken()` = Base USDC
  - `interchainAccountRouter()` = `0xccb08a1a8984c210b97e81fc51c1a5f85939b511`
  - `treasury()` = 0

  — on-chain; [basescan](https://basescan.org/address/0xC3697b332688b762bCBA6765A5b16fe5E8D8034F)

**Bittensor-side: `SwapAndStake`** (`0x1b05ce15c459e257a82cA5eA57C36DD8D148fbAd`)
- `swapAndStake(ExactInputSingleParams, StakeParams{hotkey, netuid, minAlphaToReceive, receiver}, UiFeeParams{receiver, feePercentage})`:
  - does one Uniswap V3 `exactInputSingle`;
  - takes `feePercentage` (bps, **no cap in code**) out of the WTAO output and sends it to `uiFee.receiver`;
  - unwraps the rest and calls `StakingManager.stake`;
  - if `receiver == 0`, the AlphaTokens go to `msg.sender` (the ICA).

  It handles **one subnet per call**. — [SwapAndStake.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapAndStake.sol)
- `unstakeSwapAndBridge(...)` does the reverse in one call: AlphaToken → TAO → USDC → `transferRemote`. `refund(...)` bridges stranded USDC back. — [SwapAndStake.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapAndStake.sol)

**Bittensor-side: `StakingManager`** (proxy `0x1AFC275AB13a60f82B1044f3fbd29dee5360F9C1`)
- `stake(hotkey, netuid, receiver, minAlpha)` (payable) and `unstake(hotkey, netuid, amount, receiver, minTao)`.
- All stake is added through precompile `0x…0805` under the **StakingManager's own coldkey** (`pubKey`). Users get ERC-4626-style **shares**: `sharesToMint = alphaReceived * (totalShares+1)/(alphaBefore+1)`.
- One AlphaToken (beacon proxy, "SN-{netuid}", 9 decimals) is auto-deployed per **(netuid, hotkey)** pair.

  — [StakingManager.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/StakingManager.sol); [README](https://github.com/TaoFi-0x/taofi-swap/blob/main/README.md) ("not 1:1 exchange rate")
- On-chain StakingManager state:
  - `stakingFee` = 0, `unstakingFee` = 0
  - `minTxSize` = 1e17 wei, i.e. **0.1 TAO**. The API docs say "Minimum trade size is 0.01 TAO", so the docs disagree with the chain.
  - coldkey `pubKey` = `0x2de06f59…a901`

  — on-chain; [taostats](https://evm.taostats.io/address/0x1AFC275AB13a60f82B1044f3fbd29dee5360F9C1); [openapi.yaml](https://taofi-doc.web.app/openapi.yaml)

**v2 contracts (Oct 2025)**
- `BeaconProxyFactory` (`0x02F0E183…e531`) deploys `MultiOwnableSmartAccount` beacon proxies.
  - Owners are bytes32 IDs. Any owner can call `executeCall(s)` directly, or sign EIP-712 `executeWithSig` / `batchExecuteWithSig` (namespace 1 = EVM ECDSA).
  - `AlphaTokenMigrator` moves AlphaTokens into such an account.

  — [MultiOwnableSmartAccount.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/v2/MultiOwnableSmartAccount.sol), [BeaconProxyFactory.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/v2/BeaconProxyFactory.sol), [AlphaTokenMigrator.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/v2/AlphaTokenMigrator.sol)

**API** (Swagger at taofi-doc.web.app, server `https://taofi-api.web.app/`)
- Endpoints: `getBuyQuote`/`getBuyCall`, `getSellQuote`/`getSellCall`, `getRefundCall`, `getBalance`, `getNativeTaoQuote`/`getNativeTaoCall`.
- Request fields:
  - `subnetInfo{netuid, hotkey}` (singular)
  - `fromTokenInfo`, `expectedAlphaAmount`, `slippage` (bps)
  - optional `referralInfo{receiver, fee}` ("1% = 100")
- Responses contain `to`, `data` and `hyperlaneFee`.
- The docs tell integrators to:
  - approve `0xC3697b33…034F`;
  - pass `hyperlaneFee` as `msg.value`;
  - simulate with `estimateGas`;
  - use subnets from `taofi.com/api/subnets` with hotkey `0xacf34e30…2339`.

  — [openapi.yaml](https://taofi-doc.web.app/openapi.yaml)
- Undocumented endpoints are referenced in the repo tests: `getBuyCallV2`, `getSellCallV2`, `getTransferCall(V2)`, `getMigrationCall` (takes a `subnetInfos` **array**), `getBuyCallAndTransfer`, `getTaoCall`. — [SwapAndBridgeAndCall.spec.ts](https://github.com/TaoFi-0x/taofi-swap/blob/main/test/bittensor/SwapAndBridgeAndCall.spec.ts)

**Live API test (2026-10-20)** — [taofi-api.web.app](https://taofi-api.web.app/) (live POST, no API key)
- **The API is still live and needs no key.** `getBuyCall` for SN64, $1,000 Base USDC, 2% slippage, referral fee 50 bps returned calldata for the Base wrapper with `hyperlaneFee` = 0.00125 ETH.
- Decoded ICA batch:
  1. `USDC(bt).approve(SwapAndStake, max)`
  2. `SwapAndStake.swapAndStake({USDC→WTAO, fee 3000, amountIn 1000e6, amountOutMinimum 0}, {hotkey 0xacf34e…, netuid 64, minAlpha 34.04 shares, receiver 0}, {referral receiver, 50 bps})`
- Router override = Bittensor ICA router `0x745f3991…616d`. ISM override = 0, i.e. the default ISM.
- hookMetadata sets a destination gas limit of 650,000 and the refund address = sender.
- `getBuyCallV2` adds a third call, `BeaconProxyFactory.createProxy(owners=[sender's Base address, sender's ICA 0x9af6…3b63], salt)`, and sends the AlphaTokens to that new smart account.
- I confirmed `0x9af6…` is the sender's ICA with `getRemoteInterchainAccount(wrapper, router, 0, salt=sender)` on the Base ICA router.

**Hotkeys, fees and owners in the code**
- A different hotkey simply creates or uses a different AlphaToken. `_deployNewAlphaToken(netuid, hotkey)` is permissionless, called inside `stake()`. — [StakingManager.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/StakingManager.sol)
- There is no `tx.origin` or EOA check in the wrapper, `SwapAndStake` or `StakingManager`. The ICA salt is `msg.sender`, so a contract caller gets its own ICA. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- Cantina acknowledged, but did not fix, an informational finding: "Staking Receiver Is Fixed to msg.sender Instead of a Configurable Address". The current code does have a `receiver` field. — [Cantina review](https://cantina.xyz/portfolio/27ce9e78-9024-4575-8f63-772737202781)

### Inferences
**Several subnets in one Base transaction**
- This is feasible at the contract level. Put `approve` plus N × `swapAndStake` (each with its own `amountIn` slice, netuid and hotkey) in one ICA `calls[]`, sent via `lifiSwapBridgeAndCall`.
- You must build the calldata yourself, because the API is single-subnet, and raise the 650k destination gas limit.
- Each `swapAndStake` does its own swap through the same thin pool, so slippage compounds.
- A cheaper batch: swap USDC→WTAO once, `WTAO.withdraw`, then N × `StakingManager.stake{value}` (or direct precompile `addStake`) from the ICA.

**Who controls a position**
- Through TaoFi's flow, positions are not held natively per user. The alpha belongs to the StakingManager coldkey. A user/vault holds only AlphaToken share ERC-20s, whose mint/burn/upgrade powers sit with a single EOA (see section 4).
- An index vault would end up with N AlphaTokens per subnet/hotkey. Their value depends on StakingManager accounting, and they cannot be moved or redelegated natively. A validator change means unstake and restake through the pool.

**Cleaner design for a vault**
- Use Hyperlane directly instead of TaoFi's wrapper:
  - Vault on Base → Hyperlane ICA router `callRemote` (the vault is then the ICA owner itself).
  - Plus USDC warp route `transferRemote` to that ICA.
  - The ICA swaps on TaoFi's Uniswap V3 pool and calls the staking precompile `0x805` `addStake` directly. StakingManager proves that a contract can stake under its own mapped coldkey.
- This keeps only three dependencies: Hyperlane (ICA + warp route), the TaoFi/Astrid Uniswap pool, and Bittensor precompiles. It removes TaoFi's EOA-administered StakingManager and the Safe-upgradeable Base wrapper.

**The V2 smart-account flow is a bad fit for a contract sender.** It adds the sender address itself as an owner on Bittensor EVM, and no one holds a key for that address there.

### Gaps
- I could not confirm the parameters of the "v1" vs "V2" API defaults used by Astrid's UI today. The Astrid UI appears to have dropped subnet buys; the page is titled "Swap | Astrid Bridge".
- I did not find official docs for the undocumented V2 endpoints or for API rate limits or SLAs.
- I did not simulate a multi-subnet ICA batch end-to-end.
- Bittensor EVM gas costs per precompile call were not measured.

## 2. How do Hyperlane interchain accounts work in TaoFi's flow, and could a vault on Base own an ICA and manage a basket?

### Takeaway
- **Who owns the ICAs.** In TaoFi's flow the Hyperlane-level owner of every user ICA is TaoFi's Base wrapper contract, and the user address is only the salt. That wrapper is upgradeable by a 2-of-3 Safe, so in practice TaoFi/Astrid can control every ICA-held position.
- **What the user signs.** An ERC-20 approval plus one Base transaction that pays the `hyperlaneFee` in ETH.
- **How a buy travels.** Two separate Hyperlane messages: the USDC warp transfer and the ICA call batch. If the call batch fails, the relayer retries it, and stranded USDC can be refunded through the API's refund call.
- **Vault option.** A vault contract can own its own ICA by calling the Hyperlane ICA router directly. Hyperlane docs say every sending contract gets a corresponding account.

### Cited Findings
**How Hyperlane ICAs work**
- An ICA is a CREATE2 `OwnableMulticall` derived from `(origin, owner, remoteRouter, remoteISM)`. "The sender owns that ICA on the destination chain, and can direct it to make arbitrary function calls." "For every contract making interchain calls, there is a corresponding account on the destination chain." — [Hyperlane ICA docs](https://docs.hyperlane.xyz/docs/applications/interchain-account)
- ICAs are supported only on EVM chains, and the ISM is part of the address derivation. — [Hyperlane ICA docs](https://docs.hyperlane.xyz/docs/applications/interchain-account)

**How TaoFi uses them**
- TaoFi derives each user's ICA as `getRemoteInterchainAccount(address(this) /*wrapper*/, router, ism, bytes32(msg.sender))` and dispatches with `callRemoteWithOverrides(..., userSpecificSalt)`. The wrapper is the owner; the user is only a salt. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- The USDC transfer (`IBridge.transferRemote`) and the call batch (`callRemoteWithOverrides`) are **two separate dispatches**. — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- The README says the ICA "acts as your personal assistant on Bittensor, while you keep full control of your funds" and "AlphaTokens are held by your ICA, meaning you have complete custody." — [README](https://github.com/TaoFi-0x/taofi-swap/blob/main/README.md)

**Who controls the Base wrapper**
- It is an EIP-1967 proxy. Admin = `0x218289B9E70869Dd30e608Aa111Cf1F045765a4b`, a Gnosis Safe v1.4.1 with **threshold 2 of 3** (owners `0xfd1d…bb3a`, `0x49be…7196`, `0x2532…8154`). `owner()` = `0x2532c3d363306fa6d625e4cbad996bcf534e8154`, an EOA with an EIP-7702 delegation designator (code `0xef0100…63c0c19a…`). — on-chain; [basescan wrapper](https://basescan.org/address/0xC3697b332688b762bCBA6765A5b16fe5E8D8034F), [basescan Safe](https://basescan.org/address/0x218289B9E70869Dd30e608Aa111Cf1F045765a4b)
- On Arbitrum, the wrapper's proxy admin **and** owner are both the single EOA `0x526a9ea036fb26f9d8b88236df49c55ef9756b32`. — on-chain; [arbiscan](https://arbiscan.io/address/0xEC7f9AACFBfF786DB3E2Ee6cA32d6115CE60f1e2)

**What the user signs and what failure looks like**
- The API docs ask for approval of the wrapper, `hyperlaneFee` as transaction value, and `estimateGas` simulation. There is a `getRefundCall` ("refund USDC for failed buy order… Make sure the user has USDC to refund"). — [openapi.yaml](https://taofi-doc.web.app/openapi.yaml)
- Hyperlane relayer: "If the message delivery fails (e.g. due to a lack of liquidity to transfer out of a Hyperlane Warp Route contract), the Relayer retries the delivery with an exponential backoff mechanism until successful." An older v2 doc says retries stop after a maximum count. — [Hyperlane relayer docs](https://docs.hyperlane.xyz/docs/protocol/agents/relayer); [v2 docs](https://v2.hyperlane.xyz/docs/protocol/agents/relayer)

**Audit notes on the ICA path**
- ChainLight found "Incorrect remote interchain account address calculation in _bridgeAndCall()" (Medium, patched) and "Insufficient gas payment for cross-chain transfers may lead to fail" (Medium, patched). — [ChainLight report](https://github.com/chainlight-io/publications/blob/main/audit-reports/%5BChainLight%5D%20TaoFi%20Security%20Audit%20v1.1.pdf)
- Cantina acknowledged, without fixing, "Interchain account router not automatically protected from arbitrary calls" (Low). — [Cantina review](https://cantina.xyz/portfolio/27ce9e78-9024-4575-8f63-772737202781)

**The Hyperlane infrastructure in the path**
- Bittensor ICA router `0x745f3991…616d`: not an EIP-1967 proxy (21 KB code). Its owner `0xb9d2…1819` is a 45-byte EIP-1167 clone, consistent with an Abacus Works-controlled ICA.
- Bittensor Mailbox `0xf767…390a`: its owner `0x4c8d…0abc` is also an ICA clone.
- Base Mailbox owner: Safe `0x890a…3d50` with threshold 6.

  — on-chain; [taostats ICA router](https://evm.taostats.io/address/0x745f399194094562d00c5ee971cd1ef5eb82616d), [basescan mailbox](https://basescan.org/address/0xea87ae93fa0019a82a727bfd3ebd1cfca8f64f1d)
- Hyperlane registry: USDC/subtensor owners were moved on 2026-10-12 to "AW ICA 2.0 accounts". AW = Abacus Works, the Hyperlane core team. — [registry PR #1737](https://github.com/hyperlane-xyz/hyperlane-registry/pull/1737)
- Bankless calls the ICA "essentially a remotely controlled smart wallet on Bittensor EVM" and says users receive native (not wrapped) subnet tokens. Date not shown; c. Aug 2025. — [Bankless](https://www.bankless.com/es/read/bittensor-base-taofi-tokens)

### Inferences
**Custody**
- TaoFi's "complete custody" claim is overstated. Each user ICA answers to the Base wrapper (salt = user). A wrapper upgrade by 2-of-3 Safe signers could dispatch arbitrary calls from any user's ICA. There is no timelock, so in the worst case that drains every ICA-held AlphaToken.
- The wrapper owner (one EIP-7702 EOA) can also cut off `remoteCall` exits by removing allowlist entries. Users could still exit via `lifiSwapBridgeAndCall` with a small USDC amount.

**Ordering failures**
- The two messages are not ordered. If the call batch lands before the USDC, `swapAndStake` uses `min(amountIn, balance)` and will likely revert, so the batch is retried.
- If the batch fails for good (slippage, `minTxSize`), USDC sits in the ICA until a refund or retry.
- For a vault this means accounting for in-flight or stuck states, and keepers that can resubmit.

**A vault owning its own ICA**
- The vault calls the Base ICA router `0xccb08a1a…` directly (`callRemote` / `callRemoteWithOverrides`). It can then pin a custom or stricter ISM, since the ISM is part of the derivation, and hold every position in one account it controls.
- The ICA can hold native stake for many subnets via precompile `addStake`. Rebalancing would be a Base-side keeper or governance action that sends call batches.
- Remaining trust: Abacus Works, as owner of the ICA routers, mailboxes and default ISM (if the default is used).

**Latency.** TaoFi publishes no figure. Messages take at least origin finality, plus validator signing (3-of-5 for Base → Bittensor; see section 3), plus relayer time.

### Gaps
- Measured end-to-end latency for Base → Bittensor ICA delivery: no source found. Neither TaoFi nor Hyperlane publishes a number I could find.
- Whether the current Hyperlane relayer has a max-retry cap for these routes: current vs old docs conflict.
- I could not identify which origin-chain account controls the "AW ICA 2.0" owners, beyond the registry PR's statement that they are AW-controlled.

## 3. What is the USDC on Bittensor EVM, and what are the trust assumptions?

### Takeaway
"USDC" on Bittensor EVM (`0xB833E8137FEDf80de7E908dc6fea43a029142F20`) is a **Hyperlane `EvmHypSynthetic` warp token, not Circle USDC.**
- It is backed by `HypCollateral` routers on Ethereum, Base, Arbitrum, Polygon and Unichain, plus Solana.
- It is administered by **Abacus Works (Hyperlane)**, not TaoFi.
- It relies on Hyperlane's default ISM: a 3-of-5 validator multisig for Base → Bittensor and 3-of-4 for Bittensor → Base.
- It is small: about 139k supply. Base collateral holds only about $7.1k, and an off-chain rebalancer moves collateral between chains.

### Cited Findings
**What the token is**
- TaoFi docs: "Bridging is 1-to-1, with no fees excluding gas. All USDC on Bittensor EVM is fully backed by assets held on the origin chains." Users who bridge at least 100 USDC receive 0.01 TAO for gas; this may be stale. — [docs.taofi.com/bridge](https://docs.taofi.com/bridge.md)
- Hyperlane registry `USDC/subtensor-config.yaml`:
  - Bittensor leg = `EvmHypSynthetic` `0xB833…2F20`.
  - Collateral legs = Arbitrum `0x4337…07BE`, Base `0x26af…6a87`, Ethereum `0x3C43…6A0b`, Polygon `0x52fC…2505`, Unichain `0x155c…33e0` (all `EvmHypCollateral`), and Solana `GPCs…25c` (`SealevelHypCollateral`).

  — [subtensor-config.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/deployments/warp_routes/USDC/subtensor-config.yaml)
- In the Bittensor deploy scripts, both USDC and BRIDGE are `0xB833…2F20`, i.e. token and router are the same contract. — [FullProtocol.deploy.ts](https://github.com/TaoFi-0x/taofi-swap/blob/main/deploy/bittensor/FullProtocol.deploy.ts)

**Who administers it** — [subtensor-deploy.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/deployments/warp_routes/USDC/subtensor-deploy.yaml); [PR #1737](https://github.com/hyperlane-xyz/hyperlane-registry/pull/1737); [PR #1016](https://github.com/hyperlane-xyz/hyperlane-registry/pull/1016)

| Leg | Owner (deploy config) |
|---|---|
| Subtensor | `0xaABB…54AA` |
| Base | `0x6175…62B7` |
| Arbitrum | `0xD275…1A45` |
| Polygon | `0x8708…000D` |
| Ethereum | `0x3965…C5b6` ("AW Safe") |
| Solana | `BNGD…RwJ` |

- `contractVersion` 8.1.1.
- `allowedRebalancers` `0xa394…8FE3`, with CCTP-based `allowedRebalancingBridges`.
- PR #1737 (merged 2026-10-12): "Moves arbitrum, base, polygon, unichain, and subtensor owners to AW ICA 2.0 accounts. ethereum (AW Safe) and solanamainnet are unchanged."
- PR #1016 (2025-07-10) made the route rebalanceable and added Polygon, Arbitrum and Unichain.
- Ethereum AW Safe `0x3965AC3D…C5b6`: threshold **3 of 7**. — on-chain; [etherscan](https://etherscan.io/address/0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6)

**On-chain state of the Bittensor token**
- Upgradeable proxy: implementation `0x7940…0c38`, ProxyAdmin `0x559a…7da0`.
- Both token owner and ProxyAdmin owner = `0xaabb…54aa`, a 45-byte EIP-1167 clone (an ICA).
- `interchainSecurityModule()` = 0 (uses the Mailbox default); `hook()` = 0.
- Mailbox `0xf767…390a`; `domains()` = 8453, 1, Solana (1399811149), 130, 137, 42161.
- **totalSupply = 139,031.45 USDC**, 6 decimals.

  — on-chain; [taostats](https://evm.taostats.io/address/0xB833E8137FEDf80de7E908dc6fea43a029142F20)

**Collateral balances (USDC)** — on-chain; [etherscan](https://etherscan.io/address/0x3C43C421f08e2a48889eA3F75a747b7a7a366A0b), [basescan](https://basescan.org/address/0x26af973a5b256f9b9bc0b1a3c566de1566568a87), [arbiscan](https://arbiscan.io/address/0x4337e529a4f6429668746db798416961c48F07BE), [polygonscan](https://polygonscan.com/address/0x52fCcE3778D4Ea883a1F9F697D3710e470D32505)

| Chain | Collateral |
|---|---|
| Ethereum | 54,487.39 |
| Base | **7,097.68** |
| Arbitrum | 8,182.28 |
| Polygon | 10,944.34 |
| Unichain | 11,974.07 |
| **EVM total** | **92,685.76** |

- Base collateral router: proxy with implementation `0x82fc…6a96` and admin `0x1e38…a056`. `owner()` and the ProxyAdmin owner = `0x6175…62b7` (ICA clone). ISM = default. — on-chain; [basescan](https://basescan.org/address/0x26af973a5b256f9b9bc0b1a3c566de1566568a87)

**Default ISMs** — on-chain; [taostats ISM](https://evm.taostats.io/address/0x5a3123aab5d24495c6691d6d71b33fce0dc23ba1); [basescan ISM](https://basescan.org/address/0x0c53271f445d5f0cd1c7388f04a8c2ec55cf88b9)
- Bittensor Mailbox `defaultIsm` = `0x5a31…3ba1`. It is an Aggregation ISM (2-of-2) of:
  - a NULL-type module `0x7ce3…9151` (owner `0x60cc…5da4`; probably a pausable ISM);
  - a Routing ISM `0xd45a…b51d` (owner `0x4c8d…0abc`). For origin Base (8453) it routes to Aggregation 1-of-2 [MessageId multisig, MerkleRoot multisig], both **3-of-5** validators (`0x34a1…457d`, `0x5450…c2dc`, `0xa596…bf03`, `0xb8cf…6e86`, `0xe957…b773`).
- Base Mailbox `defaultIsm` = `0x0c53…88b9`, same structure. For origin Bittensor (964): **3-of-4** validators.

**Background**
- Hyperlane's May 2025 post says Warp Routes bridge assets between Ethereum, Base and Bittensor EVM. It gives no collateral/ISM detail. — [Hyperlane blog](https://www.hyperlane.xyz/post/hyperlane-unlocks-the-bittensor-ecosystem)

### Inferences
**Backing.** About 46.3k USDC (139.0k − 92.7k) is presumably held by the Solana collateral leg. If so, total backing ≈ supply, but I did not verify Solana. Backing is not checked by any proof on-chain: it rests on the collateral routers, a 3-of-5 validator set, and Abacus Works admin keys.

**Exit liquidity is per chain.** Redeeming to Base can only release what the Base collateral router holds (about $7.1k today). Larger exits wait for the rebalancer, or are retried until collateral arrives (per the Hyperlane relayer docs above). For a vault, large redemptions to Base should be batched or routed through Ethereum, Arbitrum, etc.

**Trust stack for USDC on Bittensor EVM**
- Abacus Works (warp route owner/upgrader via ICA 2.0, plus Ethereum Safe 3/7).
- Abacus Works Mailbox/ISM owners (they can change the default ISM, which this route inherits because `ism = 0`).
- Hyperlane validators (3/5 inbound, 3/4 outbound).
- The rebalancer and CCTP.
- Circle on the collateral chains.
- TaoFi/Astrid is **not** in the USDC trust path. This is good news for a design that bypasses TaoFi contracts.

### Gaps
- Rate limits or caps on the warp route: I checked no rate-limit config. The registry file shows none, and I did not query on-chain rate limits.
- Solana collateral balance: I did not compute the escrow PDA.
- Exact identity of the 5 and 4 validators: addresses only; operator names not looked up.
- What the NULL-type ISM module does exactly: assumed pausable, not verified.

## 4. Contract security: audits, upgradeability, admin keys, bug bounty, incidents

### Takeaway
**Audits.** Two short audits in June–July 2025 (ChainLight 3 days, Cantina 5 days) covered only the v1 wrapper, StakingManager and SwapAndStake, from a **private** repo. They found 6 High and 6 Medium issues in total, all reported fixed.

**Unaudited code.** Everything added later is unaudited by any public report: the v2 smart accounts, SwapAndTransfer, UnstakeAndSwap and the fee claimer.

**Admin keys on Bittensor are a single EOA with no timelock.** That EOA can upgrade StakingManager (which holds all pooled alpha), the AlphaToken beacon, and the smart-account beacon. On Base the wrapper is behind a 2-of-3 Safe.

**Track record.** I found no bug bounty and no TaoFi-specific exploit. The team's earlier protocol, Sturdy V1, was exploited for about $800k in June 2023.

### Cited Findings
**Published audits.** The docs list ChainLight and Spearbit/Cantina. — [docs.taofi.com/audits](https://docs.taofi.com/audits.md)

**ChainLight (Theori)**
- "Beginning on June 9, 2025, ChainLight conducted a 3-day security audit". Report Revision 1.0 is dated August 1, 2025.
- Target: private repo `TaoFi-0x/taofi-private` @ `36481231e6b5…`. Contracts: SwapBridgeAndCallFromMain, TaoSwapAndBridgeToMain, SwapAndStake.
- 9 findings: 2 High, 4 Medium, 2 Low, 1 Info, all "Patched".
- Highs: TAOFI-001 "Arbitrary call in _executeExternalCall enables contract fund theft"; TAOFI-002 "Lack of validation on approvalAddress leads to token drain."

— [ChainLight report PDF](https://github.com/chainlight-io/publications/blob/main/audit-reports/%5BChainLight%5D%20TaoFi%20Security%20Audit%20v1.1.pdf)

**Cantina review**
- Dates 04–08 July 2025, researchers phaze and slowfi, repo `taofi-private`. Contracts: SwapBridgeAndCallFromMain, StakingManager, SwapAndStake.
- 17 findings: 4 High, 2 Medium, 5 Low, 5 Info, 1 Gas. 15 fixed, 2 acknowledged.
- Highs included:
  - arbitrary external calls enabling theft via allowances;
  - "Fungible AlphaTokens enable unauthorized stake removal from arbitrary hotkeys";
  - static AlphaToken amounts losing staking rewards;
  - a TAO/RAO 1e9 unit error.

— [Cantina portfolio](https://cantina.xyz/portfolio/27ce9e78-9024-4575-8f63-772737202781)

**Code added after the audits.** v2 `MultiOwnableSmartAccount`/`BeaconProxyFactory`/`AlphaTokenMigrator` (Oct 2025), `SwapAndTransfer` (Oct 2025), `UnstakeAndSwap` (Dec 2025) and `UniV3PoolFeeClaimer` (Jan 2026). None appears in either audit's scope. — [commit history](https://github.com/TaoFi-0x/taofi-swap/commits/main); audit scopes above

**Bittensor admin keys** (all on-chain; [taostats StakingManager](https://evm.taostats.io/address/0x1AFC275AB13a60f82B1044f3fbd29dee5360F9C1), [ProxyAdmin](https://evm.taostats.io/address/0xA3c92e5cbb6146384Aa5A41540EC3fc6a184139C), [BeaconProxyFactory](https://evm.taostats.io/address/0x02F0E183cE8Ea39A0607F00f494c9000E00fe531), [AlphaTokenFactory](https://evm.taostats.io/address/0xb4F9beBC74DedBc4299ff2c9525497BDBeD35eE1))
- StakingManager is a TransparentUpgradeableProxy (implementation `0xfb6e…b8cc`) whose ProxyAdmin is `0xA3c9…139C`.
- The ProxyAdmin, StakingManager `owner()`, `BeaconProxyFactory` (UpgradeableBeacon for all v2 smart accounts), `AlphaTokenFactory` (UpgradeableBeacon for all AlphaTokens) and sTAO's ProxyAdmin are all owned by **`0x526a9ea036fb26f9d8b88236df49c55ef9756b32`, which has no code, i.e. an EOA**.
- SwapAndStake and UnstakeAndSwap `owner()` = `0x2532…8154`. These two have no `onlyOwner` fund functions in code.

**What those owner powers allow** (from the code; [StakingManager.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/StakingManager.sol), [AlphaToken.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/AlphaToken.sol), [AlphaTokenFactory.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/AlphaTokenFactory.sol), [BeaconProxyFactory.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/v2/BeaconProxyFactory.sol))
- StakingManager owner can call `setStakingPrecompile`, `setAlphaTokenFactory`, `setPubKey`, `setFees`, `setMinTxSize`.
- `claimAccruedFees(receiver)` sends the contract's **entire** native balance. It currently holds 11.89 TAO on-chain while fees are set to 0.
- AlphaToken `mint`/`burn(from, amount)` are `onlyOwner` (= StakingManager).
- Beacon owners can swap the implementation for every AlphaToken and every smart account.

**Pooled stake under StakingManager.** Precompile `getTotalColdkeyStake(StakingManager pubKey)` = 310.54 TAO, about $85k at $274/TAO. I read this as the total of pooled positions. — on-chain; [taostats](https://evm.taostats.io/address/0x1AFC275AB13a60f82B1044f3fbd29dee5360F9C1); TAO price [CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd)

**Base and Arbitrum wrapper admin**
- Base: proxy admin Safe 2-of-3, owner = an EOA with 7702 delegation.
- Arbitrum: admin and owner = the same single EOA `0x526a…6b32`.

— on-chain; [basescan](https://basescan.org/address/0x218289B9E70869Dd30e608Aa111Cf1F045765a4b), [arbiscan](https://arbiscan.io/address/0xEC7f9AACFBfF786DB3E2Ee6cA32d6115CE60f1e2)

**Incidents (team track record)**
- Sturdy Finance (same team) was exploited on 2023-06-12 for about $800k (442 ETH). The root cause was Balancer read-only reentrancy plus a missing check in a deprecated Sturdy function. — [Sturdy post-mortem](https://sturdyfinance.medium.com/exploit-post-mortem-49261493307a); [rekt.news](https://rekt.news/sturdy-rekt); [Decrypt](https://decrypt.co/144188/defi-lending-protocol-sturdy-finance-hit-by-exploit-over-750k-drained?amp=1)

### Inferences
**My own code review found issues** (not audited findings):
1. `StakingManager.setFees` checks the *current* `stakingFee`/`unstakingFee` against `MAX_FEE` instead of the new arguments. Fees above 100% are therefore settable, which makes stake/unstake revert (a DoS, not theft).
2. `SwapAndStake` and `UnstakeAndSwap` take an uncapped, caller-supplied `feePercentage`. That is fine when the user signs it, but it is a footgun if a third party builds calldata for users.
3. The API's buy calldata sets `amountOutMinimum = 0` on the Uniswap leg. It relies only on the final `minAlphaToReceive` (in shares).
4. The docs say yield accrues "via rebasing (i.e., the number of tokens will increase)". The code mints fixed shares whose value grows, so docs and code disagree.

**Single-EOA control.** One EOA can upgrade the custody contract holding all pooled alpha and can sweep its native balance. This is the dominant risk for anything built on StakingManager/AlphaTokens. After the acquisition it is unclear who holds that key (Astrid or former TaoFi devs).

**Audit coverage.** It is thin: about 8 auditor-days total, a private repo, and the commit cannot be matched to the public code. The post-audit v2 smart-account system sits behind an EOA-owned beacon.

### Gaps
- Whether the deployed StakingManager implementation `0xfb6e…` matches the public source: I did not verify bytecode.
- Whether a TaoFi or Astrid bug bounty exists (Immunefi/Cantina): none found. A web search for TaoFi exploit, hack, incident or bug bounty returned nothing TaoFi-specific, so absence is unconfirmed rather than proven.
- Who controls the EOAs `0x526a…6b32` and `0x2532…8154` after the acquisition.

## 5. Current status in 2026: activity, TVL/volume, products, chains, team and funding

### Takeaway
**Ownership and product status**
- TaoFi was **acquired by Astrid Intelligence PLC (announced 2026-01-20)** and rebranded "Astrid Bridge." Swap, the TAO-USDC pool and USDC bridging continue.
- **Cross-chain subnet positions, lending and borrowing are discontinued:** support ended 2026-02-28, the contracts remain on-chain, and the API still answers.

**Activity is minimal**
- DEX TVL is about $31k, down from a $1.15M peak in Nov 2025.
- About 310 TAO is pooled in StakingManager.
- The subnet-staking path has had only a handful of uses since March 2026.
- sTAO (about 40 sTAO supply) and taoUSD (about 2.9k supply) are effectively dormant.

**Team and funding.** TaoFi was built by Sturdy and Subnet 10 contributors. Sturdy raised a $3.9M seed in 2022 according to third-party trackers.

### Cited Findings
**The acquisition**
- taofi.com banner (live 2026-10-20): "TaoFi has been acquired by Astrid. The new user interface can be found at https://astrid.taofi.com/. Users who hold lending, borrowing, or crosschain subnet position should close them immediately. While the contracts will remain onchain indefinitely, support for these products will not be provided after February 28, 2026." — [taofi.com](https://www.taofi.com/)
- Astrid RNS, 2026-01-20:
  - Astrid Intelligence PLC acquired TaoFi, "from Subnet 10", for consideration "paid in TAO tokens from the Company's existing reserves" (a "minor acquisition").
  - It is renamed Astrid Bridge.
  - It **continues** token exchange (TAO on Bittensor EVM), LP to TAO/USDC, and USDC bridging.
  - It **ends** lending/borrowing and cross-chain subnet features ("close these positions within 30 days").
  - "Subnet 10 will no longer form part of the TaoFi platform."
  - No metrics were disclosed.

  — [TradingView/Reuters RNS](https://www.tradingview.com/news/reuters.com,2026-01-20:newsml_RST4690Pa:0-reg-astrid-intelligence-acquisition-of-taofi-infrastructure/); [Research-Tree](https://www.research-tree.com/newsfeed/article/astrid-intelligence-acquisition-of-taofi-infrastructure-3142151); [Dealroom](https://app.dealroom.co/news/feed/astrid-acquires-taofi-to-build-decentralised-ai-infrastructure-revenues-1); [Proactive Investors](https://www.proactiveinvestors.com/companies/news/1085897/astrid-targets-infrastructure-revenues-with-taofi-deal-1085897.html)
- astrid.taofi.com is titled "Swap | Astrid Bridge" ("© 2026 Astrid Bridge"). — [astrid.taofi.com](https://astrid.taofi.com/)

**TVL (DefiLlama, category Dexs, chain Bittensor EVM)** — [DefiLlama API](https://api.llama.fi/protocol/taofi); [defillama.com/protocol/taofi](https://defillama.com/protocol/taofi)

| Date | TVL |
|---|---|
| 2025-11-07 (peak) | $1,149,892 |
| 2025-12-04 | $635k |
| 2026-01-03 | $585k |
| 2026-02-02 | $269k |
| 2026-03-04 | $153k |
| 2026-04-03 | $225k |
| 2026-06-02 | $200k |
| 2026-08-01 | $78k |
| 2026-08-31 | $26.5k |
| 2026-09-30 | $32k |
| **2026-10-20** | **$30,710** |

**On-chain activity (taostats Blockscout API)** — [taostats API](https://evm.taostats.io/api/v2/addresses/0x1b05ce15c459e257a82cA5eA57C36DD8D148fbAd/logs)
- SwapAndStake: last `Stake` event at block 9,249,977 (**2026-10-10**). The one before that was at block 7,748,000 (**2026-03-15**). 5,777 lifetime token transfers.
- StakingManager: last `Unstaked` on 2026-10-07.
- BeaconProxyFactory: only **7** `ProxyCreated` events ever, all between 2025-10-22 and 2025-10-27.
- UnstakeAndSwap: 2 logs ever.
- The TAO/USDC pool is still swapped every few minutes (191,784 lifetime token transfers).

**Product supply on-chain**
- taoUSD (`0x9bB4…724D`) totalSupply = 2,911.
- sTAO (`0xf4E8…2c7D`) totalSupply = 40.07.
- Pooled StakingManager stake = 310.54 TAO.

— on-chain; [taostats taoUSD](https://evm.taostats.io/address/0x9bB4FC27453e04318bf968f2E994B47eDa8F724D), [taostats sTAO](https://evm.taostats.io/address/0xf4E83cBF44415a9e677310950e250E2167842c7D)

**History (2025, possibly stale)**
- Hyperlane post (27 May 2025): phase one = bridge USDC from Ethereum/Base, swap USDC→TAO, LP the pool. "Sturdy SN10 routes swaps on the backend." — [Hyperlane blog](https://www.hyperlane.xyz/post/hyperlane-unlocks-the-bittensor-ecosystem)
- Hyperlane Aug 2025 newsletter: "TaoFi interchain swaps launch… buy any subnet token directly from Base… Powered by Hyperlane Interchain Accounts." — [The Shipping Lane Aug 2025](https://newsletter.hyperlane.xyz/p/the-shipping-lane-august-2025)
- Cryptoast (2025-08-05): TaoFi enabled buying alpha from Base; it cites TaoFi's 2025-08-01 post "Bittensor subnets can now be traded from Base!" — [Cryptoast](https://cryptoast.fr/bittensor-alpha-tokens-subnets-desormais-transferables-base-solana/)
- TaoFi X (2025): products listed as an Ethereum bridge, an overcollateralized stablecoin (taoUSD) and liquid staking (sTAO). — [X @_taofi_](https://x.com/_taofi_/status/1917242421961974063)
- taoUSD background. — [Hyperlane Medium](https://medium.com/hyperlane/accelerating-defi-on-bittensor-with-taousd-93bc723c742d); [Cryptoast taoUSD](https://cryptoast.fr/bittensor-tao-devoile-premier-bridge-ethereum-stablecoin-taousd/)

**Chains** — [deployments](https://github.com/TaoFi-0x/taofi-swap/tree/main/deployments); [commits](https://github.com/TaoFi-0x/taofi-swap/commits/main); [registry](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/deployments/warp_routes/USDC/subtensor-config.yaml)
- Wrapper deployed on Base, Arbitrum and BSC ("deploy to arb and bsc", 2025-10-28).
- Tests cover Ethereum. "Solana sell logic" was added 2025-12-24.
- The USDC route connects Ethereum, Base, Arbitrum, Polygon, Unichain and Solana.

**Team**
- Docs: "TaoFi is build by contributors from the Sturdy protocol and Bittensor Subnet 10." — [docs overview](https://docs.taofi.com/overview.md)
- Contract authors: "Jason (Sturdy) github.com/iris112" and "kitanovicd (TaoFi)". package.json author is "Sturdy". — [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol); [package.json](https://github.com/TaoFi-0x/taofi-swap/blob/main/package.json)

**Funding.** Sturdy's last disclosed round was a seed of about $3.9M in March 2022. Named investors: Y Combinator, Pantera, SoftBank, Orange DAO, Infinite Capital. These are third-party trackers. — [Caplight](https://www.caplight.com/company/sturdy); [VC Backed](https://www.vcbacked.co/company/sturdy-finance)

**Other Bittensor EVM protocols.** DefiLlama also lists LayerZero, CCIP and Steer Protocol on Bittensor EVM. TaoFi is the only "Dexs" entry I saw in the filtered list. — [DefiLlama protocols API](https://api.llama.fi/protocols)

### Inferences
**Status of the rail.** Since 2026-02-28 the planned rail (Base USDC → ICA → SwapAndStake/StakingManager → AlphaTokens) is an **unsupported, deprecated product** of a small UK-listed company. Building a new vault on it now would mean relying on:
- contracts whose admin EOAs may still be live;
- an API that could be shut down at any time;
- no team committed to fixing problems.

**What is still maintained.** Astrid has publicly committed only to swap, LP and bridge. The Uniswap V3 pool and the Hyperlane USDC route (run by Abacus Works) are the pieces most likely to survive.

**Momentum.** The DEX TVL collapse (−97% from peak) and only 7 v2 accounts suggest little organic use of TaoFi's subnet rails even before the wind-down.

### Gaps
- DefiLlama volume series: the `summary/dexs/taofi` endpoint returned non-JSON, so I have no volume numbers.
- Astrid's roadmap for the bridge, whether it will keep the API, and whether any third-party integrators exist: not found.
- Base-side transaction counts for the wrapper: the Base Blockscout API was blocked by Cloudflare.

## 6. Liquidity: TAO-USDC pool on Bittensor EVM (depth, slippage at $1k / $10k / $100k)

### Takeaway
The single TAO/USDC Uniswap V3 pool is **very shallow**: about 6.4k USDC plus 89.3 TAO, around $30.8k TVL. Pool spot price is $273.04 vs CoinGecko $274.17.

Simulated costs, including the 0.3% fee:

| Trade | Result |
|---|---|
| Buy $1k | ≈ 1.1% |
| Buy $10k | ≈ 5.6% |
| Buy $100k | **not executable** (would drain the 89 TAO; the API quotes about 80 TAO, effective price ≈ $1,250/TAO) |
| Sell $1k | ≈ 2.9% |
| Sell $10k | **not executable** (only 6.4k USDC in the pool) |

On top of this, staking TAO into each subnet's own dTAO AMM adds its own slippage.

### Cited Findings
**Pool and its fees**
- TaoFi docs: Uniswap V3 deployed on Bittensor EVM, TAO-USDC pair, "Swaps through this pool have a 0.3% fee, which goes entirely to liquidity providers." — [docs swap](https://docs.taofi.com/swap.md)
- **On-chain this is contradicted:** the pool's `slot0.feeProtocol` = 4/4, so 1/4 of LP fees (0.075% of volume) goes to the protocol. The Uniswap factory `0x20d0…7d59` is owned by `UniV3PoolFeeClaimer` `0x1ea0…c792` (deployed Jan 2026). The claimer's owner is `0x91a1…9b77` and its fee receiver is `0x244e…1324`. — on-chain; [UniV3PoolFeeClaimer.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/UniV3PoolFeeClaimer.sol)

**Pool state (2026-10-20)** — on-chain; [taostats pool](https://evm.taostats.io/address/0x6647dcbeb030dc8e227d8b1a2cb6a49f3c887e3c)
- Address `0x6647dcbeb030dc8e227d8b1a2cb6a49f3c887e3c` (WTAO `0x9Dc0…9F81` / USDC `0xB833…2F20`, fee 3000, tick spacing 60).
- Router `0x667A…6092`.
- Balances: **6,442.65 USDC and 89.314 WTAO**.
- Spot **$273.04/TAO**. Active liquidity L = 2.48e15. 149 initialized ticks.
- No other fee tiers or pools exist for USDC/WTAO on the factory. I checked tiers 100, 500 and 10000, plus the alternate WTAO `0x272b…`.
- TAO price on CoinGecko: $274.17. — [CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd)

**My tick-walking simulation** of the pool (including 0.3% fee), cross-checked against TaoFi's API `getTaoQuote` (identical TAO outputs: 3.6222 and 34.6736 TAO):

| Trade | TAO out / USDC out | Effective price | Cost vs spot |
|---|---|---|---|
| Buy $1,000 | 3.6222 TAO | $276.07 | +1.11% |
| Buy $10,000 | 34.674 TAO | $288.40 | +5.63% |
| Buy $100,000 | API: 80.016 TAO | ≈ $1,250 | drains pool |
| Sell 3.662 TAO (≈ $1k) | 971.41 USDC | — | −2.86% |
| Sell ≈ $10k of TAO | — | — | exceeds the pool's USDC |

— [taofi-api.web.app getTaoQuote](https://taofi-api.web.app/getTaoQuote) (live POST)

**Other API fields**
- The API's own `priceImpact` field reported 27.48% ($1k), 30.58% ($10k) and 83.98% ($100k). Its basis is unexplained, and it does not match the simulation.
- `getBuyQuote` for SN64 at $1k returned `expectedAlphaAmount` 54.75 alpha at `expectedAlphaPrice` 0.0662 TAO.

— [taofi-api getBuyQuote](https://taofi-api.web.app/getBuyQuote) (live POST)

### Inferences
**Practical capacity.** Any vault flow above roughly $2–5k per transaction through this pool takes material slippage, and it is MEV-sandwichable within the `minAlpha` bound. A $100k deposit is impossible in one shot.

**Pool vs TaoFi.** The pool is the real bottleneck, not TaoFi's contracts. A vault would need one of these:
- route TAO acquisition elsewhere, e.g. buy TAO on a CEX or another chain and bridge native TAO to the subnet via the canonical Bittensor bridge;
- spread deposits over time;
- seed liquidity itself.

**Index weighting.** Each subnet's dTAO pool adds extra slippage; top subnets are deeper. Pricing per-subnet slippage needs a separate analysis.

### Gaps
- Depth of alternative TAO venues on Bittensor EVM (e.g. other DEXs, LayerZero/CCIP-bridged TAO): not researched.
- Per-subnet dTAO pool depth for the top subnets: out of scope here.
- Historical pool depth: only DefiLlama's TVL proxy (above).

## 7. Fee structure (integrators, TaoFi's own interface) and referral program

### Takeaway
- **TaoFi's UI.** It charged 0.1% per swap, with 100% going to the referrer if a referral link was used.
- **Integrators.** They set their own fee (`referralInfo.fee` in bps) and receiver per call. The fee is taken in WTAO on Bittensor EVM, and the contract has no cap.
- **Protocol-level fees.** StakingManager fees are 0 on-chain. The bridge charges no fee beyond gas. Hyperlane interchain gas is paid in ETH on Base (≈ 0.00125 ETH per buy today).
- **Pool fee.** 0.3%, of which 0.075% now goes to the protocol.

### Cited Findings
- "All swaps performed through TaoFi's canonical user interface incur a 0.1% fee. Users earn 100% of fees from swaps that use their referral link." — [docs swap](https://docs.taofi.com/swap.md); [taofi.com/referrals](https://www.taofi.com/referrals)
- The API's optional `referralInfo{receiver, fee}` ("referral fee percent, 1% = 100") is available on buy/sell quotes and calls. — [openapi.yaml](https://taofi-doc.web.app/openapi.yaml)
- In the decoded live calldata, `referralInfo` maps to `SwapAndStake` `UiFeeParams{receiver, feePercentage=50}` (50 bps). The fee is deducted from the WTAO output and sent to the receiver. — live API + [SwapAndStake.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapAndStake.sol)
- `StakingManager.stakingFee` = 0 and `unstakingFee` = 0 on-chain. The owner can change them at any time. — on-chain; [StakingManager.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/StakingManager.sol)
- Bridge: "Bridging is 1-to-1, with no fees excluding gas." — [docs bridge](https://docs.taofi.com/bridge.md)
- Live `hyperlaneFee` quoted 1.2526e15 wei (0.00125 ETH) per buy call. — [taofi-api](https://taofi-api.web.app/getBuyQuote)
- Pool fee: 0.3% per the docs; on-chain protocol share 1/4 (see section 6). — [docs swap](https://docs.taofi.com/swap.md)

### Inferences
- In TaoFi's contract flow TaoFi takes **no** on-chain cut from third-party integrator swaps today. Its only revenue on that path would be the pool protocol fee. An integrator could keep 100% of whatever fee it sets.
- Because `feePercentage` is caller-set and uncapped, a vault should hard-code and cap its own fee in its own contracts.

### Gaps
- Referral program mechanics beyond the docs sentence: the referrals page is client-rendered, and I could not extract payout rules (claim process, payout asset/timing). The program's status after the acquisition is unknown.

## 8. Terms of service and licensing restrictions on building on top

### Takeaway
- **License.** The repo has no LICENSE file. Contract headers say **BUSL-1.1**, while package.json says "AGPL-v3". So forking or redeploying the code is legally unclear-to-restricted, while calling the deployed contracts or the public API on-chain needs no code license.
- **ToS.** The terms (TaoFi and Astrid share the same text) are governed by US / New Jersey law and disclaim warranties. I found no clause that explicitly allows or forbids third-party integrations.

### Cited Findings
- Every contract in `taofi-swap/contracts` starts with `// SPDX-License-Identifier: BUSL-1.1`. — [StakingManager.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/StakingManager.sol); [SwapBridgeAndCallFromMain.sol](https://github.com/TaoFi-0x/taofi-swap/blob/main/contracts/SwapBridgeAndCallFromMain.sol)
- `package.json`: `"license": "AGPL-v3"`, `"author": "Sturdy"`. — [package.json](https://github.com/TaoFi-0x/taofi-swap/blob/main/package.json)
- The GitHub API reports no license (`license: null`) for all TaoFi-0x repos. — [github.com/TaoFi-0x](https://github.com/TaoFi-0x) (via `gh api`)
- Terms of service on taofi.com and astrid.taofi.com:
  - "These Terms are governed by the laws of The United States of America and the state of New Jersey";
  - users must "Be legally permitted to use DeFi services in your jurisdiction" and not be sanctioned;
  - "We may suspend or terminate your access for breach, misuse, or legal non-compliance";
  - risk disclosures include "Integration bugs with third-party protocols" and "Smart contract failures or external exploits";
  - no warranties.

  — [taofi.com/terms](https://www.taofi.com/terms); [astrid.taofi.com/terms](https://astrid.taofi.com/terms)
- The docs openly invite third-party interfaces to use the API and contracts with their own fee and validator. — [docs swap](https://docs.taofi.com/swap.md)

### Inferences
- **BUSL-1.1 without a stated Additional Use Grant or Change Date** (no LICENSE file) should be treated as "no production use of the code without permission." This matters only if cascade.fi copies or forks TaoFi contracts. Calling the deployed contracts, or Hyperlane's own permissively licensed contracts directly, avoids the issue.
- The invitation to integrate in the docs predates the Astrid acquisition. There is no fresh written permission, API key or SLA. Relying on the API commercially without contacting Astrid is a business-continuity risk.

### Gaps
- Whether Astrid has issued any new developer or API terms, or plans to keep the API running: not found.
- Legal interpretation of BUSL-1.1 with missing parameters: that needs counsel.
