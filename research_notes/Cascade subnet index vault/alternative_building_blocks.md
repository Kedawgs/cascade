# Alternative Building Blocks (Infrastructure Rails) for a Base-Native Bittensor Subnet Index Vault

Research date: 2026-10-20. Several facts below were taken from live on-chain APIs and registries on 2026-10-20: DexScreener, GeckoTerminal, the ForeverMoney proof-of-reserves API, the Hyperlane registry git HEAD, the LayerZero metadata API, the CCIP directory HTML, the Relay, LI.FI, Across, deBridge, Squid and Gas.zip APIs, and the Hyperliquid info API. They are point-in-time snapshots and will drift. "Verified" means read from docs, code, a registry or an explorer/API. "Inference" means my reasoning.

Note on scope: TaoFi, staking mechanics, competitors, security and UX/regulation are covered by other researchers. This file covers only alternative or complementary rails.

---

## Q1. Tokenized subnet alpha (and TAO) on Base and other chains: what exists, how it is backed, how liquid it is, and can an index vault live entirely on Base?

### Takeaway
Base has two live families of bridged alpha tokens, both using Chainlink CCIP:
- **General TAO Ventures' Project Rubicon "xAlpha" (xSN*)**: about 20 subnets. Yield accrues through an exchange rate.
- **ForeverMoney's 1:1 CCIP-bridged TAO plus a handful of alpha tokens**: SN10, SN78, SN80 and SN120 on Base.

As of 2026-10-20, Base-side liquidity for every alpha token is tiny, roughly $0 to $113k per pool. Most Rubicon pools are effectively empty. Only CCIP-bridged TAO has meaningful depth, about $445k across two pools.

So a vault that only buys alpha on Base secondary markets is not viable beyond hobby size. A Base-front-end vault is plausible only if a keeper mints and redeems these tokens against native alpha on Bittensor, which brings the cross-chain hop back in. Other wrappers are either not on Base or thin/defunct: Tensorplex stTAO, Wormhole canonical TAO (Solana), VoidAI (Solana) and Hyperliquid HTAO.

### Cited Findings

