# Bittensor dTAO and Bittensor EVM Staking Mechanics for an Automated Multi-Subnet Index Vault (as of 2026-10-20)

Source notes. The main primary sources are (a) the current Bittensor docs corpus at bittensor.com/docs. Docs moved there from docs.learnbittensor.org, which now 301-redirects. (b) The subtensor source and release notes, which moved from github.com/opentensor/subtensor to github.com/RaoFoundation/subtensor in mid-2026. The newest mainnet runtime I found is **v481, published 2026-10-19**. The protocol changes very fast: about 30 runtime releases between July and October 2026. Treat any parameter below as "read it live before relying on it." Anything dated before mid-2026 is labelled as older.

---

## 1. Bittensor EVM: chain ID, status, tooling, staking precompiles, contract-held stake, gotchas

### Takeaway
Bittensor EVM is live on mainnet as **chain ID 964** (testnet 945). A contract can hold real subnet stake. The staking-v2 precompile at `0x…0805` dispatches with the **contract's ss58 "mirror"** as coldkey, where mirror = blake2_256("evm:" ++ h160). The interface now covers add, remove, move, transfer and swap stake, limit-price variants, full exits, ERC-20-style stake allowances, views, and root-basket claims. The main traps:
- **Units:** `msg.value` is in wei (1e18), precompile amounts are in rao (1e9), and some views return 18-decimal values.
- **Keys:** hotkeys and coldkeys are passed as `bytes32` public keys.
- **Upgrade risk:** runtime upgrades happen several times a month, and some have broken contract flows.

