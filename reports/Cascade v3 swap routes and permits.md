# Aerodrome Slipstream vs Uniswap route, USDC/TAO permits (Base 8453)

Unless noted, every on-chain fact below comes from `cast` calls to https://mainnet.base.org. The quotes use block 53,096,767 (2026-10-26 02:48 UTC). No transactions were sent. Swaps were simulated with `eth_call` only.

## 1. Slipstream contracts for the TAO/USDC "0.039%" pool

**Pool 0x99f0364e162a36a77e5d77b5eeb56539563735a3.** GeckoTerminal labels it `aerodrome-slipstream-3`.
- `factory()` = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef. This is the "Gauges V3 (latest)" PoolFactory in the aerodrome-finance/slipstream README. `getPool(USDC,TAO,100)` returns this pool.
- token0 = USDC (0x8335…2913), token1 = TAO (0xf308…3d67). `tickSpacing()` = 100.
- `slot0`: sqrtPriceX96 = 4996540574805924301880026364428000, tick 221049. That is about 251.43 USDC per TAO.
- `liquidity()` = 1.4257e16 (in range). Balances are 125,002 USDC and 404.6 TAO.
- **Fee: the pool charges 1%, not 0.039%.**
  - `fee()` = 10000, and `factory.getSwapFee(pool)` = 10000.
  - The fee module 0x87D8…E8CB shows `customFee(pool)` = 10000 and `dynamicFeeConfig` = (10000, 0, 0).
  - A $1 quote costs exactly 1.000% against mid, which confirms it.
  - History from archive reads: 0.05% at creation (block ~50.17M, 2026-08-19), 0.5% by block 50.3M, and 1% from block 51,396,484 (2026-09-16) onward.
  - The fee is set by governance and can change at any time. GeckoTerminal's "0.039%" label is wrong or stale.

**Router and quoter bound to this factory** (README, then `factory()` checked on chain):

| Contract | Address | `factory()` |
|---|---|---|
| SwapRouter | 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F | 0xf8f2… ✔ |
| Quoter (V2-style) | 0x514c8B5f54112481E28028F1166Bd78501089259 | 0xf8f2… ✔ |
| MixedQuoterV3 (3 CL factories) | 0xCd2A7D98e82D6107eac1828ce8DeAA6acB65b555 | 0xf8f2… ✔ |

The older routers 0xBE6D8f0d…18a5 (factory 0x5e7B…809A) and 0xcbBb8035…Ce0D (factory 0xaDe6…716a) cannot reach this pool; a wrong factory or tickSpacing reverts.

**Router interface.** The selectors come from the bytecode and match the Slipstream source. They are the same as Uniswap's original SwapRouter (v1), except that `fee` becomes `int24 tickSpacing`. Unlike SwapRouter02, each struct has a `deadline` field.
- `exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))`, selector 0xa026383e
- `exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))`, selector 0xc04b8d59
- `exactOutputSingle((tokenIn, tokenOut, int24 tickSpacing, recipient, deadline, amountOut, amountInMaximum, sqrtPriceLimitX96))`, selector 0xc714e838
- `exactOutput((bytes path, recipient, deadline, amountOut, amountInMaximum))`, selector 0xf28c0498. The path is reversed (tokenOut first).
- **Path encoding:** `token(20) | int24 tickSpacing (3 bytes) | token(20)`. Confirmed: `quoteExactInput(0x8335…2913 000064 f308…3d67, amt)` returns exactly the same as the single quote.

**Quoter interface.**
- `quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96))` returns `(amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`.
- Also: `quoteExactInput(bytes,uint256)`, `quoteExactOutputSingle`, `quoteExactOutput`.
- These functions are not marked `view` (they work by reverting internally), so call them with `eth_call`.

**Contract callers.**
- There is no allowlist. The selectors show no owner or role functions. In the source, `msg.sender` is simply the payer.
- Verified by simulation: an `eth_call` of `exactInputSingle` from a contract address (the Uniswap USDC/WETH pool, with a USDC allowance set through `--override-state-diff`) returned 0.39425 TAO for 100 USDC.
- The same call reverts on an expired deadline and on `Too little received`.