**Project Rubicon / xAlpha (General TAO Ventures + Chainlink)**
- Launched/announced on November 19, 2025. Aerodrome launched the first xAlpha/USDC pools. CCIP is described as the "canonical" cross-chain infrastructure. The bridge is described as "non-custodial" liquid staking and as "audited and certified by Hashlock". — [PR Newswire](https://www.prnewswire.com/news-releases/general-tao-ventures-launches-project-rubicon-to-bridge-bittensor-subnets-to-global-web3-markets-302619285.html)
- There were 17 launch subnets, each starting with about $300,000 of Alpha/USDC liquidity:
  - Affine (SN120), PTN (SN8), Targon (SN4), iota (SN9), Ridges (SN62), Cartha (SN35)
  - Bitmind (SN34), Score (SN44), 404-Gen (SN17), Chutes (SN64), Gradients (SN56), Lium (SN51)
  - Synth (SN50), Sportstensor (SN41), Resi (SN46), TAO Private Network (SN65), Leadpoet (SN71)
  - The release names no fee rates, unstaking terms or validator operators.
  - [PR Newswire](https://www.prnewswire.com/news-releases/general-tao-ventures-launches-project-rubicon-to-bridge-bittensor-subnets-to-global-web3-markets-302619285.html)
- **Minting/redemption:** users deposit mainnet Alpha or TAO into the bridge to mint xAlpha on Subtensor EVM. They redeem by burning xAlpha for the underlying Alpha or TAO. Pricing is `xAlphaPrice = alphaBalance / xAlphaMinted * alphaPrice`. Bridging from Subtensor EVM to other networks (Base, Ethereum, Hyperliquid, Avalanche named as examples) uses CCIP. — [Rubicon docs overview](https://docs.rubiconbridge.io/)
- **Custody and yield:**
  - The EVM contract is the custody address on Subtensor and has no private key. Funds move only through on-chain logic via the stakingV2 precompile.
  - Emissions accrue to the contract's SS58 address. Yield shows up as an increasing xAlpha:Alpha exchange rate, read live via `getStake()`, with "no cross-chain messaging and no off-chain rebasing oracle".
  - The docs also use the phrase "Automatic Rebasing", which is ambiguous next to the exchange-rate model.
  - [Rubicon architecture](https://docs.rubiconbridge.io/product/architecture.md); [Rubicon overview](https://docs.rubiconbridge.io/)
- **Executive summary (undated, probably pre-launch):**
  - "Staking logic runs off-chain, integrating with Subtensor RPC and Bittensor validators".
  - Deposit, withdrawal and protocol fees are "currently under design".
  - "Multisig deployments are planned". CCIP integration is "work in progress". xTAO is "planned".
  - Subnet communities can create staking pools for their own Alpha.
  - [Rubicon executive summary](https://docs.rubiconbridge.io/product/executive-summary.md)
- **Audits:** Hashlock lists two Rubicon reports, both dated October 2025 and both rated "Secure": a penetration test (TypeScript) and a smart-contract audit (Solidity). The public page gives no scope, findings or admin-key analysis. — [Hashlock](https://hashlock.com/audits/rubicon)
- **Contract addresses (verified from docs):**
  - Rubicon publishes a Subtensor EVM token, a Base token, a Subtensor EVM pool and a Base pool for xTAO and for xSN4, 8, 9, 17, 33, 34, 35, 41, 44, 46, 50, 51, 56, 62, 64, 71 and 120.
  - Examples:
    - xTAO Base `0xb99FBE68c8A0cC14bE8c1AF73DD4DfEA8a76aDD7`
    - xSN8 Base `0xD321054982b8Aa84785c21E1e2371ebf2e00Eb47`
    - xSN64 Base `0xbAdd3F2d84605032C1B2AD8cBebb4700Dcd9D7dE`
    - xSN120 Base `0xA3b335797BF5a2Cc2FC21Cc4286D2b3F40f0771e`
  - Oddities in the docs: the xSN50 Base pool address equals the xSN9 Base pool address (case aside), and the xSN62 Base token address equals the xSN4 Subtensor pool address.
  - [Rubicon contract addresses](https://docs.rubiconbridge.io/developer/contract-addresses.md)
- **CCIP directory (Bittensor EVM page):** lists 21 tokens. Those are TAO plus xSN4, xSN8, xSN9, xSN17, xSN23, xSN34, xSN35, xSN41, xSN44, xSN46, xSN50, xSN51, xSN56, xSN62, xSN64, xSN65, xSN71, xSN93, xSN98 and xSN120. This suggests xSN23, xSN65, xSN93 and xSN98 were added after the docs' address table. — [Chainlink CCIP directory – Bittensor EVM](https://docs.chain.link/ccip/directory/mainnet/chain/bittensor-mainnet)
- **Live Base liquidity, 2026-10-20 snapshot.** DexScreener returned only two Rubicon pairs:
  - xSN8/USDC on Aerodrome: liquidity $112,710, 24h volume $7,354, price $11.92
  - xTAO/USDC on Aerodrome: liquidity $3,080, 24h volume $6,195
  - [DexScreener API](https://api.dexscreener.com/latest/dex/tokens/0xb99FBE68c8A0cC14bE8c1AF73DD4DfEA8a76aDD7,0x96C3A43918d30a7ca4fc195c7E93A959016a7c26,0xD321054982b8Aa84785c21E1e2371ebf2e00Eb47,0xbAdd3F2d84605032C1B2AD8cBebb4700Dcd9D7dE,0xA3b335797BF5a2Cc2FC21Cc4286D2b3F40f0771e,0x88C23896a91e7f21cba56f4090193730630D5F04,0xDb3Bc179aC3a78886e277cb83551ceF2fD3e8728,0xA964973077675E7AeA71744B05C1111e1A51eE36,0x150E673eC255e87A49cE0848216f07EBb107379e,0x38d50D6398dcBB03F334C4409f61117aD37c1A34)
- **GeckoTerminal, same day (Base-side total supply, pooled reserve in USD):**

  | Token | Base supply | Pooled reserve | 24h volume |
  |---|---|---|---|
  | xSN8 | 8,801.6 | $47,366 | ~$7.4k |
  | xSN9 | 73,856.6 | $790 | — |
  | xSN34 | 24,478 | $168 | — |
  | xSN35 | 47,078.5 | $0 | — |
  | xSN64 | 6,048 | ≈$1 | — |
  | xSN51 | 587 | ≈$0 | — |
  | xTAO | 380.2 | $736 | — |

  - Other xSN tokens (e.g., xSN4, xSN56, xSN62, xSN120) returned no pool data.
  - [GeckoTerminal API](https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/0x96C3A43918d30a7ca4fc195c7E93A959016a7c26,0xbAdd3F2d84605032C1B2AD8cBebb4700Dcd9D7dE,0xA3b335797BF5a2Cc2FC21Cc4286D2b3F40f0771e,0x88C23896a91e7f21cba56f4090193730630D5F04,0xDb3Bc179aC3a78886e277cb83551ceF2fD3e8728,0xA964973077675E7AeA71744B05C1111e1A51eE36,0x150E673eC255e87A49cE0848216f07EBb107379e,0x38d50D6398dcBB03F334C4409f61117aD37c1A34,0xc995C19aaDec7f9005b64e447baccdA46F413Ea1,0xb99FBE68c8A0cC14bE8c1AF73DD4DfEA8a76aDD7,0xD321054982b8Aa84785c21E1e2371ebf2e00Eb47,0x5663179054538cAd0467db00B87d5650600A041E)
- **2026 news:** I found no announcements in 2026 about Rubicon expansions, new chains or changes. All coverage found dates from the November 2025 launch. — [search coverage e.g. CryptoTimes](https://www.cryptotimes.io/2025/11/19/chainlink-ccip-drives-project-rubicons-defi-expansion/)

**ForeverMoney CCIP bridge (TAO and alpha to Base and Robinhood Chain): a second, newer alpha-on-Base rail**
- It moves TAO and selected subnet alpha between Finney, Base and Robinhood Chain over Chainlink CCIP. The bridge page lists TAO and SN80 as supported on both chains. — [ForeverMoney docs: Bridge](https://docs.forevermoney.ai/bridge)
- **Mechanism:**
  - Finney to EVM: the Bittensor-side asset is secured by the bridge and the token is minted on the destination.
  - EVM to Finney: the EVM token is burned before the asset is released.
  - "Supported subnet alpha uses its configured staked delivery route."
  - The liquid EVM-to-Finney TAO transfer has a minimum of 0.01 TAO.
  - [ForeverMoney docs: Bridge](https://docs.forevermoney.ai/bridge)
- **Contracts:**
  - The AlphaVault on Bittensor EVM is `0x11837459896D96F821a8D88eC93a3C8D152033D4`, with Finney mirror `5Gv8p6jx8CuVz9dhPvgq5EkNt119r6FV4FjHDv3PgEr1jaws`.
  - The TAO CCIP pool is `LockReleaseTokenPool 1.5.1` at `0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e`. Subnet tokens use separate CCIP pools.
  - The Base gateway is `0x1da2415229b614C787e145D1D7346eb496319C52`. The Bittensor alpha gateway is `0xd5Fa238aa4177f6c1341491969d9cBeec94EEd69`.
  - Addresses are embedded in `@forevermoney/sdk` 0.5.9, deployment version 1.7.0.
  - [ForeverMoney docs: Contract addresses](https://docs.forevermoney.ai/llms-full.txt)
- **Proof of reserves (live API, 2026-10-20).** Each subnet's reserve is measured as staked alpha in the vault.

  | Asset | Base token | Base supply | Robinhood supply | Finney reserve | Reserve rate |
  |---|---|---|---|---|---|
  | TAO | `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67` | 6,955.85 | 4,035.0 | 10,998.1 TAO | 100.07% |
  | SN80 | `0x6F63d869011f95274498023b4ABFC00b30c34378` | 13,814.6 | 9,695.7 | — | 104.35% |
  | SN10 | `0xDdDE5965D49e69b6362BD8743e139a45dBFEb7b3` | 18,868.5 | 0 | — | 119.07% |
  | SN78 | `0x6e2feEE56bc5F0Db2104Ab1dac2cf1Fb0334eb49` | 30,559.8 | Base only | — | 119.27% |
  | SN120 | `0x9470Ef4E54520F0369aC850E239205bacf27008A` | 2,439.4 | Base only | — | 113.03% |

  - [ForeverMoney proof-of-reserves API](https://forevermoney.ai/api/proof-of-reserves); [PoR methodology](https://docs.forevermoney.ai/proof-of-reserves)
- **Base liquidity for ForeverMoney TAO (`0xf308…3d67`, 2026-10-20):**
  - TAO/USDC on Aerodrome: $264,994 liquidity, $62k 24h volume
  - TAO/WETH on Uniswap: $180,150 liquidity, $129k volume
  - Alpha pools paired against this TAO on Aerodrome: SN80/TAO $30,175; AFFINE/TAO $39,152; SN10 (Pareton)/TAO $30,756; SN78 (UMI)/TAO $18,217
  - Robinhood Chain pools: TAO/USDG $463,913 and TAO/WETH $430,898
  - [DexScreener API](https://api.dexscreener.com/latest/dex/tokens/0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67)
- ForeverMoney says the TAO bridge to Base has been live since August 20, 2026, citing "$613k in liquidity and $731k in total volume" (promotional). — [ForeverMoney blog](https://forevermoney.ai/blog/tao-is-now-on-base)
- **Fees:** ForeverMoney charges no bridge fee. A September 7, 2026 example bridging 0.1 TAO from Bittensor to Base cost $0.25 in CCIP fee plus $0.94 of source gas. The CCIP network fee is fixed per message, not a percentage of the amount. — [ForeverMoney docs: Fees](https://docs.forevermoney.ai/bridge/fees)
- **Security and controls:**
  - Hackerbane audited the bridge (AlphaVault, AlphaGateway, SpokeGateway) in September 2026. Results: 0 Critical, 0 High, 0 Medium, 7 Low, 18 Informational. On October 2, 2026 remediation was reviewed: 19 solved, 5 acknowledged, 1 partially solved.
  - Bridge admin roles are held by a 2-of-3 Safe, with "acknowledged custody and migration risks". Some admin roles were moved from EOAs to the Safe only on October 1, 2026. The emergency pause auto-expires. CCIP rate limits cap exposure.
  - [ForeverMoney docs: Audits & Security](https://docs.forevermoney.ai/security); [Hackerbane report](https://hackerbane.com/reports/hackerbane-HACK-AR-2026-forevermoney-bridge.html)
- **Integrations:** ForeverMoney ships a TypeScript SDK (`@forevermoney/sdk`) and an MCP server that prepare unsigned transaction plans. It also runs an Aerodrome "Liquidity Manager" vault product on Base with a 10% performance fee on LP fees, audited by Halborn in December 2025. — [ForeverMoney docs](https://docs.forevermoney.ai/llms-full.txt); [Liquidity Manager fees](https://docs.forevermoney.ai/liquidity-manager/fees)

**Other TAO and alpha wrappers**
- **Tensorplex stTAO (Base `0x806041b6473da60abbe1b256d9a2749a151be6c6`):**
  - Base supply is about 1,498.8. Pooled reserve is about $911 and 24h volume about $0.11 (GeckoTerminal, 2026-10-20). — [GeckoTerminal API](https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67,0x806041b6473da60abbe1b256d9a2749a151be6c6,0x9389147397FE4F0CB25d656E2FB6E312bF733D46)
  - DefiLlama shows Tensorplex TVL at about $221.7k. — [DefiLlama](https://defillama.com/protocol/tensorplex)
  - A CoinGecko page says trading has stopped on all tracked exchanges. — [CoinGecko](https://www.coingecko.com/el/coins/tensorplex-staked-tao)
  - It is TAO-only (root), with no subnet alpha.
- **Canonical TAO on Solana:** launched May 5, 2026 through Wormhole NTT and the Sunrise gateway. It trades on Jupiter and Meteora against SOL, USDC and JUP. The article does not name the Bittensor-side contract or custody, and does not mention Base or alpha. — [The Block](https://www.theblock.co/post/400038/wormhole-bridges-canonical-version-of-bittensors-tao-token-to-solana); [Grayscale on X](https://x.com/Grayscale/status/2053104963140870343)
  - Conflict: a Phantom token page describes Solana TAO as a LayerZero OFT backed by a wTAO reserve on Subtensor EVM. — [Phantom](https://phantom.com/tokens/solana/taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY)
- **VoidAI (SN106):** bridges TAO and alpha tokens to Solana as wrapped tokens on Raydium. Base and Optimism integration via Chainlink was described as "coming" (undated or older articles). — [Cryptoast](https://cryptoast.fr/bittensor-alpha-tokens-subnets-desormais-transferables-base-solana/); [Systango](https://www.systango.com/blog/inside-voidai-building-cross-chain-economic-infrastructure-for-bittensor)
- **Imposter warning:** a Base token named "TAO Bittensor" (`0x9389147397FE4F0CB25d656E2FB6E312bF733D46`) has a 1 billion supply, trades at about $0.0002, and has a $70k Uniswap TAO/WETH pool created April 2025. Coinbase's price pages list it as "TAO Bittensor" on Base. It is not bridged TAO. — [DexScreener API](https://api.dexscreener.com/latest/dex/tokens/0x9389147397FE4F0CB25d656E2FB6E312bF733D46); [Coinbase price page](https://www.coinbase.com/price/base-tao-bittensor-3d46)
- **Aerodrome context:** DefiLlama shows Aerodrome TVL of about $381M on Oct 19, 2026. — [DefiLlama Aerodrome](https://defillama.com/protocol/aerodrome)
  - Aerodrome and Velodrome are consolidating into "Aero". One summary said the merger was scheduled around Oct 21, 2026; I could not pin the date to a primary source. — [CoinDesk](https://www.coindesk.com/business/2026/01/29/aero-dex-aims-to-fix-liquidity-fragmentation-and-dethrone-the-incumbents); [KuCoin](https://www.kucoin.com/news/insight/ETH/69d72d66ece6110007482032)

### Inferences
- **A pure Base secondary-market vault is not viable today.** The deepest alpha pool on Base (xSN8, about $47k–$113k) could absorb only a few thousand dollars per trade without large slippage. Most Rubicon pools hold under $1k, and several top subnets (xSN64 Chutes, xSN51 Lium) have effectively zero Base liquidity. Rebalancing a multi-subnet basket would leak heavily to slippage or fail outright.
- **"Base-only for the user, cross-chain for the keeper" is the realistic Base-heavy design.** The vault holds CCIP-bridged alpha tokens on Base, and a keeper creates or destroys them at NAV by staking or unstaking native alpha on Finney through the bridges' mint and burn paths, not through AMMs. Both rails support this:
  - Rubicon mints xAlpha from deposited alpha.
  - ForeverMoney mints 1:1 tokens against staked alpha in its vault.

  This keeps user deposits and withdrawals on Base, but the keeper still crosses chains and inherits CCIP and bridge-contract risk, plus Rubicon or ForeverMoney admin risk.
- **Yield treatment differs:**
  - Rubicon xAlpha is designed so staking yield accrues to the token through the exchange rate.
  - ForeverMoney tokens are 1:1 claims, yet reserve rates are above 100% (104–119% for subnets). That suggests staking rewards accumulate in the vault rather than flowing to token holders. A vault holding ForeverMoney alpha may forgo staking yield (see Gaps).
- **Subnet coverage is a constraint.** Rubicon covers about 20 subnets and ForeverMoney 4. The union does not guarantee coverage of "top N by market cap" at any given time. An index on Base would be limited to whatever subnets these bridges support.
- **Concentration risk.** Both alpha-on-Base rails are young: Rubicon since November 2025, ForeverMoney's TAO bridge since August 2026 and its audit since September 2026. Both rely on small admin multisigs or partly off-chain logic. A Base-held index would stack the vault's own risk on top of the bridge issuer's.
- **Robinhood Chain** (CCIP TAO pools of about $430k–$464k) is an emerging second EVM venue, but it is not Base.

### Gaps
- Whether ForeverMoney passes staking rewards to holders of its bridged alpha tokens, or retains them. Docs say only that the bridge is "designed to preserve principal in the selected asset".
- Rubicon's current admin and upgrade structure, its fee settings, which validators it stakes to, and whether "Multisig deployments planned" was completed. The full Hashlock PDFs were not readable.
- Current Rubicon mint and redeem activity, and whether GTV still market-makes or has withdrawn the initial ~$300k per-subnet liquidity. The data shows the liquidity is mostly gone, but no announcement explains why.
- Whether Rubicon's CCIP pools are BurnMint or LockRelease, and their rate limits.
- The Bittensor-side mechanism of Wormhole's canonical Solana TAO.
- No "alpha ERC-20 wrapper standard" (cross-project standard) was found. Each project uses its own wrapper.

---

## Q2. Index and basket tooling on Base that could hold such tokens: which lets a solo founder launch a self-running index with minimal custom code?

### Takeaway
For a solo founder the two most practical shells are:
- **Lagoon:** permissionless factory on Base; ERC-7540 async vault; Safe plus Zodiac Roles curator; zero custom Solidity; BUSL-1.1; Nethermind-audited. It fits a "deposit USDC, a keeper does cross-chain work, NAV is pushed, settle in epochs" model.
- **Reserve Index DTFs:** MIT-licensed Folio contracts with built-in Dutch-auction rebalancing and on-chain fee caps. Reserve's own docs still say permissionless Index DTF creation is "not yet" supported, and auctions need liquid markets, which xAlpha on Base lacks.

Yearn v3, Enzyme and Morpho V2 are possible but need more custom code or fit poorly. Veda, Upshift, Concrete and Gauntlet Aera are partner-led, not solo-launchable. Index Coop is a DAO issuer, not a platform.

### Cited Findings

**Reserve Index DTF (Folio)**
- **Folio roles:**
  - DEFAULT_ADMIN (expected to be the governance timelock) manages assets, fees and roles.
  - REBALANCE_MANAGER starts rebalances.
  - AUCTION_LAUNCHER (EOA or multisig) opens auctions within governance-set bounds.
  - BRAND_MANAGER is an off-chain role.
  - [reserve-index-dtf GitHub](https://github.com/reserve-protocol/reserve-index-dtf)
- **Fee caps in code:**
  - tvlFee up to 10% a year, with a DAO floor of 10 bps.
  - mintFee up to 5%, with a DAO floor of 10 bps.
  - `folioFeeForSelf` can return fees to holders.
  - Upgrades go through FolioProxy and FolioVersionRegistry, which the DAO owns.
  - Unsupported tokens: pausable or blocklist, fee-on-transfer, ERC777/callback. Rebasing tokens are supported with caveats.
  - License: MIT.
  - [reserve-index-dtf GitHub](https://github.com/reserve-protocol/reserve-index-dtf); [LICENSE](https://raw.githubusercontent.com/reserve-protocol/reserve-index-dtf/main/LICENSE.md)
- **Rebalancing:**
  - A rebalance has low, spot and high ranges for weights, limits and prices.
  - Auctions open via the AUCTION_LAUNCHER, or permissionlessly after its window.
  - Auctions are Dutch with exponential price decay and a 30-second warmup.
  - Price-control modes: NONE, PARTIAL and ATOMIC_SWAP.
  - [reserve-index-dtf GitHub](https://github.com/reserve-protocol/reserve-index-dtf); [mintlify mirror of docs (third-party)](https://mintlify.wiki/reserve-protocol/reserve-index-dtf/concepts/auctions)
- **Official docs:**
  - "The Reserve Register does not yet support permissionless creation of Index DTFs."
  - Fee bounds are stated as TVL fee "< 5% APY" and mint fee "< 1%". These conflict with the code caps above, so the docs may reflect UI or policy limits.
  - The platform take-rate buys and burns RSR.
  - The deployer picks any ERC-20 (RSR by default) as the vote-lock token.
  - Solvers such as CoW Swap fill auctions.
  - [Reserve docs: Index DTF overview](https://docs.reserve.org/core-components/index-dtfs/overview)
- A secondary review says Index DTFs run on Ethereum and Base, and that Base supports 100+ assets. The admin can change basket and fees subject to a default 48-hour timelock. — [rfp.wiki review (secondary)](https://www.rfp.wiki/vendors/reserve-protocol)

**Lagoon (ERC-7540 vaults)**
- **Deployment and structure:**
  - Curators deploy permissionlessly through the Lagoon app (`app.lagoon.finance/deploy`).
  - A vault is one ERC-7540 contract, one silo for pending requests, and a curation solution such as a Safe.
  - The `safe` (curator) can be a Safe, MPC wallet or EOA.
  - Roles: Vault Admin, Valuation Provider (pushes total assets), Access Manager, Security Council (price-per-share guardrails) and Super Operator.
  - The underlying asset cannot be a rebasing token.
  - [Lagoon: Deploy your vault](https://docs.lagoon.finance/vault/deploy-your-vault.md); [Lagoon FAQ](https://docs.lagoon.finance/overview/faq.md)
- **Base contracts:** Factory `0x6fc0f2320483fa03fbfdf626ddbae2cc4b112b51`, ProtocolRegistry `0x6da4d1859ba1d02d095d2246142cdad52233e27c`, logic v0.6.0 `0xd04deaba7fd06634764cbffe140011c69063ac77`. — [Lagoon: Networks & Addresses](https://docs.lagoon.finance/resources/networks-and-addresses.md)
- **Supported chains:** Arbitrum, Arc, Avalanche, Base, BSC, Ethereum, Hemi, HyperEVM, Linea, Monad, Optimism, Plasma, Rayls, Robinhood Chain and TAC. Bittensor EVM is not included. — [Lagoon: Networks & Addresses](https://docs.lagoon.finance/resources/networks-and-addresses.md)
- **Fees:**
  - Management, performance (with high-water mark), entry/exit and haircut fees are all encoded on-chain.
  - Lagoon's protocol fee is 10% of curator fees, with an on-chain maximum of 30%. Zero-fee vaults pay no protocol fee.
  - [Lagoon: Fees](https://docs.lagoon.finance/vault/fees.md); [Lagoon FAQ](https://docs.lagoon.finance/overview/faq.md)
- **Operations:**
  - Async flow, with optional synchronous deposits.
  - Curators using a Safe "can bridge funds across EVM chains, non-EVM chains, and even CEXs".
  - Lagoon alone can deploy upgrades, but each vault's "Upgrade Authority" decides whether to adopt them (opt-in proxy).
  - Cross-chain "vault of vaults" (main vault plus sub-vaults) is a manual custom setup.
  - [Lagoon FAQ](https://docs.lagoon.finance/overview/faq.md); [Lagoon cross-chain vaults](https://docs.lagoon.finance/vault/cross-chain-vaults.md)
- **Audits:** Nethermind reviewed v0.1.0 through v0.5.1 (2024–July 2025). A low-severity bug disclosure is dated January 22, 2026. — [Lagoon: Audits](https://docs.lagoon.finance/resources/audits.md)
- **License:** Business Source License 1.1. The licensor is the Lagoon Foundation. The change date is the earlier of 2029-01-01 or a date posted at lagoon-license-date.lagoon.finance, after which it becomes GPL-2.0+. — [lagoon-v0 LICENSE](https://github.com/hopperlabsxyz/lagoon-v0/blob/main/LICENSE)

**Enzyme**
- Enzyme Blue vaults can be deployed on Ethereum, Arbitrum, Base or Polygon. The owner chooses deposit assets ("any ERC-20"). Vaults are self-custodial with ERC-20 shares. — [Enzyme docs](https://docs.enzyme.finance/user-documentation/blue-enzyme-vaults); [Enzyme vault assets](https://docs.enzyme.finance/onyx-user-documentation/enzyme-vault/subscription/assets)
- Enzyme Onyx is available "on request", and Upshift's comparison counts 3 ChainSecurity reports. — [Upshift comparison (vendor blog, Oct 4 2026)](https://www.upshift.finance/blog/stablecoin-vault-infrastructure-providers)
- License: GPL-3.0 for the public. The Enzyme Foundation may grant alternative terms such as BUSL for affiliates. — [enzymefinance/protocol LICENSE](https://github.com/enzymefinance/protocol/blob/dev/LICENSE)

**Yearn v3**
- The VaultFactory is permissionless: anyone can call `deploy_new_vault`. — [ChainSecurity audit](https://reports.chainsecurity.com/Yearn/ChainSecurity_Yearn_V3Vaults_Audit.pdf); [Yearn v3 docs](https://docs.yearn.fi/developers/v3/overview)
- A TokenizedStrategy needs a BaseStrategy that overrides three functions. Periphery contracts (Accountant, DebtAllocator, RoleManager) are available. — [Yearn BaseStrategy docs](https://docs.yearn.fi/developers/smart-contracts/V3/BaseStrategy)
- License: AGPL-3.0. — [yearn/tokenized-strategy](https://github.com/yearn/tokenized-strategy)
- A Base deployment was not verified.

**Veda BoringVault**
- Audits include 0xMacro and Spearbit/Cantina. — [Veda audits](https://docs.veda.tech/security-and-risk-controls/audits)
- A GitHub fork describes itself as an "MIT-licensed snapshot … pinned at bdc38405 (last permissive commit, pre-relicense)". This implies the current code is no longer permissively licensed. — [BlockHelix/boring-vault](https://github.com/BlockHelix/boring-vault)
- The original Se7en-Seas repo shows no detected license and was last pushed in December 2024 (GitHub API, 2026-10-20). — [Se7en-Seas/boring-vault](https://github.com/Se7en-Seas/boring-vault)
- A competitor argues that self-forking still leaves you dependent on Veda's off-chain Accountant infrastructure. — [Lucidly (competitor blog)](https://www.lucidly.finance/blog/build-rwa-vault-lucidly-vs-veda)
- Upshift's comparison calls Veda "partner-led". — [Upshift comparison](https://www.upshift.finance/blog/stablecoin-vault-infrastructure-providers)

**Morpho Vault V2**
- Vaults allocate through curator-enabled adapters, and an optional adapter registry can restrict them. — [Morpho: adapters](https://docs.morpho.org/curate/tutorials-v2/listing-adapters/); [Morpho: adapter registry](https://docs.morpho.org/curate/concepts/adapter-registry/)
- Adapters can connect to external protocols. — [Gauntlet vaultbook](https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/v2-vaults/adapters)
- The factory is permissionless. — [Upshift comparison](https://www.upshift.finance/blog/stablecoin-vault-infrastructure-providers)

**Upshift, Concrete, Gauntlet Aera, Midas, Mellow, Kiln, IPOR**
- The (vendor-written) comparison classes Upshift, Concrete, Gauntlet Aera and Midas as partner-led or permissioned ("No" for solo launch). It classes Morpho and Lagoon as permissionless. — [Upshift comparison](https://www.upshift.finance/blog/stablecoin-vault-infrastructure-providers)

**Index Coop**
- Index Coop is a DAO that issues SetToken structured products (indices, leverage, yield) on Ethereum, Arbitrum and Base. It charges streaming and mint/redeem fees. — [Circle partner directory](https://partners.circle.com/partner/index-coop); [Solana Compass](https://solanacompass.com/projects/index-coop)
- No third-party self-serve issuance platform was found.

### Inferences
- **Lowest custom code: Lagoon on Base.** The vault takes USDC, a curator Safe (with Zodiac Roles limiting what a keeper bot can call) executes the strategy, and a valuation bot pushes NAV each epoch. The founder writes off-chain keeper and NAV code but no Solidity.
  - The trade-off is trust: NAV is pushed, not computed on-chain, and the curator Safe can move funds within its role limits.
  - The async ERC-7540 model fits cross-chain settlement delays naturally: request now, settle once the bridge round trip completes.
  - The BUSL license matters only if the founder forks the code, not if they use the factory.
- **Reserve DTF is the most "index-native" option**, with on-chain baskets, auctions and capped fees, and it holds tokens on-chain verifiably. But:
  1. Permissionless Index DTF creation is "not yet" supported per the docs, so the founder may need Reserve's cooperation or must self-deploy Folio from the MIT repo with Foundry, which is possible but means owning a deployment.
  2. Dutch auctions need external fillers. With $0–$113k pools and no CEX listings for xAlpha, auctions would clear poorly or not at all unless the founder's own keeper is the filler, minting and redeeming via the bridges.
  3. Rebasing caveats could matter if a wrapper rebases.
- **ERC-4626 kits (Yearn v3 TokenizedStrategy, Morpho V2 adapters) give on-chain accounting** but require writing and auditing a strategy or adapter that prices thin bridged-alpha tokens. Pricing them is the hard part, and no Chainlink price feeds for xAlpha were found.
- **Enzyme on Base** can hold arbitrary ERC-20s with on-chain NAV, but its price-oracle and asset-registry requirements for exotic tokens like xSN* are unverified. It probably needs Enzyme to add the assets.
- None of these shells exist on Bittensor EVM. Lagoon's chain list excludes it, and no evidence was found for Reserve, Enzyme or Morpho there. A vault that keeps its own assets on Bittensor EVM must be custom or Safe-based.

### Gaps
- Whether Reserve's app currently allows anyone to create an Index DTF on Base, the exact live fee caps (code says 10% and 5%, docs say under 5% and under 1%), and the RSR platform take-rate percentage.
- Enzyme's and Yearn's current Base addresses and asset-whitelisting rules for long-tail tokens.
- Lagoon's Additional Use Grant text, which was not shown in the first lines of the LICENSE file.
- Whether any xAlpha or ForeverMoney alpha token has a Chainlink or other on-chain price feed usable by 4626 or Enzyme pricing. None was found.

---

## Q3. Cross-chain rails to Bittensor EVM (chain ID 964) other than TaoFi's routes: what is supported, with which assets?

### Takeaway
Bittensor EVM is reachable by three verified messaging and bridging stacks:
- **Hyperlane:** permissionless; core and ICA routers are deployed. The only registry warp route is USDC, connecting Base, Ethereum, Arbitrum, Polygon, Unichain and Solana; this is likely TaoFi's.
- **Chainlink CCIP:** 5 outbound lanes (Base, Ethereum, BNB Chain, Robinhood Chain, Solana) and 21 listed tokens (TAO plus xSN*).
- **LayerZero v2:** endpoint live at EID 30374, but no listed tokens.

Wormhole carries canonical TAO to Solana. None of the major intent and aggregator bridges list chain 964 in their APIs: Relay, LI.FI, Across, deBridge, Squid and Gas.zip, checked 2026-10-20. Self-deploying a Hyperlane warp route or ICA, or a CCIP CCT pool, is the realistic non-TaoFi path. Both still involve cross-chain trust.

### Cited Findings
- **Chain identity:** Chainlist lists Subtensor EVM as chain ID 964, native TAO, active. — [chainid.network](https://chainid.network/chain/964/)
- **Hyperlane core deployment.** The registry lists `subtensor` with chainId and domainId 964, deployed by Abacus Works, with explorer evm.taostats.io. Core contracts:
  - mailbox `0xF767D698c510FE5E53b46BA6Fd1174F5271e390A`
  - interchainAccountRouter `0x9097869cb719335f45A069D41dEFAFA2858af676`
  - interchainAccountRouterV3 `0x7b0FB2E9bF9b34eec8e42e563664196B7Fef6CB9`
  - interchainGasPaymaster `0x8d7E604460E1133ebB91513a6D1024f3A3ca17F9`
  - protocolFee hook `0xA7d42B7a7603bEb87f84a1f3D5C97a033DFd2Cc9`
  - The `timelockController` is the zero address.
  - [Hyperlane registry: chains/subtensor/metadata.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/chains/subtensor/metadata.yaml); [addresses.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/chains/subtensor/addresses.yaml)
- **Hyperlane warp routes:** the only registry warp route touching Subtensor is `USDC/subtensor`.
  - Base collateral router `0x26af973A5b256F9B9bc0B1A3c566de1566568a87`, contractVersion 8.1.1, owner `0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7`.
  - Synthetic USDC on Subtensor `0xB833E8137FEDf80de7E908dc6fea43a029142F20`, owner `0xaABBDE4930e7D0a3F4E1e5296BB34F71533854AA`.
  - The route connects to Arbitrum, Ethereum, Polygon, Unichain and Solana collateral routers and has an allowed-rebalancer configuration.
  - No TAO or alpha warp route is in the registry (git HEAD 2026-10-20).
  - [Hyperlane registry: USDC/subtensor-config.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/deployments/warp_routes/USDC/subtensor-config.yaml); [subtensor-deploy.yaml](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/deployments/warp_routes/USDC/subtensor-deploy.yaml)
- Hyperlane's blog describes TaoFi as "powered by Hyperlane", with swaps routed through TAO and Sturdy SN10 handling backend routing. — [Hyperlane blog](https://www.hyperlane.xyz/post/hyperlane-unlocks-the-bittensor-ecosystem)
- **Chainlink CCIP on Bittensor EVM:**
  - Chain selector 2135107236357186872.
  - Outbound lanes: Base, BNB Chain, Ethereum and Robinhood Chain (OnRamp v2.0.0), plus Solana (v1.6.0).
  - Fee tokens: LINK, WTAO and native TAO.
  - 21 tokens: TAO and 20 xSN tokens.
  - [Chainlink CCIP directory – Bittensor EVM](https://docs.chain.link/ccip/directory/mainnet/chain/bittensor-mainnet)
  - ForeverMoney lists the CCIP router on Bittensor EVM as `0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8` and on Base as `0x881e3A65B4d4a04dD529061dd0071cf975F58bCD`. — [ForeverMoney contract addresses](https://docs.forevermoney.ai/llms-full.txt)
- **LayerZero:** announced live on Bittensor in May 2025, with the claim that ERC-20s on Bittensor EVM can expand to 130+ chains. — [LayerZero on X](https://x.com/LayerZero_Core/status/1923376914951295385)
  - The metadata API shows `subtensorevm` (native chain 964) ACTIVE with a v2 EID of 30374 and endpointV2 `0x6f475642a6e85809b1c36fa62763669b1b48dd5b`. It lists zero tokens. — [LayerZero metadata API](https://metadata.layerzero-api.com/v1/metadata/deployments)
- **Wormhole:** carries canonical TAO to Solana via NTT and Sunrise (May 2026). The Bittensor-side endpoint was not stated. — [The Block](https://www.theblock.co/post/400038/wormhole-bridges-canonical-version-of-bittensors-tao-token-to-solana)
- **Aggregators and intent bridges (API checks on 2026-10-20).** None returned chain 964, "bittensor" or "subtensor":
  - [Relay chains API](https://api.relay.link/chains) (60 chains)
  - [LI.FI chains API](https://li.quest/v1/chains) (69 chains)
  - [Across available-routes API](https://app.across.to/api/available-routes)
  - [deBridge DLN supported chains](https://dln.debridge.finance/v1.0/supported-chains-info) (18 chains)
  - [Squid v2 chains](https://v2.api.squidrouter.com/v2/chains)
  - [Gas.zip chains](https://backend.gas.zip/v2/chains)
- **Axelar:** no evidence of Bittensor EVM support was found (no source).

### Inferences
- **Self-deployed Hyperlane:** the founder could deploy their own warp route (for example USDC collateral on Base to synthetic on Subtensor, or a TAO route) and use the existing ICA routers. This avoids TaoFi's application layer but keeps Hyperlane's security model (ISM and validator set), and the founder becomes owner and admin of a bridge, a large security burden for a solo founder. Reusing the existing USDC route still means trusting its owners and rebalancer.
- **CCIP has the most institutional backing:** RMN, rate limits, and Coinbase's choice of CCIP for wrapped assets per ForeverMoney's blog. It already connects Bittensor EVM to Base. The founder would be a user of existing CCIP token routes (Rubicon xSN*, ForeverMoney TAO and alpha) rather than an issuer, since issuing their own CCT pool would mean owning a bridge token.
- **Cost:** a CCIP TAO transfer cost about $1.19 all-in in the ForeverMoney example, independent of size. Hyperlane cost depends on the interchain gas payment (not measured here).
- **Aggregators:** because none support chain 964, a "one-click USDC from any chain" UX into Bittensor must go through Hyperlane (TaoFi's route or the founder's own) or CCIP-bridged TAO on Base, bought on Aerodrome and then bridged.
- **Fewest hops for a Base user:** USDC to TAO on Base (Aerodrome TAO/USDC, about $265k liquidity), then CCIP TAO to Finney via ForeverMoney with staked delivery. That is one bridge hop, and the TAO pool depth limits size per trade.

### Gaps
- Who controls the owner addresses of the USDC/subtensor Hyperlane route (presumed TaoFi or Sturdy multisigs; not verified on-chain), and its ISM configuration.
- Whether CCIP's "self-serve" CCT path is open to any issuer on Bittensor EVM. The token pool factory exists per the directory, but the process was not verified.
- LayerZero OFTs actually deployed on Subtensor. The metadata lists none.
- Hyperlane interchain-gas costs for Base to Subtensor messages.
- Axelar status.

---

## Q4. Building "native" on Bittensor (substrate side): staking-as-a-service and custodial providers versus smart contracts

### Takeaway
No institutional custodian was found that publicly offers subnet-alpha staking via API. Kraken offers custodial TAO root staking and has announced subnet-token listings. BitGo reportedly offers TAO custody and staking.

The closest non-custodial "native" building blocks are:
- a Safe multisig on Bittensor EVM whose SS58 mirror holds and stakes alpha (ForeverMoney deployed canonical Safe 1.3.0 on chain 964),
- the staking precompile at `0x…0805`, and
- bridge vault contracts like Rubicon's and ForeverMoney's that custody staked alpha with no private key.

A custodial backend (exchange account or validator API) would be operationally simpler but turns the product into a custodial service with counterparty and regulatory exposure.

### Cited Findings
- **Kraken:** promoted custodial TAO staking on the Bittensor Root Network for institutions in April 2025. — [Kraken Pro on X](https://x.com/krakenpro/status/1915050539697553906)
  - Kraken announced a dTAO integration and a listing roadmap for subnet tokens: Chutes, Hippius, Lium, Score, Targon, Ridges AI and Vanta. The effective listing date was unconfirmed at publication. — [Crypto Economy](https://crypto-economy.com/kraken-adds-bittensor-subnet-tokens-to-its-roadmap-with-seven-new-listings/); [TrustedStake on X](https://x.com/TrustedStake/status/2071660654163841212?lang=en)
- **BitGo, Coinbase, Kraken (secondary):** BitGo added TAO support in early 2025 and offers qualified custody and institutional staking. Coinbase Institutional and Kraken are "integrating TAO across spot, custody, and staking services". — [Presto Research](https://www.prestolabs.io/research/from-bitcoin-to-bittensor-the-next-monetary-primitive)
- **Safe on Bittensor EVM (ForeverMoney Multi-sig):**
  - Uses the canonical Safe 1.3.0 deployment on chain 964: Safe L2 singleton `0x3E5c63644E683549055b9Be8653de26E0B4CD36E`, Proxy Factory `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2`.
  - Each Safe has an SS58 mirror address (prefix 42) with no separate private key, which can receive TAO and manage subnet-alpha positions on Finney.
  - [ForeverMoney docs: Multi-sig](https://docs.forevermoney.ai/llms-full.txt)
- **Contract custody of staked alpha:** the staking precompile is `0x0000000000000000000000000000000000000805`, as used by ForeverMoney. — [ForeverMoney contract addresses](https://docs.forevermoney.ai/llms-full.txt)
  - Rubicon's EVM contract custodies alpha via the stakingV2 precompile with no private key. — [Rubicon architecture](https://docs.rubiconbridge.io/product/architecture.md)

### Inferences
- **Native non-custodial option with no TaoFi dependency:** a Safe on Bittensor EVM, controlled by the founder plus co-signers or by a Zodiac-style module, holds the index's alpha positions through its SS58 mirror. A keeper proposes stake and unstake calls via the precompile. Paired with a Lagoon vault on Base (USDC in, NAV pushed), the Base front end needs no custom Solidity, but trust sits in the Safe signers and the NAV pusher. This is the "Lagoon + Safe hub" pattern. Lagoon's FAQ explicitly allows a curator Safe to bridge across chains.
- **Custodial backend (e.g., a Kraken institutional account):** removes smart-contract and bridge risk but:
  1. alpha staking support by custodians is unconfirmed,
  2. user USDC would flow into a centralized account, making the product custodial (licensing implications, covered by the regulatory researcher), and
  3. it creates withdrawal and API dependency risk.

  It is generally a poor fit for a "security-first, mostly automated, on-chain" pitch, but could serve as an off-chain treasury fallback.

### Gaps
- No public documentation was found for any custodian or validator offering a subnet-alpha staking API: not Kraken, Coinbase, BitGo, Anchorage, Crucible Labs, RoundTable21, Mentat Minds or TAO.com/Tensorplex. Searches returned only TAO root staking.
- Whether Safe modules (e.g., Zodiac Roles) are deployed on Bittensor EVM. Only the core Safe 1.3.0 contracts were confirmed.

---

## Q5. Off-chain and perp alternatives for TAO exposure (building blocks only)

### Takeaway
Hyperliquid has a liquid TAO perp: about $11.3M in 24h volume, OI of about 164.8k TAO (about $45M), 5x maximum leverage. It also has a thin TAO spot token (HTAO, about $13k a day). No HIP-3 deployer lists TAO or subnet-alpha markets. Perps could hedge the TAO beta of an alpha basket, but they cannot provide subnet-alpha exposure or staking yield. MegaTAO offers alpha perps natively on Bittensor EVM.

### Cited Findings
- **Hyperliquid (info API, 2026-10-20):**
  - The TAO perp shows mark $273.71, OI 164,763.06 TAO, 24h notional volume $11,282,756, max leverage 5x, hourly funding 0.0000125.
  - Spot: HTAO ("Hyper TAO", HyperEVM contract `0xdf23ab692d47c5d9b1445c8183a2dca4529a621f`) trades at $273.56 with $13,161 of 24h volume. TAO1 (Wagyu) has zero volume.
  - HIP-3 perp DEXs (xyz, flx, vntl, hyna, km, abcd, cash, para, mkts, io) list no TAO or subnet markets.
  - [Hyperliquid info API](https://api.hyperliquid.xyz/info) (POST `metaAndAssetCtxs`, `spotMetaAndAssetCtxs`, `perpDexs`, `meta` per dex)
- **HIP-3:** live since October 13, 2025. A builder staking 500,000 HYPE can deploy perp markets permissionlessly. — [Cointribune](https://www.cointribune.com/en/hyperliquid-crosses-a-decisive-step-with-hip-3-perpetual-markets-open-to-all/)
- **MegaTAO:** offers alpha-token perpetuals with leverage on Bittensor EVM, settled in TAO. — [MegaTAO](https://www.megatao.com/)

### Inferences
- Perps are useful only as a hedging or liquidity buffer: for example, briefly hedging TAO beta while cross-chain settlement is in flight, or a "TAO-neutral subnet alpha" product variant. They add venue, liquidation and funding risk and do not deliver the core alpha exposure.
- A HIP-3 subnet-index perp is theoretically possible but would need 500k HYPE staked plus a reliable oracle, which is not realistic for a solo founder.

### Gaps
- MegaTAO's liquidity, audits and market list were not researched.
- No liquid CEX or perp market for individual subnet alpha was found. Kraken listings are on a roadmap only.

---

## Q6. Option-by-option evaluation (maturity, audits, admin risk, liquidity, fees, docs, license, custom code, how much lives on Base)

### Takeaway
No option delivers a fully on-chain, Base-only index with deep liquidity today. The lowest-code, Base-heaviest architecture is:

**Lagoon vault on Base** (USDC in, ERC-7540) → **keeper or curator Safe** → **one bridge hop** (CCIP via ForeverMoney or Rubicon, or Hyperlane) → **native staking on Finney** → **optional re-bridge** of the resulting alpha as tokens on Base for on-chain verifiability.

Reserve DTFs are the most index-native shell, but they depend on liquid auction markets and on Reserve enabling Index DTF creation. Self-deployed bridges move admin and security burden onto the founder.

### Cited Findings (comparison matrix; each row cites sources already listed above)

| Option | Role | Maturity / live since | Audits | Admin / upgrade risk | Liquidity / coverage (2026-10-20) | Fees | License / docs | Custom code for founder | Lives on Base? |
|---|---|---|---|---|---|---|---|---|---|
| Rubicon xAlpha ([docs](https://docs.rubiconbridge.io/), [PR](https://www.prnewswire.com/news-releases/general-tao-ventures-launches-project-rubicon-to-bridge-bittensor-subnets-to-global-web3-markets-302619285.html)) | Alpha-on-Base token (yield via exchange rate) | Nov 2025 | Hashlock audit + pentest Oct 2025, "Secure" ([Hashlock](https://hashlock.com/audits/rubicon)) | Not documented; exec summary says multisig "planned", staking logic partly off-chain | About 20 subnets in CCIP directory; Base pools $0–$113k, most under $1k ([GeckoTerminal](https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/0x96C3A43918d30a7ca4fc195c7E93A959016a7c26,0xbAdd3F2d84605032C1B2AD8cBebb4700Dcd9D7dE,0xA3b335797BF5a2Cc2FC21Cc4286D2b3F40f0771e,0x88C23896a91e7f21cba56f4090193730630D5F04,0xDb3Bc179aC3a78886e277cb83551ceF2fD3e8728,0xA964973077675E7AeA71744B05C1111e1A51eE36,0x150E673eC255e87A49cE0848216f07EBb107379e,0x38d50D6398dcBB03F334C4409f61117aD37c1A34,0xc995C19aaDec7f9005b64e447baccdA46F413Ea1,0xb99FBE68c8A0cC14bE8c1AF73DD4DfEA8a76aDD7,0xD321054982b8Aa84785c21E1e2371ebf2e00Eb47,0x5663179054538cAd0467db00B87d5650600A041E)) | "Under design" | Thin docs (6 pages); no SDK found | Keeper to mint and redeem; ERC-20 composability assumed | Token yes; minting needs Subtensor |
| ForeverMoney CCIP bridge ([docs](https://docs.forevermoney.ai/llms-full.txt)) | TAO and alpha (SN10, 78, 80, 120) on Base, 1:1 | TAO on Base since Aug 20 2026 | Hackerbane Sep 2026: 0C/0H/0M/7L/18I ([report](https://hackerbane.com/reports/hackerbane-HACK-AR-2026-forevermoney-bridge.html)) | 2-of-3 Safe admin; auto-expiring pause; CCIP rate limits | TAO on Base about $445k across 2 pools; alpha pools $18k–$39k | No bridge fee; about $1.19 CCIP plus gas per transfer | Good docs, SDK and MCP; license not stated | Keeper via SDK | Token yes; minting needs Finney |
| Reserve Index DTF ([GitHub](https://github.com/reserve-protocol/reserve-index-dtf), [docs](https://docs.reserve.org/core-components/index-dtfs/overview)) | On-chain basket token + auctions | Index DTFs since 2025 | Audits dir in repo (not enumerated) | DAO-owned version registry; governance timelock; fee caps | Needs auction fillers; poor fit for thin xAlpha | TVL fee up to 10% (code) / under 5% (docs); mint up to 5% / under 1%; DAO floor 10 bps | MIT | Low Solidity if allowed to deploy; keeper as auction filler | Yes |
| Lagoon ([docs](https://docs.lagoon.finance/vault/deploy-your-vault.md)) | ERC-7540 vault shell + Safe curator | v0.1 Nov 2024 to v0.6 | Nethermind (multiple versions) | Lagoon ships upgrades; opt-in per vault; NAV pushed by valuation role | N/A (holds whatever the curator buys) | 10% of curator fees (max 30%) | BUSL-1.1 (GPL-2.0+ by 2029) | No Solidity; keeper and NAV bots | Yes (Base factory) |
| Enzyme Blue ([docs](https://docs.enzyme.finance/user-documentation/blue-enzyme-vaults)) | On-chain fund with ERC-20 shares | Mature | ChainSecurity (per Upshift) | Enzyme-managed asset universe (unverified) | Exotic asset support unverified | Not researched | GPL-3.0 | Low, if assets are supported | Yes |
| Yearn v3 ([docs](https://docs.yearn.fi/developers/v3/overview)) | ERC-4626 vault + strategy | Mature | ChainSecurity, others | Founder owns roles | N/A | Founder-set | AGPL-3.0 | Must write and audit a strategy | Base deployment unverified |
| Veda BoringVault ([docs](https://docs.veda.tech/security-and-risk-controls/audits)) | Vault framework | Mature | Macro, Spearbit, etc. | Partner-led | N/A | Partner terms | Relicensed (post-MIT snapshot) | Partner-dependent | Possible |
| Morpho V2 ([docs](https://docs.morpho.org/curate/tutorials-v2/listing-adapters/)) | Lending-curation vault | Mature | 11 audits on V2 (per Upshift) | Curator timelocks | N/A | Curator-set | Not checked | Custom adapter needed | Yes |
| Self-deployed Hyperlane warp route / ICA ([registry](https://github.com/hyperlane-xyz/hyperlane-registry/blob/main/chains/subtensor/addresses.yaml)) | Messaging / bridge | Core on Subtensor live | Hyperlane audits (not checked) | Founder becomes bridge owner | Founder must seed collateral | Interchain gas | Hyperlane open source | Medium–high | Partly |
| CCIP (use existing routes) ([directory](https://docs.chain.link/ccip/directory/mainnet/chain/bittensor-mainnet)) | Messaging / token bridge | Live; 5 lanes, 21 tokens | Chainlink | Token-issuer admins (Rubicon, ForeverMoney) + Chainlink | Per-token rate limits | Fixed per message | N/A | Low (SDK) | Partly |
| LayerZero v2 ([metadata](https://metadata.layerzero-api.com/v1/metadata/deployments)) | Messaging | Endpoint live, EID 30374 | LayerZero | Founder-configured DVNs | No tokens listed | Per message | N/A | High (deploy OFT) | Partly |
| Aggregators (Relay, LI.FI, Across, deBridge, Squid, Gas.zip) | Intent bridges | Chain 964 not supported | — | — | — | — | — | — | — |
| Custodial (Kraken, BitGo) ([Kraken](https://x.com/krakenpro/status/1915050539697553906)) | Off-chain staking | TAO root only, confirmed | N/A | Full custodian risk | Alpha unconfirmed | Not researched | — | API integration | No |
| Hyperliquid TAO perp ([API](https://api.hyperliquid.xyz/info)) | Hedge only | Live | — | Venue risk | About $11.3M/day, OI about $45M | Funding + fees | — | Medium | No |

### Inferences
- **Recommended evaluation shortlist (inference):**
  1. **"Lagoon + bridge-token" design:** Lagoon vault on Base. A keeper buys CCIP TAO on Aerodrome (or bridges via Hyperlane USDC), sends it through ForeverMoney or Rubicon to Finney, stakes across subnets, then re-bridges alpha as xSN* or ForeverMoney tokens to the vault's Base Safe so holdings are visible on Base. NAV is computed from Finney stake values rather than thin Base AMM prices.
  2. **"Lagoon + Bittensor Safe hub" design:** same front end, but alpha stays native in a Safe on Bittensor EVM. This avoids Rubicon and ForeverMoney issuer risk, keeps native staking yield, needs only one bridge hop for USDC/TAO, and requires no custom Solidity. The cost is weaker on-chain verifiability from Base.
  3. **"Reserve DTF of bridge tokens":** only once Base alpha liquidity improves and Reserve opens Index DTF creation. Even then, the founder's keeper would likely be the main auction filler.
- **Fewest hops for users:** in all three designs the user touches only Base. Cross-chain hops are pushed into a batched keeper process, so per-user bridge fees disappear (CCIP is a fixed fee per message, about $1.19). Settlement then becomes asynchronous (hours, not seconds), which suits ERC-7540 request/claim UX.
- **Biggest risk deltas versus TaoFi:**
  - ForeverMoney and Rubicon add a token-issuer layer: admin multisig, pause, rate limits.
  - A Lagoon or Safe design moves trust onto the founder's own signers and NAV pusher.
  - Reserve adds DAO governance, the RSR platform fee, and auction-execution risk.
- **Watch items:**
  - The imposter "TAO Bittensor" Base token on Coinbase's price pages: hardcode verified addresses.
  - Aerodrome's migration to "Aero", which may change pool addresses.
  - Duplicated or conflicting addresses in Rubicon's docs: verify on Basescan before integrating.

### Gaps
- Audit lists for Reserve Index DTF and Hyperlane were not enumerated, and Rubicon's full audit findings were not readable (PDF).
- Fee schedules for Enzyme, Morpho and Veda, and the RSR platform take-rate, were not obtained.
- No primary source on whether Rubicon or ForeverMoney permit or support third-party protocols minting and redeeming programmatically at scale. ForeverMoney's SDK and MCP suggest yes for its own bridge, and Rubicon has no SDK found. No allow-listing, rate-limit sizes or per-transfer caps were published.
- Robinhood Chain as an alternative EVM venue (CCIP TAO pools about $430k–$464k; Lagoon supported) was not evaluated in depth.