### Cited Findings
**Network and tooling**
- EVM RPC and chain IDs: mainnet (finney) `https://lite.chain.opentensor.ai`, chain ID **964**; testnet `https://test.chain.opentensor.ai`, chain ID **945**; a fresh localnet boots with chain ID 42. Mainnet is listed on ChainList as 964. — [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)
- Deploy guidance: "compile with **Solidity 0.8.24 or lower** and **EVM target Cancun**." Standard Hardhat and Remix work, and `btcli evm config --format hardhat|metamask` emits configs. — [Bittensor docs: Deploy a contract](https://www.bittensor.com/docs/guides/evm/deploy-a-contract)
- The Python SDK ships `bittensor.evm` with helpers including `h160_to_ss58`, `encode_call`, `get_precompile` and `send_transaction`. `btcli evm` wraps keys, funding, precompile calls and staking. Example contracts are at RaoFoundation/evm-bittensor. — [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm); [Stake from the EVM](https://www.bittensor.com/docs/guides/evm/stake-from-evm)
- Chain block time is 12 s. Public mainnet endpoints are `wss://entrypoint-finney.opentensor.ai:443` and lite/archive nodes. A lite node keeps only about 300 blocks of state, so historical reads need an archive node. — [Bittensor docs: The network](https://www.bittensor.com/docs/concepts/network)

**Precompile address table** (index → address, all "Deployed" per the docs registry)

| Precompile | Address | Notes |
| --- | --- | --- |
| balance-transfer | `0x…0800` | |
| staking V1 | `0x…0801` | "Deprecated — use staking-v2" |
| metagraph | `0x…0802` | |
| subnet | `0x…0803` | |
| neuron | `0x…0804` | |
| **staking-v2** | **`0x…0805`** | |
| uid-lookup | `0x…0806` | |
| storage-query | `0x…0807` | "deprecation planned" |
| **alpha** | **`0x…0808`** | |
| crowdloan | `0x…0809` | |
| leasing | `0x…080a` | |
| proxy | `0x…080b` | |
| address-mapping | `0x…080c` | |
| voting-power | `0x…080d` | |
| balance | `0x…080e` | |
| scheduler | `0x…080f` | |
| drand | `0x…0810` | |
| timestamp | `0x…0811` | |

Ed25519/Sr25519 verify are at `0x402`/`0x403`. — [Bittensor docs: Precompiles](https://www.bittensor.com/docs/guides/evm/precompiles); [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)

- These match the source. `StakingPrecompile::INDEX = 2049` and `StakingPrecompileV2::INDEX = 2053` are in [staking.rs](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/staking.rs). `AlphaPrecompile::INDEX = 2056` is in [alpha.rs](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/alpha.rs). Metagraph 2050, subnet 2051, neuron 2052, uid-lookup 2054, storage-query 2055, proxy 2059, address-mapping 2060 and voting-power 2061 are in their respective .rs files. Solidity constants: `ISTAKING_ADDRESS = 0x…0805` in [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol), `0x…0801` in [staking.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/staking.sol), `IALPHA_ADDRESS = 0x…0808` in [alpha.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/alpha.sol), and `0x…080C` in [addressMapping.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/addressMapping.sol).

**Staking-v2 (`0x…0805`) functions, from stakingV2.sol on main (release-479 merged 2026-10-15)**
- Stake operations:
  - `addStake(bytes32 hotkey, uint256 amount, uint256 netuid) payable`. "amount … in rao."
  - `removeStake(bytes32 hotkey, uint256 amount, uint256 netuid)`. "amount … in alpha."
  - `addStakeLimit(bytes32 hotkey, uint256 amount, uint256 limit_price, bool allow_partial, uint256 netuid)`. "limit_price … Number of rao per alpha."
  - `removeStakeLimit(...)` with the same shape.
  - `removeStakeFull(bytes32 hotkey, uint256 netuid)` and `removeStakeFullLimit(bytes32 hotkey, uint256 netuid, uint256 limitPrice)`.
  - `moveStake(bytes32 origin_hotkey, bytes32 destination_hotkey, uint256 origin_netuid, uint256 destination_netuid, uint256 amount)`.
  - `moveStakeLimit(bytes32, bytes32, uint16, uint16, uint64 alphaAmount, uint64 limitPrice, bool allowPartial)`. Its limit is "Minimum destination-alpha per origin-alpha ratio, scaled by 1e9."
  - `transferStake(bytes32 destination_coldkey, bytes32 hotkey, uint256 origin_netuid, uint256 destination_netuid, uint256 amount)`.
  - `swapStake(bytes32 hotkey, uint16 originNetuid, uint16 destinationNetuid, uint64 alphaAmount)` and `swapStakeLimit(...)`.
  - `unstakeAll(bytes32 hotkey)` and `unstakeAllAlpha(bytes32 hotkey)`.
  - `burnAlpha`, `recycleAlpha` and `addStakeBurn`.
- Views:
  - `getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid)`
  - `getStakeInfoForColdkeyAndNetuid(bytes32 coldkey, uint256 netuid, bytes32[] hotkeys)`
  - `getTotalColdkeyStake`, `getTotalColdkeyStakeOnSubnet`, `getTotalHotkeyStake`, `getTotalAlphaStaked(hotkey, netuid)`
  - `getDefaultMinStake()`, `getNominatorMinRequiredStake()`
  - `getDelegate(bytes32) returns (bool exists, uint16 take)`, `getTakeLimits()`, `getChildKeys` / `getParentKeys`, `getStakingHotkeys`
- Allowances: `approve(spender, netuid, amount)`, `allowance`, `increaseAllowance`, `decreaseAllowance`, `transferStakeFrom(source, dest, hotkey, originNetuid, destNetuid, amount)`.
- Locks: `lockStake`, `moveLock`, `setPerpetualLock`, `setRejectLockedAlpha`, `getColdkeyLock`, `getLockRates`.
- Root claims: `claimRoot(uint16[])`, `claimRootWithHotkey(bytes32)`, `getUnclaimedRootTaoByHotkey`, `getUnclaimedRootTaoBySubnet`.
- Proxies: `addProxy` / `removeProxy`.
- Source: [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- The docs list the same core functions with unit-named parameters (`amount_rao`, `amount_alpha`, `limit_price_rao_per_alpha`). They note "legacy-width functions … are `payable`. `moveStakeLimit` is non-payable and rejects attached value." — [Bittensor docs: Staking V2 precompile](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)
- Function history from the stakingV2.sol commit log:
  - StakingPrecompileV2 added Mar 2025; moveStake/transferStake added Mar 2025.
  - `approve`/`transferStakeFrom` added Feb 2026.
  - Root claim precompile and unclaimed-value getters added Aug 2026.
  - `moveStakeLimit` ("price-protected cross-hotkey stake moves") and the `getStakingHotkeys` getter added Aug 17–18, 2026; released in Runtime 448 on 2026-08-21.
  - Source: [GitHub commits for stakingV2.sol](https://github.com/RaoFoundation/subtensor/commits/main/precompiles/src/solidity/stakingV2.sol); [Release v448](https://github.com/RaoFoundation/subtensor/releases/tag/v448)
- Staking V1 (`0x…0801`, older and deprecated) uses `addStake(bytes32 hotkey, uint256 netuid) payable`, where the amount comes from `msg.value`. — [staking.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/staking.sol)

**Alpha precompile (`0x…0808`), all view**
- Prices: `getAlphaPrice(uint16)` (rao per alpha), `getMovingAlphaPrice(uint16)` (EMA price), `getSumAlphaPrice()`.
- Pool reserves and issuance: `getTaoInPool(uint16)`, `getAlphaInPool(uint16)`, `getAlphaOutPool(uint16)`, `getAlphaIssuance(uint16)`, `getTaoWeight()`.
- Swap simulation: `simSwapTaoForAlpha(uint16, uint64)`, `simSwapAlphaForTao(uint16, uint64)`.
- Emission and volume: `getSubnetVolume`, `getTaoInEmission`, `getAlphaInEmission`, `getAlphaOutEmission`, `getEmissionAccounting(netuid, hotkey)`.
- `getSubnetEconomicState(netuid)` returns `emissionEnabled`, `rootProportion`, …
- `getSubnetFlowState(netuid)` returns `taoFlow`, `taoFlowEma`, `protocolFlow`, …
- `getEmissionGateConfig()` returns `netTaoFlowEnabled`, `emissionGateBar`, …
- `getSwapState(netuid)` returns `feeRate`, `quoteWeight`, reservoirs.
- Source: [alpha.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/alpha.sol); [Bittensor docs: Alpha precompile](https://www.bittensor.com/docs/guides/evm/precompiles/alpha)

**Subnet and metagraph precompiles**
- Subnet precompile (`0x…0803`) exposes `getSubnetEmissionWeights`, `getSubnetDissolutionStatus`, `getNetworkRegistrationBlock`, `getImmunityPeriod`, `getMechanismEmissionSplit`, `getSubnetMetadata` and others. — [subnet.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/subnet.sol)
- Metagraph precompile (`0x…0802`) exposes `getUidCount`, `getStake`, `getRank`, `getTrust`, `getConsensus`, `getIncentive`, `getDividends`, `getEmission`, `getVtrust`, `getValidatorStatus`, `getLastUpdate`, `getIsActive`, `getAxon`, `getHotkey` and `getColdkey`. These are per-(netuid, uid). — [metagraph.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/metagraph.sol)
- Trust and rank are deprecated chain-side: "the metagraph returns empty trust and rank vectors." — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)

**Contract-held stake and address mapping**
- "The precompile dispatches the staking call with the **caller's ss58 mirror** as the coldkey … When a *contract* calls the precompile, the *contract address's* mirror is the coldkey — the position belongs to the contract, and the TAO being staked must sit in the contract's balance." The docs call this "the primitive under liquid-staking tokens." — [Bittensor docs: Stake from the EVM](https://www.bittensor.com/docs/guides/evm/stake-from-evm)
- The mirror is `blake2_256("evm:" ++ h160)`. — [Bittensor docs: fund-evm-key](https://www.bittensor.com/docs/tx/fund-evm-key)
- The on-chain helper `addressMapping(address) returns (bytes32)` uses "HashedAddressMapping with Blake2b hashing." — [addressMapping.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/addressMapping.sol)
- There are two address domains: ss58 (sr25519/ed25519 native accounts) and h160 (secp256k1 EVM accounts). A "truncated mapping" is used for MetaMask deposits into a coldkey. — [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)

**Gotchas from primary sources**
- Decimals: "Native TAO has 9 decimals … The EVM side uses Ethereum's 18 decimals … Contract code forwarding `msg.value` into a precompile must convert to rao: `uint256 amountRao = msg.value / 1e9;` … Precompile amount parameters are in rao." — [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)
- Exception: `getUnclaimedRootTaoByHotkey` returns "Realizable TAO owed … in 18-decimal EVM units." — [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- Keys: "Hotkey/coldkey arguments are **`bytes32` public keys**, not ss58 strings." — [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)
- Limit-price conventions differ by function: `addStakeLimit` takes rao-per-alpha, while `moveStakeLimit` takes a 1e9-scaled alpha/alpha ratio. — [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol); [Stake from the EVM](https://www.bittensor.com/docs/guides/evm/stake-from-evm)
- Minimum stake: operations below `DefaultMinStake`, "default 2,000,000 rao = 0.002 TAO, plus the swap fee on top," fail with `AmountTooLow`. "Unstakes are held to the same floor, both on the amount withdrawn and on any dust position left behind." The existential deposit is 500 rao. — [Bittensor docs: Money](https://www.bittensor.com/docs/concepts/money)
- Truncation: "a position is stored as pool shares and reads back truncated, so the alpha the event reports can be one rao above what the position returns." Use `u64::MAX` as amount ("since spec 469 every debit call … reads it as 'the whole live position'"), or use full-exit calls. — [Bittensor docs: Staking](https://www.bittensor.com/docs/guides/staking)
- Receiver opt-outs: transfers can be refused if the receiving coldkey "opted out of staking-list growth" (`AccountRejectsStakingHotkeyGrowth`). "Contracts can check getRejectStakingHotkeyGrowth before transferring." — [Bittensor docs: policy_violation errors](https://www.bittensor.com/docs/errors/policy-violation)
- Locked alpha: `setRejectLockedAlpha` notes "Rejection is enabled by default." — [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- Call frames: since Aug 2026 the runtime requires "the precompile `code_address` to match the current EVM frame address before `execute`, except for stateless cryptographic precompiles." This means delegatecall-style invocation of Bittensor precompiles is rejected. — [PR #3130 (Runtime 452, 2026-08-29)](https://github.com/RaoFoundation/subtensor/pull/3130)
- Address zero: Runtime 464 (Sept 2026) "Reject[s] … EVM address(0) origins." — [Release v464](https://github.com/RaoFoundation/subtensor/releases/tag/v464)
- Per-block rate limit: removed. PR #2712 (merged 2026-06-04) "Removes `StakingOperationRateLimiter` — the per-block, per-(hotkey, coldkey, netuid) 'one staking operation per block' lock … add_stake and a subsequent remove_stake / move_stake / swap_stake / transfer_stake on the same (hotkey, coldkey, netuid) are allowed within a single block." It shipped in v3.4.8-423 (2026-06-25). **Older info:** before June 2026 a contract could do only one staking op per (hotkey, coldkey, netuid) per block. — [PR #2712](https://github.com/RaoFoundation/subtensor/pull/2712); [Release v3.4.8-423](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.8-423)
- EVM frontrunning: Dec 2025 PR #2307 "clamps EVM transaction priority so that regardless of the tip/priority fee … the block builder will never take this into account … to prevent a current exploit where people were using EVM transactions to frontrun all swaps in a block." — [PR #2307](https://github.com/RaoFoundation/subtensor/pull/2307)
- Fees: Runtime 467 (Sept 2026) "halve[d] transaction fees (native + EVM)." EVM base and priority fees are recycled (reduce issuance) rather than paid to the block author. — [Release v467](https://github.com/RaoFoundation/subtensor/releases/tag/v467); [Bittensor docs: Transactions](https://www.bittensor.com/docs/concepts/transactions)
- Interface stability policy: "Treat every released precompile address, function signature, and selector as a permanent public API … Runtime upgrades must not silently break deployed contracts." The registry, however, "reports whether a precompile is disabled" (reversible disablement exists). — [Bittensor docs: Precompile design and lifecycle](https://www.bittensor.com/docs/guides/evm/precompile-design)

### Inferences
- A cascade vault contract on Bittensor EVM can own a multi-subnet basket directly. Every position is keyed (validator hotkey, contract mirror, netuid). The contract must hold the native TAO itself, and the vault's accounting must handle three unit systems (wei, rao, and per-subnet alpha rao) without mixing alpha across subnets.
- Use the limit variants (`addStakeLimit` / `removeStakeLimit` / `moveStakeLimit` with `allow_partial=false`) for every rebalance leg. Use `removeStakeFull*` or `u64::MAX` semantics for full exits to avoid dust and truncation reverts.
- Removing the per-block staking rate limit (June 2026) makes atomic multi-leg rebalances in one transaction feasible. It also makes same-block sandwiching by other actors easier.
- The governance-controlled ability to disable precompiles, plus frequent upgrades, means the vault needs an emergency "unstake-all to TAO" path. It should also pause on unexpected precompile reverts.

### Gaps
- I did not verify gas costs or per-call weight limits for staking-v2 calls. That matters for a single transaction touching 16–32 subnets. Release v466 mentions "cap staking scan fees at four hotkeys" without details.
- Whether EVM transactions can use the MEV-shield encrypted path is not documented. MEV Shield is documented for SDK-signed substrate extrinsics only.
- Which functions in stakingV2.sol on `main` might not yet be live on mainnet: v481 was deployed 2026-10-19 and main = release-479 + etao, so the gap is probably none, but I did not confirm on-chain.

---

## 2. dTAO mechanics in 2026: pool pricing, slippage, limit orders, fees, lockups, rate limits, emission model (Taoflow → price-based), halving, root and TAO weight

### Takeaway
Each subnet's alpha trades against TAO in a protocol-owned, **Balancer-style weighted pool** (since Feb–Jun 2026; it was constant-product at the Feb 2025 dTAO launch). Every stake or unstake is a swap with:
- a per-subnet fee of about 0.05% (33/65535) on the input side,
- deterministic price impact,
- no unbonding period.

Optional conviction locks are opt-in and irrelevant unless used. The way TAO emission is split across subnets has changed **three times in 12 months**:
1. Price-EMA based (dTAO, 2025), then
2. **Taoflow** net-flow based (Nov 2025 – Jun 2026), then
3. **back to price-EMA based with miner-burn scaling and a soft "emission gate"** (June 22, 2026 → present).

Further per-subnet emission-weight changes landed on Oct 19, 2026 (v481). The first TAO halving (Dec 2025) cut emission to 0.5 TAO/block (about 3,600 TAO/day).

### Cited Findings
**Pool and swap mechanics (current)**
- "Pools are Balancer-style weighted pools, and the spot alpha price is `(w_alpha / w_tao) × (TAO reserve / alpha reserve)` … weights start at 0.5/0.5 … bounded to [0.01, 0.99]. Per-block liquidity injections shift the weights instead of the price." Pool liquidity is protocol-owned by default (user LP toggle off). — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- Timeline of the swap design:
  - "Balancer swap" PR #2290 merged in v3.3.10-380 (2026-02-20). — [Release v3.3.10-380](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.10-380)
  - "Re-enable balancer" in v3.4.8-423 (2026-06-25). — [Release v3.4.8-423](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.8-423)
  - **Older info:** a hotfix in Dec 2025 added an "extrinsic to disable user liquidity on all subnets" (the 2025 Uniswap-v3-style user LP feature). — [Release v3.2.17-350](https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.17-350)
- Swap fee: "amount × FeeRate / 65535, where FeeRate is per-subnet and governance-settable (default 33 ≈ 0.05%). It is taken from the input side: TAO when staking, alpha when unstaking — and paid to the block author." Same-subnet hotkey moves pay no swap fee. "A cross-subnet move runs two swaps but is charged the fee only once." — [Bittensor docs: Money](https://www.bittensor.com/docs/concepts/money)
- Liquidity limits: the pool "refuses trades that would drain a reserve below a minimum, and rejects single swaps larger than 1,000× the TAO reserve (`InsufficientLiquidity`)." — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools)
- Limit orders: "the chain computes exactly how much can fill before the pool price reaches your limit, fills up to that point, and either stops there (`allow_partial=true`) or rejects the whole order (`allow_partial=false`)." Tolerance math: staking ceiling = spot × (1 + tol), unstaking floor = spot × (1 − tol). — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools)
- MEV: "A large stake order sitting in the public mempool is legible to everyone — including a front-runner." MEV-shielded submission encrypts the extrinsic to the chain's rotating ML-KEM-768 key. "Small swaps (well under ~1 TAO) and root-network staking … gain nothing from it." MEV Shield shipped in v3.3.0-361 (2025-12-09). — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools); [Release v3.3.0-361](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.0-361)
- No lockup: "There is no unbonding period — the TAO is spendable immediately." "The only time constraints in the staking system are conviction locks (opt-in …) and the rate limits on child and take changes." — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools); [Bittensor docs: Staking](https://www.bittensor.com/docs/guides/staking)
- Root has an optional hold: a root (netuid 0) exit before `RootStakeUnlockInterval` blocks since the last root add/remove/claim fails with `RootStakeLocked`. This is governance-set and the docs describe the zero/nonzero cases. — [Bittensor docs: too_early errors](https://www.bittensor.com/docs/errors/too-early); [Root Reborn](https://www.bittensor.com/docs/guides/root-reborn)

**Conviction locks (May 2026 → present, opt-in)**
- A lock "is a **floor on unstaking**." "Locked alpha **keeps earning**." New locks decay by default. On mainnet `MaturityRate` is 311,622 blocks (about 43 days) and `UnlockRate` is 934,866 blocks (about 130 days). After one year, a hotkey with more than 18% of eligible alpha in its own conviction can take subnet ownership. — [Bittensor docs: Conviction locks](https://www.bittensor.com/docs/guides/conviction)
- Convictions (stake locks) arrived in v3.4.0-411 (2026-05-28). — [Release v3.4.0-411](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.0-411)
- The 18% single-hotkey takeover gate came in Runtime 447 (2026-08-14). — [Release v447](https://github.com/RaoFoundation/subtensor/releases/tag/v447)

**Emission model history (labelled by date)**
- **Feb 2025 (older):** dTAO launched at first dTAO block 4,920,351 and "converted all existing stake to root TAO stake." — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- **Nov 2025 – Jun 2026 (older): Taoflow.** Opentensor stated that "As of November 2025 … Bittensor has transitioned to a flow-based model ('Tao Flow') … Emissions are now based on net TAO inflows due to staking activity, rather than token [price]." — [Opentensor Foundation on X](https://x.com/opentensor/status/1999071691243429968)
  - Release notes: "Feat/flow emissions" (#2160) in v3.2.10-334 (2025-11-04); "Re-enable tao flow" in v3.2.11-338 (2025-11-05); EMA-flow hotfixes through Nov 2025; a "taoflow hotfix" in v3.3.3-366 (2026-01-06); "net TAO flow for emission allocation" and "normalize protocol cost in net flow EMA" in v3.4.0-411 (2026-05-28). — [Releases](https://github.com/RaoFoundation/subtensor/releases)
  - Secondary sources: under Taoflow, subnets with net outflows could be clipped to zero emissions, and one report said 28% of emissions went to three compute subnets (Lium, Chutes, Targon). Treat as unverified. — [KuCoin news](https://www.kucoin.com/news/insight/TAO/6ad6481c40361e0007fc92de); [Crypto Briefing](https://cryptobriefing.com/bittensor-dynamic-tao-emission-model/)
- **June 22–23, 2026 → present: price-based again.** PR #2779 "Switch subnet emissions to price-based shares … get_shares now uses the subnet price EMA (SubnetMovingPrice) … Alpha injection cap is now root_proportion * alpha_emission … drop obsolete TAO-flow share tests" (merged 2026-06-22). Related: v3.4.6-421 "Price-based emissions with miner-burn scaling" and v3.4.7-422 "Default subnet emission off on registration." — [PR #2779](https://github.com/RaoFoundation/subtensor/pull/2779); [Release v3.4.6-421](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.6-421)
  - A community newsletter reported that a June 22, 2026 update "blocked token emissions to 57 inactive or exploitative subnets," redirecting about a third of emissions, alongside the return to a price-based model. — [A Bittensor Journey, June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)
- **Current formula, step 1:** `demand_share_i = price_ema_i / Σ price_ema`.
- **Step 2:** scale by `(1 − MinerBurned_i)` and renormalize. MinerBurned is the share of miner incentive directed to subnet-owner hotkeys.
- **Step 3, emission gate:** `gate_i = 1/(1 + (theta/share_i)^h)`. By default `theta` is "the 32nd-highest positive adjusted share," recomputed every 360 blocks, with h = 3.
- **EMA smoothing:** `ema_alpha = base_alpha × blocks_since_start/(blocks_since_start + halving_blocks)` with halving_blocks of 201,600 (about 4 weeks). "New subnets start near zero … which blunts launch pumps, coordinated buys, and flash attacks." "The spot price feeding the EMA is capped at 1.0."
- **Disabled subnets:** an emission-disabled subnet gets no TAO-side share.
- Source for the formula: [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- Root controls the emission switch: `subnet_emission_enabled` is "root's emission valve." New subnets register with it **false**. While false, there is no `tao_in`/`alpha_in` injection or chain buys, but `alpha_out` still pays participants. — [Bittensor docs: subnet_emission_enabled](https://www.bittensor.com/docs/hyperparameters/subnet-emission-enabled)
- "Only Root Toggles Subnet Emissions" shipped in v3.4.0-411. — [Release v3.4.0-411](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.0-411)
- **Oct 19, 2026 (v481) "etao":** "per-subnet emission weights with a baseline-anchored effective TAO weight" and "pay root its live baseline share off the top every block." — [Release v481](https://github.com/RaoFoundation/subtensor/releases/tag/v481)
  - Each subnet now has a vector `[burn, recycle, owner, validator, miner]`, default `[0, 0, 0.18, 0.41, 0.41]`.
  - Owner may set `owner ≤ 0.33`, `validator ≤ 0.50` (and strictly above root's baseline), `miner ≥ 0.33`, at most once per week (50,400 blocks).
  - "An owner lowering V from 41% to 20% takes the whole 21 points from alpha validators; root's slice is identical."
  - Source: [Bittensor docs: Emission weights](https://www.bittensor.com/docs/concepts/emission-weights)

**Alpha issuance and injection**
- Per block, a subnet mints up to 1 `alpha_out` for participants plus `alpha_in` into the pool (about `tao_in / price`).
- The injection is capped at `root_proportion × alpha_emission`. "As a subnet ages … the TAO that can no longer be injected as liquidity is instead swapped for alpha on the subnet's own pool — buying pressure … chain buybacks."
- Each alpha has a 21M cap and its own halving curve.
- Source: [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)

**Halving**
- "The first halving occurred in December 2025: current emission is 0.5 TAO per block, roughly 3,600 TAO per day." Halvings trigger on issuance thresholds (10.5M, 15.75M, …), not block counts. Recycling pushes halvings out. "A TAO halving also halves every pool's injection … so alpha injection halves too." — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- Exact date conflict: Grayscale and The Block expected about Dec 14, 2025, and other coverage says Dec 13. One aggregator says Dec 7. A "pre-halving hotfix" ("Alpha injection cap") was released 2025-12-12, which suggests a date after Dec 12. — [The Block](https://www.theblock.co/post/381638/bittensors-halving-tao-price); [Release v3.3.1-362](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.1-362)
- The next halving is expected around Dec 2029, or at 15.75M issuance. — [Search summary citing learnbittensor halving docs](https://docs.learnbittensor.org/concepts/halving)

**Root and TAO weight**
- `TaoWeight` is "0.18 on mainnet today and governance-set." A neuron's stake weight is `alpha_stake + tao_stake × tao_weight`.
- Within validator dividends, the TAO-staker portion is `τw/(α+τw)`.
- Root staking "is not a pool swap — it converts 1:1 with no swap fee and no price impact."
- Sources: [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions); [Money](https://www.bittensor.com/docs/concepts/money)

### Inferences
- **Emission share today is driven by each subnet's ~4-week-smoothed EMA price**, not by flows. This is the opposite of the Nov 2025–Jun 2026 regime. Index weighting logic should not hard-code either regime.
- The emission gate (theta at the 32nd-highest share) concentrates emissions in roughly the top 30 or so subnets. A "top-N" index with N of about 16–32 lines up with where emissions flow. Subnets far below theta receive sharply less.
- Slippage cost per rebalance is the pool price impact plus about 0.05% fee. Cross-subnet moves via `moveStakeLimit` pay the fee once.
- Owner-set validator slots (since v481) mean staker yield on a subnet can be cut by the owner on one week's cadence. Yield is no longer uniform across subnets.

### Gaps
- No primary-source statement of when the emission gate (theta = 32nd share) went live. A newsletter mentions a "v440 gate reshuffle" (late July/Aug 2026). — [A Bittensor Journey, Aug 2026](https://www.abittensorjourney.com/p/navigating-bittensor-august-2026)
- The exact `MinerBurned` scaling status is unclear: v444 removed it, then v445 restored it (Aug 2026). The docs show it active.
- No official, detailed Taoflow spec (EMA window, cutoff) was retrieved. Secondary sources cite a ~30-day EMA. Taoflow is no longer the live model anyway.

---

## 3. How staking yield is earned and distributed; typical APYs; alpha volatility

### Takeaway
Alpha stakers earn **alpha-denominated** dividends at each subnet epoch (default tempo 360 blocks, about 72 min). Yield comes from the validator slot (default 41% of the subnet's alpha emission, now owner-adjustable to at most 50%), after root's baseline share and the validator's take (default and max 18%). Headline alpha APYs are high (median about 54% in a June 2026 study), but **realized TAO-denominated returns were negative for most subnets** because of alpha price decay. Root yield is about 4–7% APY in TAO terms. Since Aug 2026 (Root Reborn), root yield is paid via validator-managed alpha "baskets."

### Cited Findings
- Per-tempo split: by default 18% owner, 41% miners, 41% validators and stakers. "Root's baseline share … is taken off the top of the validator slot." "The validator's take is deducted before delegators are paid." Distribution happens at epoch boundaries ("not continuously per block"). The default tempo is 360 blocks (about 72 min). If no valid weights exist, "emission falls back to stake proportions." — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- Root baseline share is `r = V0 × x/(x + A)` with `x = root_tao × TaoWeight`. Example: "with 5.4M TAO on root, 6.5M alpha issued and TaoWeight = 0.18, r is about 5.40% of emission." — [Bittensor docs: Emission weights](https://www.bittensor.com/docs/concepts/emission-weights)
- Take: "The chain default is 18% (stored as 11796/65535); a delegate can lower it any time … raising it … is rate-limited to once per 216,000 blocks (~30 days)." — [Bittensor docs: Staking](https://www.bittensor.com/docs/guides/staking)
- The max delegate take is 18% by default (`MaxDelegateTake`). — [Bittensor docs: invalid_argument errors (DelegateTakeTooHigh)](https://www.bittensor.com/docs/errors/invalid-argument)
- A position "earns the validator's staking emissions (minus its take) every epoch," with its TAO value floating with pool price. — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools)
- **Root Reborn (v441, 2026-08-03).**
  - Root yield "accumulates in baskets — per-validator, escrowed index funds of subnet alpha … realized only when a staker claims."
  - Claims pay "TAO staked back to root."
  - Since v461, validators reshape funds with `swap-basket` under guardrails:
    - each leg must fill within 2% of moving and spot price;
    - there is a daily turnover bucket;
    - `BasketConcentrationCap` is 1/16 of NAV, "so a traded fund spreads across at least 16 holdings."
  - Root seats are limited to 64.
  - Source: [Bittensor docs: Root Reborn](https://www.bittensor.com/docs/guides/root-reborn); [Release v441](https://github.com/RaoFoundation/subtensor/releases/tag/v441)
- Basket trading activation is unclear.
  - Docs say "Trading launches off network-wide" and was "live on testnet and not on mainnet yet." — [Bittensor docs: Basket trading for stakers](https://www.bittensor.com/docs/guides/basket-trading-for-stakers)
  - Release v468 (2026-09-21) says "enable basket trading." — [Release v468](https://github.com/RaoFoundation/subtensor/releases/tag/v468)
  - Mainnet trading status therefore conflicts between sources.
- Direct basket deposits: `stake_into_basket` "Deploys TAO … across the validator's basket and credits beta immediately … depositor bears their own entry slippage and swap fees." — [Bittensor docs: stake-into-basket](https://www.bittensor.com/docs/tx/stake-into-basket)
  - It is not exposed in the staking-v2 precompile; only `claimRoot` / `claimRootWithHotkey` and unclaimed-value views are. — [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- **APY data.** FlowSniper "Yield Illusion" report, data to June 10, 2026, 128 active non-root subnets (127 with 30-day data):
  - median marketed (alpha) APY **54%**;
  - median realized 30-day return in TAO **−7.2%**;
  - only **31 of 127 (24%)** beat root; root returned **+0.65%** over 30 days;
  - median alpha price change **−10.1%**; median alpha supply growth +4.7%;
  - by market-cap quartile, median 30-day returns were −15.9% / −7.5% / −2.4% / −6.5%;
  - "alpha staking behaves more like a price bet with a small yield attached";
  - excludes deregistered subnets and slippage, so results are "likely conservative."
  - Single firm, single window. — [FlowSniper Research](https://research.flowsniper.ai/yield-illusion/)
- Root/TAO staking APY in 2026 is about 4–7%: Staking Rewards about 5.7%, Coinbase estimate 4.64%, Kraken about 5–7% (per a vendor summary). — [Staking Rewards](https://www.stakingrewards.com/asset/bittensor); [Coinbase](https://www.coinbase.com/earn/staking/bittensor); [Stakao](https://stakao.com/blog/how-to-stake-tao)
- Alpha crash example: Quasar (SN24) token "fell about 75% within a few hours" of model-audit allegations (Aug 2026). — [A Bittensor Journey, Aug 2026](https://www.abittensorjourney.com/p/navigating-bittensor-august-2026)
- Taostats has a yield page with chain-based staking calculations. — [taostats yield](https://taostats.io/yield)

### Inferences
- For cascadefi.xyz, "yield" must be reported in TAO (and USD) terms net of alpha price change. Marketing alpha APY would be misleading given the evidence that most subnets lost TAO value over 30-day windows in H1 2026.
- Root Reborn baskets are a **native, on-chain competitor**. They are validator-curated subnet-alpha index funds with a 1/16 concentration cap, NAV priced at realizable value, and staking-like UX. Yuma's "Total Market Fund" (June 2026) is another. — [A Bittensor Journey, June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)
- A simpler cascade design could root-stake to a high-performing basket validator via `addStake(hotkey, amount, 0)` and periodically `claimRootWithHotkey`. That outsources subnet selection, at the cost of validator discretion risk. Whether direct `stake_into_basket` is reachable from EVM (it is not in staking-v2 today) matters for this path.

### Gaps
- No primary dataset of alpha price volatility (stdev or drawdowns) per subnet for 2026 was found. The taostats pool history API could produce it.
- No current (Oct 2026) median alpha APY or root APY figure from an on-chain source. Root-yield figures are from staking aggregators and may lag Root Reborn changes.
- No Root Reborn basket performance data since Aug 3 was found.

---

## 4. Subnet count, deregistration/pruning, and what happens to stakers' alpha

### Takeaway
There is a **128-subnet cap** (plus root). It was full or nearly full in 2026: 128 active non-root subnets in June 2026, and 129 including root by August. When full, a new registration **prunes the non-immune subnet with the lowest EMA alpha price**. Immunity lasts about 6 months. On dissolution the pool's TAO reserve is paid **pro-rata to all alpha as TAO to holders' coldkey balances**. Protocol-owned alpha dilutes the payout, and conviction is not compensated.

### Cited Findings
- Deregistration rule: "When the subnet limit (128) is reached, the next register-subnet prunes the non-immune subnet with the lowest EMA alpha price (ties go to the oldest) and reuses its netuid. New subnets are immune for 1,296,000 blocks (~6 months)." — [Bittensor docs: Running a subnet / Deregistration](https://www.bittensor.com/docs/guides/subnets)
- History: price-ranked deregistration "existed pre-dTAO …, was removed at dTAO's launch in February 2025, and returned price-ranked in September 2025." — [Bittensor docs: Running a subnet](https://www.bittensor.com/docs/guides/subnets)
- The Sept 2025 release introduced "dTao-Compatible Subnet Deregistration." — [Release v3.2.8-320](https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.8-320)
- Payout on dissolution: "the subnet's TAO reserve is distributed pro-rata over all alpha — credited directly to each holder's coldkey balance, not restaked."
  - "protocol-held alpha (the pool's alpha-in plus alpha bought back by the chain) counts in the denominator and its share returns to the chain, diluting holder payouts."
  - "conviction locks are deleted before liquidation."
  - "if [the pool's TAO-per-alpha rate] exceeds the market price at dissolution, holders receive more than market value."
  - Source: [Bittensor docs: Running a subnet](https://www.bittensor.com/docs/guides/subnets)
- Root Reborn baskets: holdings can be "converted to TAO when a subnet dissolves." — [Bittensor docs: Root Reborn](https://www.bittensor.com/docs/guides/root-reborn)
- A 2026-09 fix "Restore only deducted dissolution stake" shows dissolution accounting was still being patched. — [Release v468](https://github.com/RaoFoundation/subtensor/releases/tag/v468)
- `claim_root` fee quote is lowered "to the 128 subnet cap + root" (Aug 2026), which confirms the 128 cap in code. — [Release v448](https://github.com/RaoFoundation/subtensor/releases/tag/v448)
- Counts: FlowSniper analyzed "128 active non-root subnets" (data to June 10, 2026). A wiki summary says 129 subnets (incl. root) as of Aug 2026. — [FlowSniper](https://research.flowsniper.ai/yield-illusion/); [AIWiki](https://aiwiki.ai/wiki/bittensor)
- A subnet can be emission-disabled by root, which halts pool-side TAO injection while it still exists. A newsletter reports 57 subnets were emission-blocked on June 22, 2026. — [Bittensor docs: subnet_emission_enabled](https://www.bittensor.com/docs/hyperparameters/subnet-emission-enabled); [A Bittensor Journey, June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)
- Subnet abandonment and ownership risk:
  - Covenant AI exited three subnets in April 2026.
  - SN3 was "reclaimed" by the community via the conviction mechanism.
  - Quasar (SN24) had its owner banned and a coldkey swap announced after an audit (Aug 2026).
  - Source: [A Bittensor Journey, Aug 2026](https://www.abittensorjourney.com/p/navigating-bittensor-august-2026)
- The subnet precompile exposes `getSubnetDissolutionStatus` and `getNetworkRegistrationBlock`, for checking immunity and dissolution on-chain. — [subnet.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/subnet.sol)

### Inferences
- An index holding top-N by price or market cap is unlikely to hold the lowest-EMA-price subnet, the one that gets pruned. Pruning risk mostly affects tail holdings.
- On dissolution the contract would receive **native TAO into its free balance** (mirror coldkey), not stake. Vault accounting must detect that unexpected TAO inflow and reinvest it or treat it as cash.
- Emission-disable by root and owner rug or abandonment are bigger practical risks than formal deregistration for top subnets. They act as price shocks (e.g., −75% in hours), and limit orders cannot avoid them.

### Gaps
- The exact subnet count on 2026-10-20 was not confirmed. The cap is 128 (+root), and it appears full.
- No data on how many subnets were pruned in 2026 or on realized dissolution payouts versus market price.

---

## 5. On-chain data for picking and weighting subnets; manipulability; sandwich risk; data APIs

### Takeaway
Nearly every relevant metric is readable on-chain from Solidity via the alpha precompile (`0x…0808`) and subnet precompile (`0x…0803`):
- spot and EMA price, pool TAO and alpha reserves, alpha issuance and outstanding,
- per-block TAO/alpha emissions, volume, TAO-flow EMA,
- emission-enabled flag, swap fee, and swap simulation.

The **EMA price** (`getMovingAlphaPrice`) is the protocol's own anti-manipulation signal and drives emission share. Spot price and spot market cap are easy to move in thin pools. A predictable rebalancer is a sandwich target unless it uses tight limit prices, small slices, or private/shielded submission. Taostats offers a paid API with pool, flow and history endpoints.

### Cited Findings
- On-chain reads available in Solidity: `getAlphaPrice`, `getMovingAlphaPrice`, `getTaoInPool`, `getAlphaInPool`, `getAlphaOutPool`, `getAlphaIssuance`, `getSubnetVolume`, `getTaoInEmission`, `getAlphaInEmission`, `getAlphaOutEmission`, `getSubnetFlowState` (taoFlow, taoFlowEma), `getSubnetEconomicState` (emissionEnabled, rootProportion), `getEmissionGateConfig`, `getSwapState` (feeRate), `simSwapTaoForAlpha` and `simSwapAlphaForTao`. — [alpha.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/alpha.sol)
- Subnet-level reads: `getSubnetEmissionWeights` (owner/validator/miner split), `getNetworkRegistrationBlock` and `getImmunityPeriod`. — [subnet.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/subnet.sol)
- EMA design: "New subnets start near zero — their moving price adapts extremely slowly, which blunts launch pumps, coordinated buys, and flash attacks on emission shares. The spot price feeding the EMA is capped at 1.0." EMA halving_blocks default is 201,600 (about 4 weeks). — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- TAO flow: "every stake adds to the accumulator and every unstake subtracts … smooths … into an exponential moving average (SubnetEmaTaoFlow)." — [Bittensor docs: subnet-tao-flows](https://www.bittensor.com/docs/query/subnet-tao-flows)
- Valuation: spot `alpha × price` "ignores what your own exit would do to it." "For what you would actually receive, quote the exit." — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools)
- Root Reborn values funds at realizable NAV: "A thin pool cannot inflate book value." — [Bittensor docs: Root Reborn](https://www.bittensor.com/docs/guides/root-reborn)
- Sandwich risk:
  - "A large stake order sitting in the public mempool is legible to everyone — including a front-runner who can buy alpha before your order executes … The sandwich's profit is carved out of your execution price." "The danger case is a large swap with a loose or absent limit price." — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools); [Money](https://www.bittensor.com/docs/concepts/money)
  - EVM tx priority fees are ignored by the block builder since Dec 2025, to stop EVM frontrunning of swaps. — [PR #2307](https://github.com/RaoFoundation/subtensor/pull/2307)
  - The per-block staking rate limit, which incidentally limited same-block round-trips, was removed June 2026. — [PR #2712](https://github.com/RaoFoundation/subtensor/pull/2712)
- Taostats API:
  - Base URL `https://api.taostats.io/api/`, API key in the Authorization header.
  - Endpoints include `GET /api/dtao/pool/total_price/latest/v1`, `/api/dtao/pool/latest/v1?netuid=N` (price, liquidity, market cap, volume), `/api/dtao/pool/history/v1`, and `GET /api/dtao/tao_flow/v1` (net TAO flow per subnet).
  - There is an MCP server with slippage estimates and OHLCV.
  - A free tier exists; paid tiers raise limits. Exact pricing was not found.
  - Sources: [taostats docs: Quickstart](https://docs2.taostats.io/api/quickstart/); [Net TAO flow](https://docs2.taostats.io/api/subnet/get-api-dtao-tao-flow-v1/); [Sum of subnet prices](https://docs2.taostats.io/api/dtao/get-current-sum-of-subnet-prices/); [mcp.taostats.io](https://mcp.taostats.io/)
- Market-structure context: TAO was bridged to Base via Chainlink CCIP on Aug 20, 2026, with a ForeverMoney integration "connect[ing] 16 subnets to DeFi liquidity" (newsletter, unverified). Kraken listed several subnet alpha tokens (June 29, 2026). — [A Bittensor Journey, Aug 2026](https://www.abittensorjourney.com/p/navigating-bittensor-august-2026); [June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)

### Inferences
- Recommended weighting inputs, all on-chain:
  - `getMovingAlphaPrice × (getAlphaOutPool + getAlphaInPool or issuance)` as an EMA market cap;
  - or the protocol's own emission share (EMA price share × burn adjust × gate), approximated from `getTaoInEmission` per subnet;
  - filters: `emissionEnabled == true`, age beyond immunity, `getTaoInPool` above a liquidity floor, and validator slot (from `getSubnetEmissionWeights`) not cut far below 0.41.
- Spot price, spot market cap and short-window flows are cheap to manipulate in thin pools right before a known rebalance time. Using the ~4-week EMA ties the index to what the protocol itself rewards and is expensive to move.
- Execution hygiene for a predictable rebalancer:
  - randomize timing;
  - slice orders sized against `getTaoInPool` (e.g., cap price impact per leg at 0.5–1%);
  - set `limit_price` from the EMA or `simSwap*` quote with `allow_partial=false`;
  - prefer `moveStakeLimit` for alpha→alpha legs (one fee);
  - avoid publishing exact target weights before execution.
- Taostats is useful off-chain (keeper/monitoring), but an on-chain-verifiable rule set using precompile reads is better for a "security-first" vault. Avoid oracle dependence for core accounting.

### Gaps
- No quantitative study of sandwich/MEV losses on Bittensor pools in 2026 was found.
- Whether an EVM transaction can be submitted via MEV-shield is undocumented.
- Taostats pricing tiers and SLA were not retrieved.

---

## 6. Validator selection per subnet

### Takeaway
A stake position names a validator **hotkey** per subnet. The same hotkey can hold stake on any subnet, but it **only earns dividends on subnets where it holds a validator permit and sets weights**, or lends weight through childkeys. Permits go to the top-K by stake weight (K = 128 by default; alpha stake + 0.18 × root TAO). Picking per subnet should use on-chain reads: dividends, validator status, take, and childkeys. Takes are capped at 18% by default, and raises are rate-limited to once per ~30 days. Same-subnet hotkey moves (`moveStake`) are fee-free and slippage-free, so switching validators is cheap.

### Cited Findings
- Permits: "Validator permits are recalculated every epoch as the top-K neurons by stake weight … with K = MaxAllowedValidators (default 128)." "Validators below the chain's stake threshold (currently 1,000 tokens' worth) are zeroed." Neurons inactive beyond the activity cutoff (default 5,000 blocks) are excluded. — [Bittensor docs: Emissions / Yuma Consensus](https://www.bittensor.com/docs/concepts/emissions)
- Stake weight is `alpha_stake + tao_stake × tao_weight`, so root TAO stake counts toward validator weight on every subnet. — [Bittensor docs: The network](https://www.bittensor.com/docs/concepts/network)
- Dividends are bonds × miner incentive. Validators who "recognize good miners early build bonds and earn more." — [Bittensor docs: Emissions](https://www.bittensor.com/docs/concepts/emissions)
- Take: the default is 18%; decrease anytime; increase rate-limited to once per 216,000 blocks (about 30 days). Read it via `delegate-take` or the precompile `getDelegate(bytes32) returns (bool exists, uint16 take)`. — [Bittensor docs: Staking](https://www.bittensor.com/docs/guides/staking); [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- Root validators: on registration, the hotkey "is also auto-childkeyed to every existing subnet owner (100% of stake weight on that subnet), unless you opted out." Registration "marks the hotkey as a delegate with the default 18% take." — [Bittensor docs: Root Reborn](https://www.bittensor.com/docs/guides/root-reborn)
- Same-subnet move: "Moving a position between hotkeys on the same subnet (move-stake) is *not* a swap — no fee, no price impact." — [Bittensor docs: Staking and pools](https://www.bittensor.com/docs/concepts/staking-pools)
- Per-UID reads: the metagraph precompile provides `getDividends(netuid, uid)`, `getValidatorStatus`, `getStake`, `getVtrust`, `getLastUpdate`, `getIsActive` and `getHotkey`. The uid-lookup precompile maps addresses to UIDs. — [metagraph.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/metagraph.sol); [Bittensor docs: EVM](https://www.bittensor.com/docs/guides/evm)
- The staking-v2 precompile provides `getChildKeys` / `getParentKeys`, `getChildkeyTake`, `getTotalAlphaStaked(hotkey, netuid)` and `getAlphaStakedValidators`. — [stakingV2.sol](https://github.com/RaoFoundation/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol)
- Griefing risk was fixed: after validator deregistration, repeated hotkey swaps could grief delegated alpha. Runtime 473 (Oct 2026) added a 7,200-block cooldown, while "Delegator withdrawals remain unrestricted during the recovery window." — [PR #3199](https://github.com/RaoFoundation/subtensor/pull/3199)
- Hotkey-swap bugs: a hotkey-swap bug in March 2026 led to "Disable HK swap temporarily" and a migration "fix bad hk swap" (v3.3.13-393). A June 2026 security hotfix addressed hotkey-swap/staking edge cases (GHSA advisories). — [Release v3.3.13-393](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.13-393); [Release v3.4.5-419](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.5-419)

### Inferences
- One large multi-subnet validator (typically a top root validator) can usually serve most top subnets, through its own permits or childkey delegation. It is still safer to choose per subnet the hotkey with:
  - a validator permit;
  - recent `getLastUpdate`;
  - high `getDividends` per unit of stake;
  - take ≤ 18%.
- The keeper can verify this off-chain and pass the hotkey to the contract; the contract re-checks on-chain. A whitelisted set per netuid, updated by timelocked governance, limits keeper abuse.
- Bad-validator risk is mostly lost yield (no dividends, higher take), not loss of principal. There is no slashing in dTAO, per the docs. Switching is a fee-free `moveStake`.

### Gaps
- No primary-source statement on whether dTAO has any slashing. The docs describe none; I found no explicit "no slashing" quote.
- No list of 2026 validator take levels or dividend efficiency per validator was retrieved. Taostats validator endpoints could provide it.

---

## 7. Chain halts, governance, and runtime upgrades that changed staking behavior (2025–2026)

### Takeaway
Bittensor in 2026 is a **PoA chain governed by sudo, held by a Rao Foundation multisig**. The senate/triumvirate on-chain voting was removed. Runtime upgrades are approved 2-of-3 by a triumvirate out-of-band. Upgrades are **extremely frequent** (roughly weekly, sometimes several per week) and have repeatedly changed core staking economics with little notice:
- the emission model (×3),
- the swap curve (→ Balancer),
- staking rate limits (removed),
- root yield (Root Reborn baskets),
- per-subnet emission weights (Oct 2026),
- emissions switched off for dozens of subnets (June 2026).

There were regressions that broke contract flows. I found no confirmed full chain halt in 2025–2026; the last documented safe-mode was July 2024.

### Cited Findings
- Chain consensus: "Only approved authorities can author blocks … This permissioned validator selection is why the current chain-level mechanism is classified as PoA." NPoS is a roadmap item "within roughly the next year … not a fixed activation date." — [Bittensor docs: Chain consensus](https://www.bittensor.com/docs/concepts/chain-consensus)
- Governance: "The legacy on-chain senate-vote extrinsic — and the collective and membership pallets behind it — have been removed … Privileged operations (runtime upgrades, protocol changes) are dispatched through sudo, held by a multisig of Rao Foundation keys." — [Bittensor docs: Validating](https://www.bittensor.com/docs/guides/validating)
- Proxy types: "Triumvirate, Senate, Governance, and RootWeights are deprecated on the current runtime." — [Bittensor docs: add-proxy](https://www.bittensor.com/docs/tx/add-proxy); [Proxy accounts](https://www.bittensor.com/docs/guides/proxies)
- Release process: "CI never upgrades mainnet directly … the CI key is one half of a 2-of-2 deployment multisig that holds a SudoUncheckedSetCode proxy on the sudo key. The triumvirate then approves the proposal 2-of-3 out-of-band." — [Bittensor docs: Release process](https://www.bittensor.com/docs/internals/release-process)
- Governance refactoring "(V1 -> V2)" and "Governance" PRs landed in v3.4.8-423 (June 2026). — [Release v3.4.8-423](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.8-423)
- Repo and org move: "Migrate repo references from opentensor to RaoFoundation org" PR #2822. — [GitHub PR #2822](https://github.com/RaoFoundation/subtensor/pull/2822)
- Leadership claims (secondary, unverified): Jacob Steeves stepped down as Opentensor Foundation CEO in Feb 2026, and a decentralization roadmap targets Dec 2027. — [AIWiki](https://aiwiki.ai/wiki/bittensor)
- Const said in June 2026 that Bittensor "is currently not a decentralized protocol in the way Bitcoin is." — [A Bittensor Journey, June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)
- Release cadence: GitHub shows Runtime releases v432 (2026-07-16) through v481 (2026-10-19), about 30 releases in 3 months including "proposed" ones. — [subtensor releases](https://github.com/RaoFoundation/subtensor/releases)
- Staking-relevant changes, by date:
  - **2025-11-04/05 (older):** flow-based emissions (Taoflow) and root claim introduced; "set all precompile transaction payable." — [Release v3.2.10-334](https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.10-334)
  - **2025-12-02 (older):** "[hotfix] disable paying tx-fees in alpha." — [v3.2.16-349](https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.16-349)
  - **2025-12-05:** "Add extrinsic to disable user liquidity on all subnets." — [v3.2.17-350](https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.17-350)
  - **2025-12-09:** MEV Shield; **2025-12-12:** "Alpha injection cap" (pre-halving hotfix). — [v3.3.0-361](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.0-361); [v3.3.1-362](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.1-362)
  - **2025-12-19:** "Stop EVM frontrunning," "Emission-based Neuron Deregistration." — [v3.3.2-365](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.2-365)
  - **2026-02-20:** Balancer swap; "Subnet buyback" renamed `add_stake_burn`. — [v3.3.10-380](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.10-380)
  - **2026-03-26:** "Disable HK swap temporarily" plus a migration to fix a bad hotkey swap. — [v3.3.13-393](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.13-393)
  - **2026-04-23:** "Reenable alpha fees"; `transferStakeFrom`/`approve` added to the staking precompile. — [v3.3.14-401](https://github.com/RaoFoundation/subtensor/releases/tag/v3.3.14-401)
  - **2026-05-28:** convictions/stake locks; net TAO flow update; "Temporarily disable stake locking"; "Only Root Toggles Subnet Emissions"; 90-day half-life unlock and maturity rates (later re-set to about 43 and 130 days per docs). — [v3.4.0-411](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.0-411)
  - **2026-06-17:** security hotfix for audit findings (proxy-permission hardening, hotkey-swap/staking edge cases; 2 High-severity GHSAs). — [v3.4.5-419](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.5-419)
  - **2026-06-22/25:** price-based emissions with miner-burn scaling; "Default subnet emission off on registration"; per-block staking rate limiter removed; "Pallet advanced limit orders." — [v3.4.6-421](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.6-421); [v3.4.8-423](https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.8-423)
  - **2026-08-03:** Root Reborn (v441). **2026-08-14:** conviction 18% takeover gate. **2026-08-21:** `move_stake_limit`. **2026-08-27:** "enable root weight setting with a 1/16 concentration cap" (later retired in v461 per docs). — [v441](https://github.com/RaoFoundation/subtensor/releases/tag/v441); [v447](https://github.com/RaoFoundation/subtensor/releases/tag/v447); [v448](https://github.com/RaoFoundation/subtensor/releases/tag/v448); [v450](https://github.com/RaoFoundation/subtensor/releases/tag/v450)
  - **2026-09-03/04:** Release 453 fixed a proxy filter-laundering vulnerability, but "also blocked legitimate contract deposit flows" (contract → Proxy::proxy → transfer_stake failed with `CallFiltered`). It was fixed one day later in 454. — [PR #3140](https://github.com/RaoFoundation/subtensor/pull/3140)
  - **2026-09-17/21:** basket trading (`swap_basket`), then "enable basket trading"; fees halved (v467); "failed-call fee refunds" (v469). — [v464](https://github.com/RaoFoundation/subtensor/releases/tag/v464); [v468](https://github.com/RaoFoundation/subtensor/releases/tag/v468)
  - **2026-10-05:** "Rate limit delegated alpha hotkey moves," "Deprecate alpha v1 - stage 1," and "Publish mainnet releases without a second approval." — [v473](https://github.com/RaoFoundation/subtensor/releases/tag/v473)
  - **2026-10-19:** etao per-subnet emission weights (v481). — [v481](https://github.com/RaoFoundation/subtensor/releases/tag/v481)
- Halts: the docs record that "the chain ran in safe mode from July 2 to July 12, 2024" after a compromised PyPI `bittensor` 6.12.2 release (**older**). — [Bittensor docs: Wallets and keys](https://www.bittensor.com/docs/concepts/wallets)
- No dated 2025–2026 chain halt was confirmed in my searches. One secondary review asserts the foundation "has halted the network before." — [OwnYourMind review](https://ownyourmind.ai/projects/bittensor/)
- Governance controversies (secondary):
  - Covenant AI's Sam Dare (April 2026) "accused the core team of unilateral control and of halting emissions without consensus," followed by a sharp TAO drop. — [A Bittensor Journey, June 2026](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026)
  - Yuma (a DCG subsidiary) criticized Root Reborn on governance and market-structure grounds (June 2026). — [same](https://www.abittensorjourney.com/p/navigating-bittensor-june-2026); [cryptonews](https://cryptonews.net/news/altcoins/33032899/)

### Inferences
- For an automated vault, **protocol-change risk is the dominant non-market risk**. Emission allocation, fee routing, root yield mechanics and even swap math have been rewritten by a small multisig on short notice. Design implications:
  - parameter reads at runtime, not constants;
  - circuit breakers on anomalous reads (e.g., an `emissionEnabled` flip, a fee-rate change, a large EMA vs spot gap);
  - a guardian pause;
  - a tested, permissionless unwind-to-TAO path;
  - monitoring of the subtensor releases feed, with a testnet/mainnet-clone regression suite of the vault's precompile calls before each upgrade lands.
- Note the v473 change "Publish mainnet releases without a second approval." It concerns GitHub release publishing; mainnet runtime upgrades still require the triumvirate multisig per the release-process docs. Upgrade cadence may increase further.

### Gaps
- No primary announcement explaining the Opentensor → Rao Foundation transition, or the multisig signer identities.
- No confirmed chain halt or safe-mode event in 2025–2026; absence of evidence is not conclusive.
- I did not determine whether any 2026 upgrade changed EVM precompile semantics for deployed staking contracts beyond PR #3130 (frame-address check) and the transient 453 regression (which affected the ink!/contracts path, not EVM).
