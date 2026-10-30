# Competitive landscape: Bittensor subnet index vault (cascadefi.xyz)

Research date: 2026-10-20. Items dated 2025 or earlier are labeled. Several sources conflict and that is flagged inline. Market context used throughout:
- TAO market cap was about $2.4B in May–June 2026 — [FalconX, May 13 2026](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure); [Cointelegraph, Jun 27 2026](https://cointelegraph.com/news/yuma-bittensor-fund-institutional-tao-decentralized-ai). TAO fair value was $202.57 on Jun 30 2026 (Coinbase principal market) — [Grayscale Bittensor Trust 10-Q, Q2 2026](https://www.sec.gov/Archives/edgar/data/0002029297/000202929726000006/gtao-20260630.htm).
- Combined subnet (alpha) value estimates conflict: Yuma says the 128 subnets are worth more than $900M, while Taostats data puts it closer to $300M (June 2026) — [Cointelegraph](https://cointelegraph.com/news/yuma-bittensor-fund-institutional-tao-decentralized-ai). CoinGecko put total alpha market cap at about $1.12B in March 2026, about 27% of TAO's market cap — [CoinGecko](https://www.coingecko.com/learn/top-bittensor-subnets-dtao).
- There are 128 subnets (64 at the dTAO launch). The top 10 hold 32% of the "sum of subnet prices". Only 4 subnets have $1M+ of AMM depth at 2%. 67 of 128 subnets burned 99%+ of incentives as of Apr 16 2026. About 49.6% of TAO is staked to root and 21.3% to subnets (May 1 2026) — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).
- Shock event: in April 2026 Covenant (Templar, Grail, Basilica, three top-15 subnets) left Bittensor and sold all its subnet tokens. Those subnets fell up to 40% almost immediately and TAO fell 24% within hours — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).

## Q1/Q2: Which Bittensor subnet index or basket products exist, and how does each work (custody, chain, selection, rebalancing, fees, AUM, launch, status, sentiment, incidents)?

### Takeaway
As of Oct 2026 I found **no permissionless, tokenized, on-chain subnet-index token or vault on Base or any EVM chain**. Diversified subnet exposure exists in three forms:
1. **Institutional, off-chain funds.** Yuma (DCG) runs the Subnet Composite, Large Cap and Total Market funds, for accredited and institutional investors only.
2. **TAO-native, proxy-based auto-allocators on Bittensor.** Mentat Minds "Bundles" and one-click strategies, Crucible Smart Allocator, Stakao, and the Taostats "Balance/Automate" modes.
3. **The protocol's own root-staking "baskets" (Root Reborn).** Bittensor docs describe these as "an escrowed index fund of subnet alpha" run by each root validator. They shipped Aug 4 2026, but validator curation was switched off at launch.

All TAO ETPs and ETFs, and all treasury companies, are single-asset TAO, not subnet baskets. Cross-chain products (Rubicon xAlpha, Latent vAlpha, TaoFi) give single-subnet exposure only.

### Cited Findings