**Gotchas.**
1. The fee is mutable and is not tied to tickSpacing. Set `amountOutMinimum` from a fresh quote every time.
2. The router's `uniswapV3SwapCallback` runs `CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, tickSpacing)`. Calling the pool directly would need your own callback validation, so use the router.
3. Fee-on-transfer: neither token charges one. TAO is a plain OpenZeppelin-style Chainlink CCIP BurnMintERC20 and is not a proxy. USDC is FiatToken, which can be paused and has a blacklist.
4. `slot0` returns 6 fields (no `feeProtocol`). In-range liquidity is thin: $10k crosses 6 initialized ticks.

**New context: Aero** (merged Aerodrome and Velodrome, launched 2026-10-21/22). Base addresses are in dromos-labs/metadex-slipstream-public `deployment-addresses/cl-base.json`: CLFactory 0x9CB2…7a76, SwapRouter 0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418 (same selectors as above), MetaQuoter 0x1dDf…7868. Fees come from a DynamicSwapFeeHook, with MEV-tax modules. GeckoTerminal's "1%" TAO/USDC pool (0x0b4bdb67…aDB8) is on Aero, tickSpacing 100, 1% fee; it quoted 0.39317 TAO for $100, worse than both routes below. An `lpMigrator` exists, so liquidity may move to Aero. Keep pool choice configurable.

## 2. Price impact (block 53,096,767)

Reference prices:
- Slipstream pool mid: 251.43 USDC/TAO.
- Uniswap route mid (USDC/WETH 0.05% pool 0xd0b5…F224, then WETH/TAO 0.3% pool 0x82dD…Dd5A): 249.71 USDC/TAO.
- The two venues differ by 0.69%, a gap the Slipstream pool's 1% fee leaves open to arbitrage.

**USDC → TAO**

| Size | Slipstream TAO out | Cost vs its mid | Uniswap 2-hop TAO out | Cost vs its mid | Better |
|---|---|---|---|---|---|
| $100 | 0.393572 | 1.04% | 0.399053 | 0.35% | Uni +1.39% |
| $1,000 | 3.920723 | 1.42% | 3.989273 | 0.39% | Uni +1.75% |
| $10,000 | 37.970250 | 4.53% | 39.752397 | 0.74% | Uni +4.69% |

**TAO → USDC** (the TAO amounts are $100, $1k and $10k at 251.43)

| TAO in | Slipstream USDC out | Cost | Uniswap USDC out | Cost vs its mid | Better |
|---|---|---|---|---|---|
| 0.397722 | 98.9567 | 1.04% | 98.9633 | 0.35% | about equal |
| 3.977221 | 985.68 | 1.43% | 989.32 | 0.39% | Uni +$3.65 |
| 39.772205 | 9,478.42 | 5.22% | 9,862.26 | 0.70% | Uni +$384 |

- The Uniswap route's fee floor is 0.35% (0.05% + 0.3%).
- Quoter gas estimates: Slipstream 184k vs Uniswap 2-hop 174k at $100.

**Splitting between the two venues does not pay at these sizes.**
- Buying: any share sent to Slipstream lowers the output (10% to Slipstream at $10k gives 39.712 vs 39.752 TAO).
- Selling: the best split is about 10% to Slipstream, which gains +$2.55 at $10k (0.026%) and +$0.06 at $1k. That is not worth the extra complexity.
- **Recommendation:** keep the Uniswap two-hop route as the primary path. Revisit only if the Slipstream or Aero fee drops (re-quote periodically).

## 3. USDC permit (EIP-2612) on Base

- **Contract:** USDC 0x8335…2913 is a FiatToken proxy. The ZeppelinOS implementation slot points to 0x2ce6311ddae708829bc0784c967b7d77d19fd779.
- **Version:** `version()` = "2" (the FiatToken v2.2 line). `name()` = "USD Coin".
- **Domain:** `DOMAIN_SEPARATOR()` = 0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f. It matches keccak(EIP712Domain(name "USD Coin", version "2", chainId 8453, verifyingContract USDC)). There is no `eip712Domain()` (ERC-5267).
- **Typehash:** `PERMIT_TYPEHASH` = 0x6e71edae…26c9 = `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`.
- **Selectors present in the implementation bytecode:**
  - `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)` 0xd505accf
  - `permit(address,address,uint256,uint256,bytes)` 0x9fd5a6cf (ERC-1271 variant)
  - `nonces(address)`
  - `transferWithAuthorization`, `receiveWithAuthorization` (EIP-3009)
