# Root validator research for Cascade (2026-10-25)

Chain state is from finalized block 9,365,171 (2026-10-26 03:34 UTC, spec 484), read over Substrate JSON-RPC (`entrypoint-finney` / `archive.chain.opentensor.ai`). Source code is `opentensor/subtensor` main at 5749dbf (spec 484). Anything marked **est.** is an estimate.

## 1. Validators

**How to read a basket.** Each holding is an `AlphaV2` row under `(hotkey, escrow 5EYCAe5jLQhn6ofDSwHx3AZmsZPVFHnKpstqap4vqwDWtp7s, netuid)`.
- Count rows with `state_getKeysPaged` on that prefix (plus the legacy `Alpha` map). This is exactly what admission counts.
- For NAV and holdings, use `state_call("BetaBasketRuntimeApi_get_validator_basket_summary", hotkey)`. The node RPC `betaBasket_getValidatorSummary` failed to decode for 20 of 21 hotkeys.

Take (`Delegates`) comes off root dividends before they reach the basket. The Taostats APYs look net of take (inference). "On-chain 30d" is the `BasketTwr` ratio over 216,000 blocks, annualized.

| Validator | Hotkey | Root stake τ | Take | Taostats 30d | On-chain 30d | Basket rows (raw) | Queued credits | Claim fee τ **est.** |
|---|---|---|---|---|---|---|---|---|
| tao.bot | 5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u | 1,024,910 | 0% | 5.47% | 5.91% | 128 | 0 | 0.045 |
| Kraken | 5Ckaoft1B1CQ9zBV2FLVju4KPuMQzJVn7QUf3JeTvTq1uUes | 889,099 | 18% | 3.87% | 4.29% | 126 | 27 | 0.051 |
| Yuma | 5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1 | 803,102 | 9% | 4.97% | 5.27% | 128 | 33 | 0.033* |
| Taostats | 5GKH9FPPnWSUoeeTJp19wVtd84XqFW4pyK2ijV2GsFbhTrP1 | 488,098 | 9% | 4.91% | 5.25% | 127 | 26 | 0.053 |
| TAO.com | 5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN | 247,413 | 9% | 4.96% | 5.35% | 128 | 8 | 0.048 |
| Opentensor Fdn | 5G3wMP3g3d775hauwmAZioYFVZYnvw6eY46wkFy8hEWD5KP3 | 208,530 | 18% | 3.82% | 4.16% | 121 | 12 | 0.045 |
| Crucible Labs | 5CAQAgXxoU3NPo1YG5VQKz4Ackh7goNx3TvPD9A6LoqA7FmJ | 192,066 | 9% | 4.80% | 5.25% | 128 | 2 | 0.046 |
| (no identity) | 5Dd8gaRNdhm1YP7G1hcB1N842ecAUQmbLjCRLqH5ycaTGrWv | 189,851 | 0% | – | 5.75% | 127 | 6 | 0.046 |
| tao5 | 5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp | 159,955 | 9% | 5.09% | 5.50% | 128 | 2 | 0.046 |
| General Tensor | 5Ggasr6fQqKZXuovBTT44GvhuoFpxBsXGPY3AUtFr9mWxGTV | 138,382 | 18% | – | 5.02% | 128 | 16 | 0.051 |
| Arbos | 5GTWwu3NCbYmVFzwfrXa1sx8y4UNLR3padWfVZwjNnDmySXP | 109,844 | 0% | 5.07% | 5.64% | 127 | 15 | 0.049 |
| Datura | 5GP7c3fFazW9GXK8Up3qgu2DJBk8inu4aK9TZy3RuoSWVCMi | 80,549 | 0.1% | 5.81% | 6.10% | 128 | 0 | 0.032* |
| xTAO | 5GcAZ4SFfghRCYqhSTaeGqmgfosWfRRtSjp5T1YxpVuNHZCV | 67,040 | 0% | 5.22% | 5.97% | 128 | 1 | 0.045 |
| 1T1B.AI | 5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5 | 53,531 | 1% | 5.80% | 6.34% | 128 | 5 | 0.047 |
| Tatsu | 5D4gEn5S422dTGR5NJJKZ93FNV6hDmfwDPfxFNgcoVnUkZ4f | 28,874 | 0% | 5.48% | 5.95% | 128 | 36 | 0.054 |
| **Tensorplex** | 5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde | 25,927 | 9% | 5.27% | 5.69% | 128 | 34 | 0.056 |

\* These fees are lower only because the claim skips many dust rows, and the claimant forfeits those slices (see below).

**What drives claim cost** (from `claim_root.rs` and `weights.rs`):
- Charged weight = `claim_root(rows redeemed + swept)` + `claim_root_scan(rows scanned)` + flushing queued credits (`PendingBasketDeposits`).
- Every basket holds 121–129 rows (128 subnets + root slot), so size barely separates validators. Queued credits do.
- Fees: about 6–14M gas × 5 gwei = τ0.045–0.069 **est.** per full claim. The docs quote τ0.057.
- **Dust forfeiture.** Rows where your slice is under τ0.0001, or the row is under min(τ1, 0.1% of NAV), are skipped if your slice is ≤ τ0.01. The skipped slice stays with other stakers. A τ0.05 claim loses **est.** 4.5–9%. Claims of τ0.5+ lose under 0.4%, except Datura (3.5%), TrustedStake (1.4%) and Tatsu (1.1%).
- **Gas limit.** `claimRootWithHotkey` fails at 51M and succeeds at 52M+. `eth_estimateGas` says 52.9–55.4M (overstated). Your 53.2M passed for all 21 hotkeys.