**A. Native protocol: root staking "baskets" (Root Reborn). Arguably the closest functional competitor.**
- Bittensor docs: "each root validator runs an escrowed index fund of subnet alpha". Root stakers "accrue an entitlement to that fund in proportion to their root stake". The basket is built from validator dividends, held on the subnets where they were earned, and changed only by the validator's `swap_basket` trades — [Bittensor Docs: Staking](https://www.bittensor.com/docs/guides/staking).
- Claiming: a full-basket claim costs about τ0.057, and a dry run warns if the fee exceeds accrued yield. Payouts under 500,000 rao keep accruing. Moving TAO in or out of root skips pool swaps, so there is no slippage or MEV — [Bittensor Docs](https://www.bittensor.com/docs/guides/staking).
- Root Reborn shipped as runtime v441 on **4 Aug 2026**. The curation layer was "gated off at launch", so every basket runs a null accumulate-in-place strategy until a later upgrade. Root yield "now accrues in per-validator escrowed basket funds and is realised only when a root staker claims". Previously, root yield in alpha "used to be sold to TAO mechanically every block" — [Own Your Mind newsletter, Aug 11 2026](https://buttondown.com/ownyourmind/archive/root-reborn-shipped-with-its-headline-feature-off/).
- Conflicting dates: some coverage said it went live **Jun 17 2026**, while other mid-June coverage said it was still a proposal. One source describes a minimum of 8 basket destinations when curation is enabled — [KuCoin flash](https://www.kucoin.com/news/flash/bittensor-launches-root-reborn-to-optimize-tao-yield); [Bittensor release page](https://www.bittensor.com/releases/root-reborn).
- Yuma, a large validator, publicly opposed Root Reborn over governance, regulatory and conflict-of-interest risks — [LBank news](https://www.lbank.com/news/bittensor-validator-warns-root-reborn-proposal-carries-substantial-risks).
- Root stakers may earn up to about 10% while top subnets can pay 40%+ (May 2026) — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).

**B. Off-chain institutional subnet funds: Yuma Asset Management (DCG).**
- On Oct 9 2025 (2025 item), Yuma, a DCG company, launched Yuma Asset Management with a **$10M DCG anchor** for institutional and accredited investors. Flagship funds:
  - **Yuma Subnet Composite Fund:** market-cap-based, covers all active subnets, described as a "NASDAQ Composite" for subnets.
  - **Yuma Large Cap Subnet Fund:** more targeted, described as a "Dow Jones" analogue.
  - Sources: [Business Wire, Oct 9 2025](https://www.businesswire.com/news/home/20251009638800/en); [FXStreet](https://www.fxstreet.com/cryptocurrencies/news/bittensor-price-forecast-tao-rallies-amid-yuma-asset-management-launch-with-flagship-funds-202510101127).
- **Yuma Total Market Fund** was announced around late June 2026 (Cointelegraph article dated Jun 27 2026). It holds TAO plus "a basket of AI-focused subnets" in one vehicle, for institutional investors, with seed capital from an undisclosed anchor. Fees, minimums, AUM and rebalance schedule were not disclosed — [Cointelegraph](https://cointelegraph.com/news/yuma-bittensor-fund-institutional-tao-decentralized-ai); [Crucible Labs substack, Jul 1 2026](https://cruciblelabs.substack.com/p/kraken-opens-the-door-to-bittensor).
- A 13F aggregator lists a "Yuma Total Market Fund LP" with Yuma Holdings LLC and Yuma Funds GP LLC — [aum13f](https://aum13f.com/fund/yuma-total-market-fund-lp).
- **Yuma Composite Index (YCX):** a market-cap-weighted benchmark of every active subnet. It launched in Sept 2025 at a base of 1,000 and was about 1,095 (+9.5%) at the time of writing (undated) — [Alea Research](https://alearesearch.substack.com/p/yuma-composite-index-benchmarking).

**C. TAO-native retail auto-allocators and basket tools (on Bittensor, TAO-in, proxy model).**
- **Mentat Minds.**
  - The app lets users pick from "Bundles" or "Subnets" (filters: Core, Sectors, Teams), choose an "investment speed", and use "One-click strategies". The site says "Mentat takes care of the allocation and rebalancing" and "will handle transactions and slippage for you through a staking proxy" — [mentatminds.com](https://www.mentatminds.com/).
  - FAQ: APY is shown net of fees, there is no entry or exit fee, a "small performance fee" applies, and there is no lock-up — [Mentat Minds FAQ](https://mentat-minds.notion.site/FAQ-26f8856d75f04ffb8791a918316cd37c).
  - Mentat+ (custom portfolio construction for subnet staking) reportedly launched Oct 26 2025 (2025 item; paywalled source) — [Subnet Edge](https://subnetedge.substack.com/p/bittensors-financial-infrastructure).
  - Taostats' "Automate" mode routes stake through Mentat. Taostats warns that staking with Mentat is "all or nothing" and that the wallet's staking is "100% controlled" by Mentat. This contradicts Mentat's "non-custodial" framing — [Taostats docs](https://docs2.taostats.io/concepts/taostats-staking-app/).
- **Crucible Labs (Crucible Wallet).**
  - A non-custodial Chrome-extension wallet. Its "Smart Allocation" uses a proxy that can stake **only rewards** (never principal) to leading subnets, or to subnets the user picks. It has Ledger support and claims an independent audit.
  - Chrome Store: 4.4 stars from 13 ratings, about 5,000 users — [Chrome Web Store](https://chromewebstore.google.com/detail/capjnhbneiilplogojhmhepiocnjpgee).
- **Stakao.**
  - "Stake TAO without leaving your wallet" through a staking-only permission that cannot transfer TAO and can be revoked. The Premium plan offers "AI-picked subnets" with "built-in risk management".
  - Fees: Free plan EUR 0; Premium **EUR 19/month or EUR 168/year**. It "never takes a cut of your staking rewards".
  - Minimum 2 TAO to activate. Wallets: Talisman, SubWallet, Nova, Polkadot.js — [stakao.com](https://stakao.com/bittensor-staking).
- **Taostats Staking App.** Modes are Simple, Manual, Balance (proportional sliders across subnets, with locks) and Automate (via Mentat). There is a max-slippage setting. "Taostats does not charge for staking or unstaking", only chain fees — [Taostats docs](https://docs2.taostats.io/concepts/taostats-staking-app/).

**D. Single-asset TAO ETPs, ETFs and trusts (not subnet baskets).**
- **Grayscale Bittensor Trust (GTAO).**
  - As of Jun 30 2026: **46,331.54 TAO**, **NAV $9.385M**, $3.85 NAV per share, 2,438,600 shares.
  - **Sponsor fee 2.5%/yr.** OTCQX-quoted since Dec 12 2025. Creations only (sole AP), no redemption program. Custodian: BitGo — [Grayscale 10-Q Q2 2026](https://www.sec.gov/Archives/edgar/data/0002029297/000202929726000006/gtao-20260630.htm).
  - An S-1 to uplist to NYSE Arca as an ETF was filed Dec 30 2025, with an amendment in April 2026. A Jan 12 2026 trust amendment permits staking, but the S-1/A said no staking was happening yet — [S-1/A](https://www.sec.gov/Archives/edgar/data/2029297/000119312526140409/gtao_s-1_amendment_1.htm); [8-K Jan 2026](https://www.sec.gov/Archives/edgar/data/2029297/000119312526015365/tao-20260112.htm).
  - I found no confirmation of ETF approval or listing as of Oct 2026. The SEC decision was "expected August 2026" — [BlockEden, May 2026](https://blockeden.xyz/blog/2026/05/02/grayscale-bitwise-tao-etf-filings-decentralized-ai-token-wall-street).
- **Grayscale's AI fund** raised its TAO weight to 43.06% on Apr 7 2026 — [Bitget news](https://www.bitget.com/news/detail/12560605374117).
- **Bitwise TAO Strategy ETF.** Filed Dec 31 2025 as one of 11 "strategy" ETFs. It would hold up to 60% spot TAO and the rest in TAO ETPs. Approval or launch is unconfirmed — [CoinDesk](https://www.coindesk.com/markets/2025/12/31/bitwise-files-for-11-strategy-etfs-tracking-tokens-including-aave-zec-tao); [The Block](https://www.theblock.co/post/384026/bitwise-crypto-strategy-etfs).
- **Europe (2025 items).**
  - Deutsche Digital Assets and Safello: **STAO** staked-TAO ETP on SIX (around Nov 2025), fee up to **1.49%** — [AMBCrypto](https://ambcrypto.com/assessing-bittensors-23-jump-as-europe-launches-first-tao-etp/); [FXStreet](https://www.fxstreet.com/amp/cryptocurrencies/news/bittensor-price-forecast-safellos-staked-tao-etp-boosts-momentum-bulls-aim-for-500-202510300453).
  - Virtune: **VIRTAO** on Nasdaq Stockholm (Dec 19 2025), **1.95%** fee — [Cryptonomist](https://en.cryptonomist.ch/2025/12/19/bittensor-etp-nasdaq-stockholm/).
  - I found no ETP holding a basket of subnet tokens — [same search results; AMBCrypto](https://ambcrypto.com/assessing-bittensors-23-jump-as-europe-launches-first-tao-etp/).
- **CoinDesk 20** added TAO in its April 2026 rebalance at a 0.60% weight. This is index-level TAO exposure, not subnets — [WisdomTree](https://www.wisdomtree.com/ch/it/insights/blog/crypto-ai-enters-the-index-april-2026-rebalance).

**E. TAO treasury companies (TAO only; holdings are mostly 2025 figures and likely stale).**
- **Oblong → TaoWeave (Nasdaq: TWAV, renamed Dec 10 2025):** 21,613 TAO, all staked, by mid-2025 — [The Block](https://www.theblock.co/amp/post/366010/nasdaq-listed-bittensor-treasury-company-oblong-stakes-8-million-of-token); [Barchart](https://www.barchart.com/story/news/34147947/oblong-reports-q2-2025-results-and-expands-8m-tao-treasury-to-power-decentralized-ai).
- **TAO Synergies (Nasdaq: TAOX, formerly Synaptogenix):** bought 29,899 TAO for $10M (2025) — [roic.ai](https://www.roic.ai/quote/TAOX); [SEC exhibit](https://www.sec.gov/Archives/edgar/data/746210/000143774925022766/ex_838946.htm).
- **xTAO (TSXV):** claimed to be the largest public TAO holder at 41,538 TAO (2025) — [Yahoo Finance](https://uk.finance.yahoo.com/quote/TAOX).

**F. Searches that turned up nothing.** I found no product or index named "TSBCSI", "Tao20" or "Tao Accelerate", and no Safety Shot link to TAO. See Gaps.

### Inferences
- The only true diversified-subnet "index" products are (a) Yuma's gated funds, (b) TAO-denominated proxy allocators that require a Bittensor wallet and TAO, and (c) native root baskets. None is a USDC-in, ERC-20-out, permissionless vault on Base. That is the white space for cascadefi.xyz.
- Root Reborn is a strategic threat. If validator basket curation is enabled, every root validator effectively becomes an index manager with zero swap slippage on entry and TAO-denominated principal. cascadefi.xyz should position as "USDC-native, on Base, transparent rules-based alpha exposure" rather than competing on TAO-native yield.
- Fee benchmarks in this niche: ETPs charge 1.49–2.5%/yr (Grayscale 2.5%, Virtune 1.95%, STAO up to 1.49%). Mentat takes a "small" performance fee. Stakao charges a flat EUR 168/yr. Taostats charges nothing. A 0.5–1.0% management fee, or a small performance fee, would be competitive with the ETPs. Retail Bittensor users are used to near-zero platform fees.
- Grayscale's TAO trust is tiny ($9.4M NAV). This suggests weak traditional-finance demand for TAO wrappers so far, or that the 2.5% fee and OTC structure deter buyers.

### Gaps
- No public AUM, fees, minimums, holdings or rebalance rules for any Yuma fund. The Business Wire release could not be fetched (403).
- One search result said TAO Synergies announced an initial $750K investment into Yuma's subnet funds (2025). I could not trace it to a primary source, so it is unverified.
- Mentat Minds' exact performance-fee percentage, AUM and bundle methodology are not public in the sources I could access.
- "TSBCSI", "Tao20" (as a Bittensor index), "Tao Accelerate" and a "Safety Shot / xTAO" link could not be found. They may not exist, may be very small, or may be misremembered names.
- I found no confirmation of whether the Grayscale GTAO ETF or the Bitwise TAO Strategy ETF launched after the August 2026 decision window.
- I found no 2026 TAO-holding updates for TaoWeave, TAO Synergies or xTAO.
- I found no reports of security incidents specific to Mentat, Crucible, Stakao, Rubicon or TaoFi. General Bittensor incidents noted include a malicious PyPI package attack and a May 2025 "runaway batch call" overload — [kollab3 substack](https://kollab3.substack.com/p/bittensor-ecosystem-deep-dive-how).

## Q3: Adjacent products for USDC/ETH-on-Base users, and the easiest current path to staked subnet exposure for a Coinbase/Base user

### Takeaway
A Base user today can (1) use **TaoFi** to swap USDC into a single subnet's staked alpha in one flow, via Hyperlane and Sturdy SN10, or (2) buy **Rubicon xAlpha** ERC-20s (17 subnets at launch) on Aerodrome. Either way the user picks the subnets and rebalances by hand. Liquidity is thin: about $215K in TaoFi's TAO/USDC pool on Bittensor EVM, and about $250K of TAO liquidity on Base. Coinbase lists spot TAO but not subnet tokens. Kraken has subnet tokens on its roadmap, but they are not confirmed live.

### Cited Findings
- **TaoFi** (launched May–Aug 2025, a 2025 item).
  - Uses Hyperlane Warp Routes plus Interchain Accounts, and Sturdy SN10 routing on the backend. USDC from **Base and Ethereum** is bridged to Bittensor EVM, swapped to TAO, then to the target alpha. Solana was "planned". Users keep custody. Fees are not stated — [Hyperlane, May 27 2025](https://hyperlane.xyz/post/hyperlane-unlocks-the-bittensor-ecosystem).
  - The flow is: Base USDC → Bittensor EVM → Uniswap v3 TAO pool → stake into the chosen subnet. Built by Sturdy/SN10 contributors at taofi.com — [Bankless](https://www.bankless.com/de/read/bittensor-base-taofi-tokens).
  - TaoFi uses Hyperlane ICAs to control a smart wallet on Bittensor EVM for the user, with no new wrapped tokens. Exit runs alpha → TAO → USDC back to Base in one flow — [subnetalpha.ai](https://subnetalpha.ai/?p=425).
  - TaoFi's TAO/USDC Uniswap V3 pool on BT EVM had **$215K** liquidity and **no alpha pairs** (May 22 2026) — [Manifold Labs](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere).
  - I found no 2026 volume or user data.
- **Project Rubicon / xAlpha** (General TAO Ventures; announced Nov 19–22 2025).
  - Non-custodial liquid staking of subnet alpha into **xAlpha ERC-20s on Base**, minted 1:1. Bridged via **Chainlink CCIP**. Partners: Chainlink, Base and Aerodrome.
  - 17 subnets at launch: SN120 Affine, SN8 PTN, SN4 Targon, SN9 iota, SN62 Ridges, SN35 Cartha, SN34 Bitmind, SN44 Score, SN17 404-Gen, SN64 Chutes, SN56 Gradients, SN51 Lium, SN50 Synth, SN41 Sportstensor, SN46 Resi, SN65 TPN, SN71 Leadpoet.
  - **$300K initial liquidity per subnet**, in xAlpha/USDC pools on Aerodrome — [Cryptoast](https://cryptoast.fr/desormais-possible-acheter-tokens-subnets-bittensor-base/); [CoinCentral](https://coincentral.com/chainlink-price-shows-potential-surge-following-tao-ventures-rubicon-launch/).
  - Hashlock pen-test and smart-contract audits (Oct 2025) were rated "Secure". GTV intends its "LSA Bridge" to become the canonical TAO-ecosystem staking solution — [Hashlock](https://hashlock.com/audits/rubicon).
  - I found no 2026 TVL or volume data for xAlpha.
- **Latent (vAlpha, vTAO).** Rubicon and Latent created ERC-20 wrappers for staked alpha (xAlpha, vAlpha, vTAO), described as "audited and functional". The only trading venue for wrapped alpha is a bridge to Base, where swap fees accrue to Aerodrome LPs — [Manifold Labs, May 2026](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere). vTAO is a liquid staking token for TAO on Bittensor EVM, bridged through the TAO.app bridge page — [Learn Bittensor guide](https://guides.learnbittensor.org/evm-tutorials/vtao-bridge-tutorial).
- **wTAO** is a community-created wrapper "not officially supported by Bittensor" — [Learn Bittensor FAQ](https://learnbittensor.org/faq). TAO on Base shows about **$250K pool liquidity** (undated) — [DexPaprika](https://dexpaprika.com/base/token/0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67).
- **Tensorplex stTAO** (TAO liquid staking; 2024–25 product). TVL figures conflict:
  - DefiLlama shows about **$221.7K** TVL — [DefiLlama](https://defillama.com/protocol/tensorplex).
  - A Sturdy governance post (undated) claims 26,000+ TAO in stTAO — [Sturdy forum](https://gov.sturdy.finance/t/onboard-tensorplex-staked-tao-silo-on-sturdy/154).
  - stTAO market cap was about $2.46M in late Jul 2026 — [iocharts](https://iocharts.io/hu/crypto/tensorplex-staked-tao).
- **Coinbase:** listed TAO in Feb 2025. A July 2026 report says Coinbase announced TAO spot support with an "experimental" label — [BeInCrypto](https://beincrypto.com/coinbase-lists-bittensor-tao-price-spike/); [MEXC repost](https://www.mexc.com/news/1197892). I found no Coinbase subnet-token or Base-native cbTAO product.
- **Kraken:** the official blog (Jul 3 2026) put Chutes, Hippius, Lium, Score, Targon, Ridges AI and Vanta on its roadmap and said it "will begin listing subnet tokens in the near future", with geographic restrictions — [Kraken Blog](https://blog.kraken.com/product/new-features/bittensor-subnet-tokens). Secondary outlets reported them as "listed", which conflicts with the blog — [Crypto Briefing](https://cryptobriefing.com/kraken-lists-bittensor-subnet-alpha-tokens/). Kraken is the second-largest root validator by TAO staked — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).
- **Structural limits.** Contracts on Base cannot read BT EVM precompile data (subnet deregistration, emission schedules). Vaults "need a pool to rebalance through"; without one, "only single-asset staking wrappers are possible". Lending and yield routing are blocked for the same reason — [Manifold Labs](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere).

### Inferences
- The easiest Base-native path today is TaoFi (USDC → one subnet's staked alpha) or buying xAlpha on Aerodrome. Both are single-subnet bets, need manual portfolio construction, and suffer from thin pools.
- A Base vault for cascadefi.xyz probably cannot hold xAlpha for most of its index and rebalance on Base efficiently, because of Aerodrome depth and the 17-subnet coverage. The more realistic design is a Base-side ERC-4626 share token with execution on Bittensor, via a Hyperlane ICA as TaoFi does, or via a keeper or proxy. That adds bridge and keeper trust assumptions, which must be the centerpiece of the "security-first" story.
- Coinbase users can buy TAO but have no direct subnet product. An ETF wrapper for subnets is not on the horizon in any filing I found.

### Gaps
- I found no data on Hyperliquid TAO perp markets or open interest. Searches returned only general HIP-3 data.
- No current TaoFi fees, TVL or user counts.
- No current xAlpha supply, TVL or Aerodrome pool depth.
- No confirmation of whether Kraken subnet-token trading went live between July and October 2026.

## Q4: Analogous index-vault products in other ecosystems (UX/design lessons, success and failure factors, fee norms)

### Takeaway
Index Coop's DPI proved demand for one-token sector baskets (about $133M AUM and 13,000+ holders at its peak era, around 2021) but relied on unsustainable liquidity mining. Reserve's Index Protocol (Feb 2025; DTFs on Base and Ethereum) is the current template for permissionless on-chain index tokens with on-chain fee caps. Morpho's curated vaults set the norm of a roughly 10% performance fee and timelocked parameters.

### Cited Findings
- **Index Coop DPI** (2020–21 items).
  - Launched Sept 2020 by DeFi Pulse with Set Labs and Index Coop. Holders can redeem DPI for the underlying tokens at any time — [Hackernoon](https://hackernoon.com/what-is-the-the-defi-pulse-index-get-on-the-beat).
  - Rebalancing is monthly by market cap per the Tally wiki; another site says quarterly — [Tally](https://docs.tally.xyz/user-guides/index-of-daos/daos-not-on-tally/index-coop-index).
  - DPI had **$133M AUM and 13,000+ holders** (undated, likely 2021) — [Bankless](https://www.bankless.com/es/building-a-decentralized-blackrock-639070caed39286b12323258).
  - May 2021 DPI revenue was $144K. The treasury was concentrated in the INDEX token — [Index Coop financial report May 2021](https://indexcoop.substack.com/p/index-coop-financial-report-may-2021).
  - Liquidity-mining rewards were judged "unsustainable long term" — [overanalyser](https://overanalyser.substack.com/p/of-whales-and-shrimps-a-uniswap-pool).
  - DPI fell about 38% from its high in a 2021 crash — [Index Coop](https://indexcoop.substack.com/p/navigating-the-volatility-with-index).
  - The Q1 2021 target was $200M AUM, with $75M of unincentivized TVL — [Index Coop OKRs](https://git.instadapp.io/Instadapp/boardroom-inc-protocol-Info/blame/branch/updates1/indexCoop/Operations/Q1%202021%20-%20OKRs.md).
- **Reserve Index Protocol (DTFs).**
  - Launched Feb 25 2025 with 12 index DTFs, including the Bloomberg Galaxy Crypto Index, CoinDesk DeFi Select, MarketVector Token Terminal Fundamental (by Re7), and the **Virtuals Index** — [FinanceMagnates](https://www.financemagnates.com/thought-leadership/reserve-launches-index-protocol-bloomberg-indices-coindesk-indices-and-marketvector/); [FXEmpire](https://www.fxempire.com/press-release/article/reserve-launches-index-protocol-bloomberg-indices-coindesk-indices-marketvector-and-more-join-launch-1500202).
  - Fee types are TVL (annual) fee, mint fee and platform fee, with 100% of the platform fee going to RSR buyback and burn. Reported TVL was about **$46.88M** (DefiLlama snapshot, undated) — [DefiLlama](https://defillama.com/protocol/reserve-protocol).
  - Index DTF fee caps are reportedly 10% TVL fee and 5% mint fee (single unverified source). Index DTFs are governed by any token holder with vote-locking — [rfp.wiki](https://www.rfp.wiki/vendors/reserve-protocol); [OneKey](https://onekey.so/blog/ecosystem/rsr-deep-dive-tokenomics-recent-developments-and-outlook).
  - Europe's first on-chain index (Compass Financial Technologies and Venionaire) was built on Reserve — [Venionaire](https://www.venionaire.com/compass-financial-technologies-and-venionaire-capital-ag-announce-europes-first-onchain-index-powered-by-reserve/).
- **Morpho curated vaults.**
  - Steakhouse- and Gauntlet-curated USDC vaults show a **10% performance fee**, with some at 0% — [Trading Strategy](https://tradingstrategy.ai/vaults/gauntlet-usdc).
  - Curator fees are typically 5–15% of earned yield — [EarnPark](https://earnpark.com/en/posts/morpho-apy-fees-interest-rates-explained-2026/).
  - On Morpho v1 the fee cap is 50% of interest, and fee changes take effect immediately with no timelock. On Morpho v2, fee parameters are timelocked — [Gauntlet Vaultbook](https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/vault-fees).
  - One Gauntlet USDC vault's TVL fell more than 95% from its peak — [Trading Strategy](https://tradingstrategy.ai/vaults/gauntlet-usdc).

### Inferences
- Success factors to borrow:
  - one-token simplicity
  - redeemability for the underlying or NAV
  - published, rules-based methodology with a credible index brand (DPI–DeFi Pulse; Reserve–Bloomberg and CoinDesk)
  - on-chain fee caps
  - timelocked parameter changes
- Failure factors to avoid:
  - TVL bought with token incentives
  - sector drawdowns with no risk controls
  - governance-token treasury concentration
  - curators able to change fees instantly
- Fee norms: on-chain index tokens charge streaming or TVL fees roughly in the 0.5–2%/yr range, though I did not verify the exact DPI or Reserve rates (see Gaps). Yield vaults charge about 10% of yield. Subnet staking yield is large (top subnets 40%+; root up to about 10%), so a performance-fee-on-emissions model, Morpho-style, may fit better than a pure AUM fee.

### Gaps
- I could not verify DPI's streaming fee (commonly cited as 0.95%, unconfirmed here), its peak date or AUM, or its later decline or deprecation.
- No sourced data on Enzyme or Set Protocol fees, status or lessons.
- No Base-specific Reserve DTF TVL, or the actual fee settings of the Virtuals Index DTF.

## Q5: What market gaps could a simple, security-first, self-running index vault on Base fill?

### Takeaway
No product combines (1) USDC or ETH deposits on Base, (2) a diversified, rules-based basket of top subnets, (3) automatic rebalancing, (4) a transferable ERC-20 or ERC-4626 share, and (5) retail, non-accredited access. Every competitor misses at least two of these. The binding constraints are thin alpha liquidity, cross-chain execution risk, and subnet idiosyncratic risk (team exits, burned incentives). A security-first design that handles these openly is the differentiator.

### Cited Findings
- Diversified products are either gated (Yuma: institutional or accredited), TAO-native and proxy-controlled (Mentat: staking "100% controlled"), or native root baskets with curation still off — [Cointelegraph](https://cointelegraph.com/news/yuma-bittensor-fund-institutional-tao-decentralized-ai); [Taostats docs](https://docs2.taostats.io/concepts/taostats-staking-app/); [Own Your Mind](https://buttondown.com/ownyourmind/archive/root-reborn-shipped-with-its-headline-feature-off/).
- Base-side products are single-subnet only (xAlpha, vAlpha, TaoFi). A Manifold Labs analysis says no vault or index can exist without a rebalancing pool — [Manifold Labs](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere).
- Liquidity constraint: only 4 subnets have $1M+ of 2% AMM depth. 42 subnets get chain buys of up to 330 TAO/day (about $92K). Subnet prices showed an apparent 0.10 TAO ceiling — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).
- Quality and idiosyncratic risk: 67 of 128 subnets burned 99%+ of incentives. Covenant's April 2026 exit sank its subnets up to 40%. Over one-third of subnets have volume driven mostly by their top 20 holders — [FalconX](https://www.falconx.io/newsroom/state-of-bittensor-subnet-adoption-trends-network-mechanics-and-covenants-departure).
- Revenue trend: about 14 subnets had launched revenue-driven alpha buybacks, expected to reach 20–25 by year-end (2026) — [KuCoin](https://www.kucoin.com/news/flash/bittensor-enters-revenue-era-with-24-25-subnets-generating-income).
- Execution security: staking is a swap with slippage, so use quotes and limit variants (`add-stake-limit`, `remove-stake-limit`), MEV-shielded submission, and **delayed proxies**. A "zero-delay Staking proxy can drain value through repeated high-slippage round trips". There is no unbonding period — [Bittensor Docs](https://www.bittensor.com/docs/guides/staking).
- Pre-Taoflow, emissions could be gamed by pumping a subnet's alpha. Taoflow (Nov 2025) changed this. Alpha in subnets with negative staking flow "can go to zero quickly" — [defi0xjeff](https://defi0xjeff.substack.com/p/survive-and-thrive-in-bittensor-ecosystem).
- Retail fee expectations are low: Taostats charges nothing, Stakao charges a flat EUR 168/yr, and Mentat takes a "small performance fee". TradFi wrappers charge 1.49–2.5% — sources as cited in Q1.

### Inferences
Candidate differentiators for cascadefi.xyz:
1. **USDC-in and USDC-out on Base** with an ERC-4626 share token. Coinbase Smart Wallet and Base users never touch a Bittensor wallet.
2. **Transparent, rules-based Top-N index** with liquidity-aware caps (weight capped by pool depth), an exclusion screen (e.g., incentive-burn ratio, deregistration risk, team-sale events), and a published methodology. YCX and Yuma Large Cap show the market accepts "composite vs large-cap" framing.
3. **Security story as the product:**
   - timelocked parameters (unlike Morpho v1's instant fee changes)
   - delayed and limited staking proxies
   - slippage-bounded limit-stake rebalances
   - a minimal bridge surface (Hyperlane ICA or CCIP)
   - audits and on-chain proof of reserves on the Bittensor side
   - circuit breakers for team-exit events like Covenant's
4. **Fee positioning:** below ETPs (under 1%/yr) or a modest share of staking emissions, with no lockups.
5. **Possible strategic hedge:** build on, or be compatible with, Root Reborn baskets once curation is enabled, or route part of the index through root stake to cut slippage.

Key risks to the opportunity:
- The total subnet market is small (about $300M–$1.1B depending on the source).
- Liquidity is thin, which caps how much AUM can enter without moving prices.
- Native root baskets or Kraken listings could commoditize simple diversified exposure.
- Regulatory exposure of a US-facing pooled index product (not researched here).

### Gaps
- No data on retail demand, such as surveys or Reddit sentiment on wanting a subnet index. I did not fetch r/bittensor_ threads.
- Unknown whether Root Reborn curation has since been enabled (after Aug 2026).
- No legal or regulatory analysis of a pooled subnet vault on Base.