- **Simulation:**
  - A permit signed by a fresh key (no code at its address) passed `eth_call` with both the v,r,s and the bytes overloads.
  - A tampered value reverted with `EIP2612: invalid signature`.
  - An expired deadline reverted with `FiatTokenV2: permit is expired`.
- **EIP-7702 gotcha:** FiatToken's `SignatureChecker` uses ECDSA only when the signer has no code. Otherwise it uses ERC-1271 only, with no fallback (circlefin/stablecoin-evm `SignatureChecker.sol`).
  - Observed: the well-known Anvil keys are 7702-delegated on Base (code `0xef0100…`). A valid ECDSA permit from them is rejected.
  - So users of MetaMask Smart Accounts or other 7702 wallets get ERC-1271 validation that depends on their delegate. Keep an `approve` fallback.
- **Permit2:** deployed at 0x000000000022D473030F116dDEE9F6B43aC78BA3 (code size 9152). Its `DOMAIN_SEPARATOR` matches the canonical ("Permit2", 8453, address).

**How MetaMask shows each option** (metamask-extension `main`: `messages.json` and `confirm/title/title.tsx`):
- **EIP-2612 permit signature:**
  - Title "Spending cap request", subtitle "This site wants permission to spend your tokens."
  - An "Estimated changes" row labelled "Spending cap" with the text "You're giving the spender permission to spend this many tokens from your account."
  - A very large value displays as "Unlimited". There is no gas charge.
  - Blockaid security alerts apply to signatures as well.
- **ERC-20 `approve` transaction:**
  - The same title, "Spending cap request", but the subtitle reads "This site wants permission to withdraw your tokens".
  - An "Edit spending cap" control, and it costs gas.
  - MetaMask can add an "Unnecessary permission" alert.
- Revoke.cash (undated) says permits get weaker warnings than approvals and are a common phishing vector.

## 4. TAO token (0xf308…3d67) permit

**Not supported.**
- `DOMAIN_SEPARATOR()`, `nonces(address)`, `version()`, `PERMIT_TYPEHASH()` and `eip712Domain()` all revert.
- The bytecode selectors include no `permit`.
- The token is a CCIP BurnMintERC20: name "Bittensor", 18 decimals, AccessControl MINTER/BURNER roles, `getCCIPAdmin` = 0xADF6…3546, `maxSupply` = 0 (uncapped). There is no proxy and no pause.
- For TAO→USDC, the user needs either an `approve` transaction or a one-time approval to Permit2 followed by Permit2 signatures.

## 5. Audits and incidents, 2026

- **DefiLlama hacks database** (api.llama.fi/hacks, latest entry 2026-10-25): no Aerodrome, Velodrome or Slipstream smart-contract exploit. It lists only frontend DNS hijacks:
  - Velodrome, 2023-11-29, about $250k
  - Aerodrome, 2025-11-21, about $700k; the contracts were unaffected
- **Slipstream repo:** it ships the inherited Uniswap v3 audits (Trail of Bits and ABDK folders) plus an Immunefi bug bounty. I found no 2026 audit of the Gauges V3 router specifically. The router bytecode size (9908) is identical to the 2024 router's.
- **Aero (new, launched 2026-10-21/22):** aero.xyz (2026-07-16) says three audit teams found no critical or high issues so far. It names ChainSecurity and Sherlock, with Riley Holterhus leading, plus a Mythos-powered review and a $400k Sherlock contest (Aug 24 to Sep 11). I found no published contest results.
- **Practical risks:** governance-set fee changes (already 0.05% → 0.5% → 1%) and liquidity migrating to Aero. Frontend/DNS attacks do not affect a contract calling the router directly.

## Sources
On-chain `cast` reads (above); github.com/aerodrome-finance/slipstream (README, SwapRouter.sol); github.com/dromos-labs/metadex-slipstream-public (deployment-addresses, audits); github.com/everstrat-xyz/contracts/issues/55; aero.xyz/articles/aero-is-on-the-horizon; cryptobriefing.com/aero-launches-seven-chains-arbitrum; circlefin/stablecoin-evm SignatureChecker.sol; MetaMask/metamask-extension messages.json and title.tsx; revoke.cash/learn/approvals/what-are-eip2612-permit-signatures; api.llama.fi/hacks; GeckoTerminal pools API.