## 2. Claim failures and reliability

- **RootClaimTooHeavy was network-wide until 2026-10-23.** Before spec 484 the cap was 129 work units, so a full basket (129 rows + 1 hotkey = 130) was refused.
  - On 2026-10-23 (spec 483), 15 of 21 validators checked had 129 rows, including Tensorplex, tao.bot, Yuma, Datura, xTAO and 1T1B.
  - Replaying the ForeverMoney AlphaVault claim on Tensorplex: refused at blocks 9,336,371 and 9,343,571, succeeded at 9,357,971 (spec 484).
  - Commit e517bfa (2026-10-22) raised the cap to 130. Every candidate passes today.
  - Remaining risks: a subnet-limit increase without a cap bump (256 subnets would need ~62–65M gas **est.**), and `BetaBasketSeedInProgress` during migrations.
- **No slashing** code exists in the pallet. Downtime only lowers dividends, which the APYs capture. Take is capped at 18% and increases are rate-limited.
- **Take changes in 2026** (archive samples, 2025-12-31 to 2026-10-26):
  - Increases: Datura 0→0.1% (Jul), 1T1B 0→1% (Jul), WildSage 3→9% (Aug).
  - Cuts: Tatsu 7.5→5→0%, TAO.app 18→5% (Sep).
  - No changes: tao.bot, Kraken, Yuma, Taostats, TAO.com, OTF, tao5, xTAO, Tensorplex, Arbos.
- **Stake in 2026:** falling for OTF (490k→209k), Taostats, tao5, Tatsu, Arbos and General Tensor. Rising for tao.bot (822k→1.02M), Kraken, Yuma, 1T1B (30k→54k) and Datura. Crucible, General Tensor and Arbos are new hotkeys this year.
- **Concentration:** tao.bot holds 18.8% of the 5.45M τ root stake, Kraken 16.3%, Yuma 14.7%. Inside Tensorplex, 52% of its stake (13,401 τ) is one ForeverMoney vault with τ64.1 unclaimed.
- **Basket trading is on** (`BasketTradingEnabled` = true, 1/16 cap on buys), so validators now manage what unclaimed yield is held in. I could not measure who trades.
- Web search found no 2026 incidents (hacks or downtime) for these validators.

## 3. Recommendation (conservative vault)

1. **1T1B.AI.** Highest net yield on both sources (6.34% on-chain / 5.80% Taostats), 1% take, few queued credits, growing stake, small share of the network. Downside: its take rose once (0→1%).
2. **tao.bot.** 0% take, 5.91% / 5.47%, the cleanest basket (no queued credits, no sub-τ1 rows, no forfeiture), long stable record. Downside: largest validator on the network (18.8%).
3. **xTAO.** 0% take, stable, publicly listed operator. The two yield sources disagree a lot (5.97% vs 5.22%).
4. **Tensorplex (current).** Mid-pack yield (5.69% / 5.27%) with 9% take. Highest claim cost of the group (34 queued credits), and half its stake belongs to another vault. Moving to #1 or #2 adds about +0.2–0.6 pts/yr.
5. **Avoid:**
   - Datura: dust forfeiture on claims.
   - The no-identity 5Dd8ga… hotkey.
   - Kraken and Opentensor Foundation: 18% take.
   - Tatsu and Arbos: shrinking stake.

**Splitting stake across 2 validators is not worth it yet.**
- Each hotkey costs about τ0.05 per claim **est.**, and halving each claim raises dust forfeiture.
- It doesn't raise expected yield. It only hedges one validator's take hike, basket trading or blocked claims. The October block hit almost everyone, so splitting wouldn't have helped.
- Claim when owed ≥ ~τ5–10 (fee ≤ ~1%). At 6% that means about monthly once root stake is over ~2,000 τ (**est.**).
- Consider a second hotkey (e.g., 1T1B + tao.bot) above roughly 5,000–10,000 τ (**est.**).
- For the $20 test, a claim will cost more than it collects. Do one claim only to prove the mechanics.

## Sources
- Code (opentensor/subtensor): [claim_root.rs](https://github.com/opentensor/subtensor/blob/main/pallets/subtensor/src/staking/claim_root.rs), [lib.rs](https://github.com/opentensor/subtensor/blob/main/pallets/subtensor/src/lib.rs), [weights.rs](https://github.com/opentensor/subtensor/blob/main/pallets/subtensor/src/weights.rs), [run_coinbase.rs](https://github.com/opentensor/subtensor/blob/main/pallets/subtensor/src/coinbase/run_coinbase.rs), [commit e517bfa](https://github.com/opentensor/subtensor/commit/e517bfa68).
- Docs: [Root Reborn](https://www.bittensor.com/docs/guides/root-reborn), [RootClaimTooHeavy](https://www.bittensor.com/docs/errors/chain/RootClaimTooHeavy), [Own Your Mind, 11 Aug](https://buttondown.com/ownyourmind/archive/root-reborn-shipped-with-its-headline-feature-off/).
- Taostats APYs: [taostats.io/yield](https://taostats.io/yield), as given in the brief.
- Live RPC reads (storage, runtime API, `cast call/estimate` on 0x…0805). Scripts and data are in this scratchpad's `scripts/` and `out/` folders.
