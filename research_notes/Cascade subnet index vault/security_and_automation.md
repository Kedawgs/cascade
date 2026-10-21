# Security Risks, Incident History, and Secure Automation Design for a Cross-Chain Bittensor Index Vault (cascade.fi)

Research date: 2026-10-20. Items are labeled with their date. Most 2026 incident figures come from news outlets and security-firm alerts (PeckShield and others), not from the protocols' own post-mortems. Treat exact dollar figures as approximate.

## Incident history: Bittensor, Hyperlane, TaoFi, other Bittensor DeFi, and relevant 2025-2026 bridge/vault exploits

### Takeaway
I found no exploit of the Bittensor protocol (Subtensor) itself. Its losses so far came from the software supply chain: the July 2024 PyPI attack took about 32k TAO (~$8M) and led to a foundation-imposed "safe mode." Its bigger ongoing risk is governance: the foundation can halt the chain and can ship runtime changes to staking and AMM behavior quickly. The relevant 2026 cross-chain pattern is forged or weakly verified messages. Examples are Kelp's 1-of-1 LayerZero DVN (~$292M), CrossCurve's missing validation (~$3M), and on Base itself, Autheo's Hyperlane warp route, reportedly secured by a TrustedRelayerIsm (~$1.7M, October 12, 2026). For this design, the ISM/verifier configuration is the single most important security choice.

### Cited Findings

**Bittensor: July 2024 supply-chain hack and "halt" (2024)**
- July 2, 2024: about 32,000 TAO (~$8M) left wallets without authorization over roughly 3 hours. TAO fell about 15%. — [Rekt](https://rekt.news/bittensor-rekt)
- Root cause: a malicious `bittensor==6.12.2` package on PyPI. When users decrypted their coldkeys, the decrypted key bytes went to an attacker server. Users who installed between May 22 and May 29, 2024 and then staked, transferred, or delegated were exposed. — [Rekt](https://rekt.news/bittensor-rekt); [The Block](https://www.theblock.co/post/303547/bittensor-exploit)
- Manifold Labs' write-up says the attacker used leaked PyPI credentials and that the release pipeline had no automated pre-publish checks. I saw this only in a search snippet and did not open the full page. — [Manifold](https://manifold.inc/releases/bittensor-pypi-hack)
- Response: OTF put the chain into "safe mode." Blocks kept being produced, but all transactions were halted, initially for "at least the next 24 hours." Validators were moved behind a firewall. — [Bitcoin.com News](https://news.bitcoin.com/bittensor-blockchain-placed-in-safe-mode-following-multi-million-dollar-wallet-drains/); [The Defiant](https://thedefiant.io/news/hacks/bittensor-halts-network-after-users-fall-victim-to-malicious-python-software)
- Rekt said safe mode "highlighted the centralized control the team maintains over the supposedly decentralized network." — [Rekt](https://rekt.news/bittensor-rekt)
- Earlier theft: on June 1, 2024, a holder lost about 28k TAO ($11.2M). ZachXBT may have linked it to the July attack (unconfirmed). — [Rekt](https://rekt.news/bittensor-rekt)

**Bittensor: 2025-2026 events (no confirmed protocol-level hack found)**
- A secondary source lists a "runaway batch call" overload incident in May 2025. I could not find a post-mortem. Subnet 281 ("LOL-subnet") openly gamed dTAO by encouraging alpha buys to capture emissions, and OTF then adjusted emission dynamics. — [Crucible Labs](https://cruciblelabs.substack.com/p/bittensors-next-chapter-from-incentives) (secondary/opinion)
- May 8, 2026 hotfix (v3.3.15-402): owner alpha at registration was set to zero. "Four reviewers signed off in under eight hours." The change "bypassed standard staging environments" and went live on mainnet the same day. — [TAO Media](https://www.tao.media/bittensors-hotfix-ends-subnet-owners-free-alpha-at-registration/)
- EVM staking precompile gas bug (Release 478): stake-exit calls reserved about 2.3M gas but used about 100k. It was fixed by sizing the reservation to the caller's hotkey list. — [Subtensor PR #3237](https://github.com/RaoFoundation/subtensor/pull/3237)
- Precompiles have no formal versioning or deprecation mechanism (issue opened February 2026). — [Subtensor issue #2455](https://github.com/opentensor/subtensor/issues/2455)
- Open PR #3210 (October 2–3, 2026) would replace the "old Balancer-style pricing" of dynamic subnet pools with a "fixed, exponent-two translated superellipse." Large trades "can reach finite endpoints," and swaps enforce reserve floors and price limits. The PR says the existing EVM ABI stays compatible. It had not been merged or deployed. An automated review first flagged a high-severity issue: one blocked holding could block basket access for all holders. It was later fixed. — [Subtensor PR #3210](https://github.com/RaoFoundation/subtensor/pull/3210)
- On an early-October 2026 release PR, an automated AI review labeled the change "VULNERABLE," citing "two unresolved security defects in the Alpha migration." This is unconfirmed bot output. — [Subtensor PR #3208](https://github.com/RaoFoundation/subtensor/pull/3208)
- 2026 runtime cadence is very fast. Releases v431 through v481 shipped between July and October 2026. They include "Root Reborn" (v441, validator-curated root baskets), "Emission Gate" (v440), "Basket Trading" (v461, `swap_basket` "launches gated off"), and "Etao" (v481, October 2026). The releases page lists no halts. — [Bittensor releases](https://www.bittensor.com/releases)
- One review says OTF can unilaterally halt the network, as it did in July 2024. — [ownyourmind.ai](https://ownyourmind.ai/projects/bittensor/) (via search summary)

**Hyperlane / TaoFi**
- Autheo THEO (October 12–13, 2026, on Base): 19M THEO were minted without backing through the project's Hyperlane-based bridge and swapped for 700.8 ETH (~$1.76M). THEO fell about 92%. — [Crypto Briefing](https://cryptobriefing.com/autheo-theo-plunges-suspected-bridge-exploit/); [The Defiant](https://thedefiant.io/news/hacks/autheo-s-theo-plunges-92-after-suspected-bridge-exploit-on-base)
- Crypto Times reports that the Base contract was secured by a `TrustedRelayerIsm`, which relies on a single relayer address and no validator signatures. Other outlets say the root cause has not been confirmed. Autheo has not published a post-mortem. — [Crypto Times](https://www.cryptotimes.io/2026/10/13/autheo-theo-crashes-over-90-after-1-7m-hyperlane-bridge-exploit-on-base/) (search summary; the page returned 403 to fetch)
- Hyperlane's docs confirm the trap. "When first deploying with the CLI, new HWR use a Trusted Relayer ISM out of the box." It must be removed for production. The production steps are: remove the trusted relayer ISM, transfer ownership of the route, and update the Mailbox default ISM and ownership. — [Hyperlane: remove trusted relayer](https://docs.hyperlane.xyz/docs/guides/production/warp-route-deployment/remove-trusted-relayer); [Hyperlane prod overview](https://docs.hyperlane.xyz/docs/guides/production/prod-overview)
- GitHub issue #8589, opened April 14, 2026, reports a "critical vulnerability" in the `HypERC20Collateral` and `HypNative` warp route contracts. The reporter says it causes "ERC4626 vault insolvency" during normal operation with no attacker. The reporter claims four passing Foundry PoCs and asked for a private disclosure channel. No maintainer reply is visible. Linear closed the issue as "not planned" on October 15, 2026, and its resolution is not public. — [hyperlane-monorepo #8589](https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/8589)
- TaoFi's GitHub lists a mainnet `HyperERC4626Collateral` contract, so TaoFi's USDC collateral side appears to use the ERC-4626-collateral warp route variant. — [TaoFi-0x/taofi-swap](https://github.com/TaoFi-0x/taofi-swap) (search summary)
- TaoFi bridge launch (2025): the bridge was "capped at $10 million TVL" at launch, with the cap to grow with demand. I found no current cap. — [Hyperlane Medium (taoUSD)](https://medium.com/hyperlane/accelerating-defi-on-bittensor-with-taousd-93bc723c742d); [Cryptoast](https://cryptoast.fr/bittensor-tao-devoile-premier-bridge-ethereum-stablecoin-taousd/)
- TaoFi liquidity (May 22, 2026): TaoFi's TAO/USDC Uniswap V3 pool on Bittensor EVM had "only $215K in liquidity and no alpha token pairs." — [Manifold Labs Substack](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere)
- DefiLlama shows a stablecoin market cap of about $315,788 on Bittensor EVM and about $32.6K for the TaoFi row. The snapshot date is unclear. — [DefiLlama Bittensor EVM](https://defillama.com/chain/bittensor-evm)
- I found no reported exploit of TaoFi or of Hyperlane core contracts. A 2026 DexTools guide says Hyperlane core has had no major exploit. That guide predates or ignores the October THEO incident, which was an app-level configuration failure, not a core failure. — [DexTools](https://www.dextools.io/tutorials/what-is-hyperlane-permissionless-interoperability-protocol-guide-2026)

**Other Bittensor DeFi**
- wTAO bridge (Ethereum): DL News (~2026) reports it is controlled by one person, who must sign off on every redemption, and that its code is closed-source. — [DL News](https://www.dlnews.com/articles/defi/wrapped-tao-on-ethereum-soars-to-82m-but-its-all-controlled-by-one-person/)
- Tensorplex replaced wTAO with its own tTAO for stTAO exits "to strengthen the decentralization and robustness of stTAO." Quantstamp's audit describes a privileged role that can call `receiveFromChain()` to mint wrapped tokens. — [Tensorplex X](https://x.com/TensorplexLabs/status/1824099673688400092); [Quantstamp report](https://certificate.quantstamp.com/full/tensorplex-labs/fac85f03-dfa2-4f47-88d6-732ed5ea9360/index.html)
- I found no reported hack of wTAO, Tensorplex, or TaoFi.

**2025-2026 bridge and vault exploits relevant to this architecture**
- Kelp DAO rsETH (April 18, 2026): about 116,500 rsETH (~$292M) was drained. LayerZero attributes it to DPRK's "TraderTraitor," which poisoned the RPC nodes used by the DVN, DDoSed the clean nodes, and got a forged message accepted. Kelp ran a 1-of-1 DVN. LayerZero says forged data was served to the signer while monitoring tools saw correct data. LayerZero said it will stop signing 1-of-1 DVN messages. Kelp says 1-of-1 was LayerZero's documented default and is migrating to Chainlink CCT. The stolen rsETH was posted as Aave collateral, which led to rsETH market freezes and more than $10B in Aave outflows. — [The Defiant](https://thedefiant.io/news/hacks/layerzero-s-incident-report-says-kelp-downgraded-from-2-of-2-to-1-of-1-before-usd292m-exploit); [CoinDesk](https://www.coindesk.com/tech/2026/04/20/kelp-dao-claims-layerzero-s-default-settings-are-what-actually-caused-the-usd290-million-disaster); [Unchained](https://unchainedcrypto.com/kelp-dao-claims-layerzero-approved-the-setup-it-blamed-for-292-million-hack-migrates-to-chainlink/)
- CrossCurve (January 31 or February 1, 2026, ~$3M): a missing validation check in an Axelar-based receiver let forged cross-chain messages unlock funds from PortalV2. — [BeInCrypto](https://beincrypto.com/crosscurve-bridge-exploit-loss/); [bex.co analysis](https://bex.co/blog/2026/03/16/crosscurve-3m-bridge-exploit-axelar-gateway-fabricated-cross-chain-messages)
- IoTeX ioTube (February 21, 2026, ~$4.4M; one tally says $8.8M): a compromised validator-owner private key gave the attacker control of the bridge contracts. — [CoinDesk](https://www.coindesk.com/business/2026/02/23/iotex-bridge-exploit-sparks-debate-over-losses-and-recovery-prospects); conflicting figure: [CoinGabbar](https://www.coingabbar.com/en/crypto-currency-news/crypto-hacks-2026-14-bridge-attacks-security-concerns)
- 2026 bridge totals: PeckShield counted 8 bridge exploits worth about $328.6M by mid-May 2026, and 14 worth about $340.7M by June 1, 2026. — [Crypto Times](https://www.cryptotimes.io/2026/05/18/crypto-bridge-hacks-top-328m-in-2026-as-cross-chain-exploits-accelerate/); [CoinGabbar](https://www.coingabbar.com/en/crypto-currency-news/crypto-hacks-2026-14-bridge-attacks-security-concerns)
- 2025 baseline: Chainalysis counted about $3.4B stolen in 2025. Bybit (~$1.4–1.5B, February 2025) was about 40% of that, and DPRK-linked actors took about 59%. — [PYMNTS](https://www.pymnts.com/cryptocurrency/2025/crypto-thefts-reached-3-4-billion-in-2025); [Gate/Chainalysis](https://www.gate.com/news/detail/chainalysis-records-34-billion-crypto-theft-in-2025-bybit-hack-alone-15-22647951)
- Bybit/Safe (February 2025): attackers used stolen AWS credentials to change Safe{Wallet}'s S3-hosted front-end JavaScript, which targeted only Bybit's wallet. Signers approved a delegatecall that swapped the Safe's masterCopy. There was no Subresource Integrity check and no alerting on the change. — [Ocorian](https://www.ocorian.com/knowledge-hub/insights/breaking-vault-lessons-crypto-custody-security-bybit-hack); [QuillAudits multisig timeline](https://multisiginspector.quillaudits.com/hacks/bybit-2025-02); [Cyfrin](https://www.cyfrin.io/blog/safe-wallet-hack-bybit-exploit)
- ResupplyFi (June 26, 2025, ~$9.5–10M): hours after deployment, the attacker made a tiny deposit plus a large donation to a nearly empty ERC-4626 vault. The inflated price made `1e36 / price` round to 0. With no `require(_exchangeRate > 0)` check, the solvency check passed and the attacker borrowed about $10M with 1 wei of collateral. — [BlockSec](https://blocksec.com/blog/in-depth-analysis-and-reflections-on-the-resupply-protocol-attack-incident); [Rekt](https://rekt.news/resupplyfi-rekt); [QuillAudits](https://www.quillaudits.com/blog/hack-analysis/resupply-hack-analysis)
- Balancer V2 (November 3, 2025, ~$120–128M): precision loss and rounding (`_upscaleArray` used mulDown) in stable-pool invariant math was amplified by `batchSwap` and flash loans. Forks were also hit. About $43M was recovered or frozen, including a StakeWise whitehat rescue under Safe Harbor. Earlier audits did not catch it. — [OpenZeppelin](https://www.openzeppelin.com/news/understanding-the-balancer-v2-exploit); [BlockSec](https://blocksec.com/blog/in-depth-analysis-the-balancer-v2-exploit); [Bates White](https://www.bateswhite.com/newsroom/publications/how-flash-loans-amplified-a-rounding-error-into-a-100-million-loss-by-Julian-Chan-and-Kory-Shipp)
- OpenEden cUSDO (October 2025 disclosure): the vault inherited OpenZeppelin's default `_decimalsOffset()` of 0. Victims could lose 9–25% of deposits in a griefing attack even though the attack was unprofitable for the attacker. — [HackenProof report](https://hackenproof.com/reports/OPENEDCA-112) (via search summary)

### Inferences
- The pattern across 2026 bridge losses is "verification set to N=1": a single DVN (Kelp), a single trusted relayer (Autheo, reportedly), or a single owner key (IoTeX). Cascade must verify the ISM on every route and ICA it relies on: TaoFi's USDC warp route, the ICA router, and the Mailbox default ISM on Bittensor EVM. It cannot assume TaoFi chose a strong configuration.
- The Kelp case shows that monitoring alone can be blinded, since forged data went to the signer while monitors saw clean data. Rate limits and caps have to be on-chain, not just alert-based.
- Bittensor's main chain risk for an EVM vault is less "hack" and more that the rules change under you. Same-day hotfixes, frequent runtime releases, an AMM curve migration, and no precompile versioning mean vault logic that hard-codes swap math or precompile semantics can break silently.
- The #8589 report is directly relevant: TaoFi's collateral contract appears to be the ERC-4626 collateral variant, and the issue's closure doesn't say whether the report was confirmed or fixed. Ask Hyperlane and TaoFi before relying on that route.

### Gaps
- No official Opentensor post-mortem was fetched (the blog returned 403). I found no primary source for the May 2025 "runaway batch call" incident.
- There is no official Autheo or Hyperlane post-mortem confirming the TrustedRelayerIsm root cause.
- TaoFi's current warp route ISM configuration, validator set, TVL cap, and whether its USDC on Bittensor EVM is synthetic or collateral-backed per chain were not found in docs. The Hyperlane registry entry should be read with `hyperlane warp read`.
- I found no CertiK, SlowMist, or Chainalysis H1 2026 or Q3 2026 aggregate report.

## Attack surfaces specific to this design

### Takeaway
The design stacks five trust layers. Each can fail independently, and loss from any one is total or near-total:
1. Hyperlane message verification (ISM) for both the USDC warp route and the ICA that controls the stake.
2. Backing of synthetic or collateral USDC on Bittensor EVM.
3. Very thin AMMs: a ~$215K USDC/TAO pool and per-subnet alpha pools.
4. NAV/share pricing that reads manipulable alpha prices across a slow cross-chain link.
5. Bittensor chain governance, which can halt the chain or change swap/precompile semantics.

Keeper and admin keys are secondary surfaces. Good design can shrink them to near-zero power.

### Cited Findings

**ICA / bridge message trust**
- Hyperlane "has no protocol-enshrined security model, let alone validator set." Each deployment picks its ISMs, and "most Hyperlane deployments are configured with a Default ISM." — [Hyperlane FAQ / glossary](https://docs.hyperlane.xyz/docs/faq)
- ICA addresses are derived deterministically from `(origin, owner, remoteRouter, remoteISM)` via CREATE2. On the destination, the router deploys an `OwnableMulticall` and executes the multicall. For core chains you can "use the defaults that are set by the owner of the router contract." — [Hyperlane ICA docs](https://docs.hyperlane.xyz/docs/applications/interchain-account)
- TaoFi pattern: passing the user's address as `salt` gives each user a unique destination ICA. A transfer-and-call sends Message 1 (the HWR token transfer) and Message 2 (the remote swap with a minimum amount). If the swap fails, funds stay in the user's ICA for retry or withdrawal. The docs do not describe message ordering, the ISM, or the case where the user never acts. — [Hyperlane: cross-chain swaps with recovery](https://docs.hyperlane.xyz/docs/applications/use-cases/cross-chain-swaps-with-recovery)
- The relayer is "a permissionless off-chain agent." — [same](https://docs.hyperlane.xyz/docs/applications/use-cases/cross-chain-swaps-with-recovery)

**Contract-held stake on Bittensor EVM**
- When a contract calls staking precompile V2 (`0x…0805`), "the contract's mirror is the coldkey, so the contract owns the position." Amounts are in rao (1e9 per TAO), not wei, so contracts must convert `msg.value / 1e9`. — [Bittensor: stake from EVM](https://www.bittensor.com/llms.mdx/docs/guides/evm/stake-from-evm/content.md)
- V2 functions include `addStakeLimit(hotkey, amount_rao, limit_price_rao_per_alpha, allow_partial, netuid)`, `removeStakeLimit`, `removeStakeFullLimit`, `moveStakeLimit`, `transferStake(destination_coldkey, …)`, `claimRoot`, `unstakeAll`, `swapStake`, plus proxy and `approve`/`transferStakeFrom` allowance functions. — [Staking V2 precompile](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)
- `setRejectStakingHotkeyGrowth` defaults to false. When enabled, incoming stake transfers may use only an existing staking hotkey or one the receiver owns. "A refused dispatch still consumes the forwarded gas." `getStakingHotkeys` paginates at 64. — [Staking V2 precompile](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)

**Alpha AMM price manipulation and sandwiching**
- Staking is a swap: TAO is sold into the subnet pool for alpha, and unstaking sells alpha back. A visible large order can be front-run. — [Bittensor staking/pools docs](https://www.bittensor.com/docs/concepts/staking-pools); [KuCoin on MEV Shield](https://www.kucoin.com/news/articles/bittensor-tao-launches-mev-shield-protecting-users-from-front-running-and-sandwich-attacks)
- MEV Shield (live around late December 2025) encrypts the signed inner call to a per-block key using ML-KEM-768 and XChaCha20Poly1305. The block author decrypts it at block build. It is on by default in btcli and the SDK. "Attempting to use MEV Shield with extrinsics signed by a hotkey will fail." — [Opentensor X](https://x.com/opentensor/status/2003918709916946769); [MEV Shield SDK docs](https://docs.learnbittensor.org/sdk/mev-protection) (search summary)
- Alpha precompile (`0x…0808`): `getAlphaPrice` is spot (TaoIn/AlphaIn). `getMovingAlphaPrice` is an EMA that is "significantly harder to manipulate through flash transactions than the spot price." Other functions include `getEMAPriceHalvingBlocks`, `simSwapTaoForAlpha`/`simSwapAlphaForTao` (fees included), `getTaoInPool`, `getAlphaInPool`, `getAlphaOutPool`, and `getSubnetVolume`. — [Alpha precompile guide](https://guides.learnbittensor.org/evm-tutorials/alpha-precompile)
- Suggested limit price: when staking, the ceiling is spot × (1 + tolerance); when unstaking, the floor is spot × (1 − tolerance). — [Bittensor staking precompile docs](https://www.bittensor.com/docs/guides/evm/stake-from-evm) (search summary)

**Oracle / NAV**
- I found no Chainlink Data Feeds on Bittensor EVM. Chainlink has CCIP there (since November 4, 2025, with LINK and WTAO as fee tokens). — [Chainlink CCIP directory](https://docs.chain.link/ccip/directory/mainnet/chain/bittensor-mainnet); [Chainlink changelog](https://dev.chain.link/changelog/ccip-on-bittensor-evm)
- A Chainlink TAO/USD feed exists on Ethereum mainnet (2% deviation threshold). I could not confirm one on Base. DIA has a TAO feed with a default 120s update. — [Chainlink TAO/USD](https://data.chain.link/feeds/ethereum/mainnet/tao-usd); [DIA](https://www.diadata.org/app/price/asset/bittensor/0x0000000000000000000000000000000000000000)
- EIP-4626 itself warns that preview methods are not always safe to read as oracles. — [DIA vault share price oracle](https://www.diadata.org/fair-value-oracle/vault-share-price-oracle/) (search summary)

**ERC-4626 inflation/donation**
- OpenZeppelin's defense adds +1 virtual asset and +10**offset virtual shares, but the base `_decimalsOffset()` is 0. OZ says this "is not fully preventing the attack." Zealynx suggests an offset of at least 3, and 6 or more for high-value vaults. Other mitigations: an atomic seed deposit (Zellic), dead shares, and reverting zero-share mints. — [OpenZeppelin](https://www.openzeppelin.com/news/a-novel-defense-against-erc4626-inflation-attacks); [Zealynx decimal offset](https://www.zealynx.io/glossary/decimal-offset); [Zellic Solera](https://reports.zellic.io/publications/solera/sections/regarding-inflation-attacks-inflation-attacks)
- When `totalAssets` comes from raw `balanceOf`, anyone can raise it by donating. The fix is internal balance tracking. — [Zealynx price per share](https://www.zealynx.io/glossary/price-per-share) (search summary)

**Async accounting (ERC-7540)**
- Lifecycle: Pending, then Claimable, then Claimed. `previewDeposit`/`previewMint` must revert for async deposits, and `previewRedeem`/`previewWithdraw` must revert for async redeems. The exchange rate is implementation-defined. Operators "effectively" control both the controller's assets and shares. Pending assets can get stuck, so the spec suggests cancellation or transferable claims. ERC-7575 is required (interface IDs `0x2f0a18c5` and `0xe3bc4e65`). — [EIP-7540](https://eips.ethereum.org/EIPS/eip-7540)
- "Naked redeemer": shares are locked or burned at request time, so if off-chain or cross-chain settlement fails, the user loses both. Most real implementations use fulfillment-time pricing with epoch batching to limit front-running of NAV updates. — [Zealynx naked redeemer](https://www.zealynx.io/glossary/naked-redeemer); [Zealynx ERC-7540](https://www.zealynx.io/research/protocol-deep-dives/erc-7540-asynchronous-settlement)
- A cross-chain vault team on the EIP-7540 forum said users cannot know the redemption amount up front ("moral hazard"). They also noted that share locking on redeem is optional in the spec. — [Ethereum Magicians](https://ethereum-magicians.org/t/eip-7540-asynchronous-erc-4626-tokenized-vaults/16153)

**Withdrawal liquidity / subnet deregistration / validator**
- Plain unstaking on Bittensor settles immediately with no unbonding delay. The minimum partial stake op is 0.002 TAO. — [Bittensor staking guide](https://www.bittensor.com/docs/guides/staking)
- Deregistration: when the 128-subnet cap is hit, the next registration removes the lowest-EMA-price subnet that is past immunity. The pool TAO is split pro-rata among alpha holders and "credited directly to each holder's coldkey rather than restaked." Sources disagree on immunity: 4 months (learnbittensor) vs. 1,296,000 blocks, about 6 months (Bittensor docs per search). Sources also disagree on whether owners are refunded. — [learnbittensor deregistration](https://learnbittensor.org/concepts/dynamic-tao/subnet-deregistration); [taostats](https://taostats.io/docs/concepts/subnets/subnet)
- One third-party analysis warns alpha holders can lose up to 96.875% through adverse AMM conversion on dissolution (unverified). — [search summary of ownyourmind.ai](https://ownyourmind.ai/tokenomics/bittensor-dtao-subnet-economics/)
- Validators can lower their take anytime but can raise their own or a child's take only once per 216,000 blocks (~30 days). Child-key changes have a 7,200-block (~24h) cooldown. — [Bittensor staking guide](https://www.bittensor.com/docs/guides/staking)
- Example child take: Taostats charges 4.5%. — [Taostats](https://docs.taostats.io/docs/are-parent-hotkeys-the-new-weight-copying)

**Admin keys / supply chain**
- Bybit lessons: verify the raw payload and recompute the SafeTxHash on a clean device. Use separate interfaces per signer, possibly built locally. Decode delegatecalls. Add an independent policy or co-signer layer. — [a16z crypto](https://a16zcrypto.com/posts/article/bybit-hack-lessons); [Cobo](https://www.cobo.com/post/the-bybit-breach-why-multi-sig-alone-isn-t-enough); [QuillAudits](https://multisiginspector.quillaudits.com/hacks/bybit-2025-02)

### Inferences (threat model, by asset path)
1. **Forged ICA message = total loss.** The ICA (or the Bittensor-side vault contract) is the coldkey for all stake. Anyone who can get a message accepted by its ISM can call `removeStakeFull` or `transferStake(attackerColdkey, …)` and drain everything. Mitigations:
   - Use a custom ISM: an AggregationIsm combining a MultisigIsm (≥5 independent validators, threshold ≥3) with a PausableIsm.
   - Don't use a raw `OwnableMulticall` ICA. Put a purpose-built Bittensor-side executor contract in its place that accepts only a small typed message set (rebalance within bounds, withdraw-to-bridge up to a daily cap) and enforces its own outflow rate limit and a hard-coded allowlist of hotkeys and destination addresses.
   - Never allow `transferStake` to arbitrary coldkeys.
2. **Synthetic USDC depeg or unbacked mint.** If the USDC warp route is forged (Autheo-style) or its collateral becomes insolvent (#8589-style), the USDC on Bittensor EVM loses value. Exposure scales with how long the vault holds USDC there and with how much USDC liquidity the outbound path needs. Swap immediately on arrival and keep withdrawal float minimal.
3. **Cross-chain intent leak, the most underappreciated MEV vector.** A rebalance or deposit dispatched from Base is publicly readable in the Base Mailbox `Dispatch` event before the relayer delivers it to Bittensor. Searchers can pre-position in the target alpha pool. MEV Shield likely doesn't help here: it protects user-signed extrinsics, and I found nothing saying it covers EVM transactions or relayer-delivered ICA calls. Mitigations:
   - Compute the limit price on the Bittensor side at execution, from `getMovingAlphaPrice` × (1 ± tight tolerance), not from a Base-side quote.
   - Use `addStakeLimit` with `allow_partial=true`.
   - Execute in small tranches (each well under 1% of the pool's TAO reserve, per `getTaoInPool`) across many blocks.
   - Never broadcast exact sizes and targets in advance.
4. **Thin USDC→TAO leg.** With about $215K in the TaoFi USDC/TAO pool (May 2026), a $50K deposit is a large fraction of depth. Per-epoch deposit throughput has to be capped to a small fraction of pool liquidity, or the swap leg has to move elsewhere (see Simplification).
5. **NAV manipulation.** Holders' NAV = Σ alpha_i × price_i. An attacker can push a held subnet's spot price up by staking into its pool (cost: fees plus round-trip slippage), redeem shares at the inflated NAV, and then unwind. In the other direction, they can depress spot price and deposit cheaply. Mitigations:
   - Value holdings at liquidation value (`simSwapAlphaForTao` on the actual position size), not spot × quantity.
   - Apply min(spot, EMA) for redemptions and max(spot, EMA) for deposits, so every error favors the remaining holders.
   - Add entry and exit fees larger than plausible manipulation profit.
   - Settle asynchronously at epoch boundaries so the attacker can't choose the pricing block.
   - The EMA lag is itself an attack surface: after a crash, redeeming at the lagging EMA overpays. Taking the min of both prices addresses this.
6. **Stale cross-chain NAV.** NAV computed on Bittensor and relayed to Base is old by one relay latency. Synchronous ERC-4626 deposits and redemptions on Base against a stale NAV are a free option for anyone watching Bittensor prices. ERC-7540 with fulfillment-time pricing (NAV computed after the request cutoff) removes the option.
7. **ERC-4626 inflation/donation on the Base vault.** A day-one empty vault is the Resupply scenario. Mitigations:
   - Use `_decimalsOffset()` ≥ 6 with USDC's 6 decimals.
   - Seed with dead shares in the deployment transaction and revert on zero-share mints.
   - Compute `totalAssets` from internal accounting, never `balanceOf`.
   - Sanity-bound every exchange rate (`> 0`, max change per epoch).
8. **Async accounting and liveness.** Assets in flight (USDC bridging, ICA calls pending, TAO returning) must be counted exactly once. Watch for:
   - Message 2 arriving before Message 1.
   - The relayer not delivering (Hyperlane relayers are permissionless but not guaranteed).
   - Swap failure leaving funds in the ICA (TaoFi's recovery model).
   - Dissolution TAO credited unexpectedly to the vault coldkey (deregistration).
   - Shares burned at request time while proceeds never arrive (naked redeemer). Escrow shares at request and burn them only at claim. Add a cancellation path and a timeout-based refund.
9. **Bank run / withdrawal liquidity.** Bittensor has no unbonding delay, but exits are bounded by AMM depth, by the USDC route's liquidity and rate limit, and by the TAO→USDC pool. First redeemers get better execution, which creates an incentive to run. Mitigations:
   - Batch redemptions per epoch, charge realized slippage only to that epoch's redeemers, and cap each epoch at a percentage of NAV. Bittensor's own basket design uses a 10%-of-NAV/day turnover budget (see Simplification).
   - Offer in-kind exit.
10. **Keeper compromise.** If the keeper only picks the timing of permissionless calls whose parameters are computed on-chain, compromise reduces to griefing: delay, or calling at worse moments within bounds.
11. **Admin and upgrade compromise.** An upgradeable proxy behind a single EOA is equivalent to custody. Bybit shows a multisig whose signers rely on one UI fails too.
12. **Validator risk.** The validator hotkey receiving stake affects yield, and its take can rise about every 30 days. A hotkey swap can leave positions retained (`HotkeySwapStakeRetained`). Spread stake across several validators, monitor take, and keep a governance-timelocked hotkey allowlist.
13. **Hotkey-list griefing (inferred from docs).** Anyone can `transferStake` dust onto the vault coldkey under new hotkeys. That grows the `StakingHotkeys` walk, which raised gas costs in the Release 478 bug. Call `setRejectStakingHotkeyGrowth(true)` on the vault coldkey at deployment.
14. **Chain governance risk.** Safe mode (2024), same-day hotfixes (2026), and the AMM curve migration (PR #3210) mean the vault should treat Bittensor runtime upgrades as events that trigger a pause. When an off-chain monitor sees a `spec_version` change, a guardian pauses rebalances until the invariant tests rerun against a fork of the new runtime.

### Gaps
- Whether MEV Shield covers EVM transactions or Hyperlane relayer-delivered transactions. I found no source either way.
- Actual alpha pool depths per subnet (TAO in pool for the top 20 subnets) as of October 2026. Query `getTaoInPool` or Taostats directly.
- The exact ISM used by the default ICA router on Bittensor EVM, and who owns that router.
- Whether Bittensor has slashing for stake delegated to misbehaving validators. I found no source and believe there is none, but did not verify.
- The default EMA half-life (`getEMAPriceHalvingBlocks`) was not documented on the page. Read it on-chain.

## Best practices: standards, controls, testing, audits, bounties, monitoring (2026)

### Takeaway
Use ERC-7540 (async) on Base with ERC-7575, epoch-batched, fulfillment-time pricing, and OZ virtual shares (offset ≥ 6) plus a seeded deposit. Layer on a hard TVL cap, per-epoch flow caps, a Safe multisig behind a timelock (48–72h+), and a guardian that can only pause or shrink caps. Make contracts immutable or minimally upgradeable. Test with Foundry invariants plus a16z/Trail of Bits ERC-4626 property suites, and fork-test against live Bittensor EVM. For audits, a realistic 2026 small-vault path is one mid-tier private audit plus a competitive contest. The cross-chain component prices like a bridge: $150K+ at top firms. Add Immunefi plus SEAL Safe Harbor and self-hosted monitoring, since hosted Defender was retired July 1, 2026.

### Cited Findings

**Standards**
- ERC-7540 requirements and security considerations are as listed above. Operators should be treated as full trust, and the spec calls for a cancellation mechanism for stuck pending requests. — [EIP-7540](https://eips.ethereum.org/EIPS/eip-7540)
- OZ virtual shares and decimals offset: the default offset is 0 and is not protective. The higher the offset, the less profitable the attack. — [OpenZeppelin](https://www.openzeppelin.com/news/a-novel-defense-against-erc4626-inflation-attacks); [OpenEden griefing case](https://hackenproof.com/reports/OPENEDCA-112)

**Hyperlane-specific controls**
- `RateLimitedIsm` runs on the destination with a 24h token bucket (`DURATION = 1 days`) and `maxCapacity` in base units (e.g., `1_000_000e6` = 1M USDC). It pairs with an origin-side `RateLimitedHook`. Nest it in an `AggregationIsm` with a `MultisigIsm` and a `PausableIsm`. It requires relayer `agents-v2.2.0` or later. "Rate limits directly bound the maximum loss from a compromised bridge." — [Hyperlane rate-limited ISM](https://docs.hyperlane.xyz/docs/protocol/ISM/standard-ISMs/rate-limited-ISM)
- Production checklist: remove the TrustedRelayerIsm (check with `hyperlane warp read -w <id>`), transfer ownership, and set the Mailbox default ISM and owner. — [Hyperlane docs](https://docs.hyperlane.xyz/docs/guides/production/warp-route-deployment/remove-trusted-relayer)

**Bittensor-specific controls**
- Use the `addStakeLimit`/`removeStakeLimit`/`removeStakeFullLimit`/`moveStakeLimit` price-bounded variants. `moveStakeLimit` is non-payable and rejects attached value. — [Staking V2](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)
- Use `getMovingAlphaPrice` (EMA) over spot for anything tamper-sensitive, and `simSwap*` to pre-check slippage. — [Alpha precompile](https://guides.learnbittensor.org/evm-tutorials/alpha-precompile)

**Testing / verification**
- a16z released ERC-4626 property tests for fuzzing and symbolic execution. Trail of Bits' Echidna properties cover rounding direction and functions that must not revert. Recon's Foundry guide covers share solvency (totalSupply ≥ sum of user shares) and price-per-share stability outside deposit and withdraw. A round-trip invariant plus no-zero-share plus raw-donation handler catches inflation attacks, but only if the harness starts from an empty vault. — [a16z crypto](https://a16zcrypto.com/generalized-property-tests-for-erc4626-vaults/); [Trail of Bits](https://blog.trailofbits.com/2023/02/27/reusable-properties-ethereum-contracts-echidna/); [Recon](https://getrecon.substack.com/p/implementing-your-first-few-invariants?r=34r2zr); [Zealynx round-trip](https://www.zealynx.io/glossary/round-trip-invariant)
- Balancer V2 shows that audits can miss rounding and precision bugs reachable only under extreme balances. Rounding direction needs explicit fuzzing with flash-loan-sized inputs. — [OpenZeppelin on Balancer](https://www.openzeppelin.com/news/understanding-the-balancer-v2-exploit)

**Audit costs and timelines (2026; vendor sources that disagree)**
- Sherlock: $5K–$150K+ overall, $5K–$15K for simple tokens, $20K–$60K for standard DeFi. Its own later article says "most protocols pay $15,000 to $40,000" for a standard pre-launch review. — [Sherlock 2026](https://sherlock.xyz/post/top-10-best-smart-contract-auditing-companies-in-2026); [Sherlock cost](https://sherlock.xyz/post/smart-contract-audit-cost)
- Zealynx 2026:
  - Standard DeFi: $50K–$100K, 3–6 weeks.
  - Bridges, L1s, and ZK: $150K–$500K+, 2–6 months.
  - Formal verification: +$20K–$50K.
  - Rush: +10–20% (body) or +30–50% (FAQ).
  - Top-tier waitlists: 2–3 months.
  - Auditor rate: ~$500/hr.
  - Competitive pools: $40K–$100K.
  - Hybrid (tier-2 firm, then contest) at about $80K is said to beat a single firm at $150K.
  - Good docs and invariant tests lower quotes 15–25%.
  - Monitoring: $2K–$10K/month.
  - Bug bounty: plan around 10% of funds at risk.
  - [Zealynx pricing 2026](https://www.zealynx.io/research/audit-ops/audit-pricing-2026)
- Competitive pools: one guide gives $15K–$150K with 1–4 week lead times. Recent Code4rena examples were $22K (Monetrix) and $40K (Rujira). Code4rena reportedly has no platform fee, a 96% conditional pool refunded if no High or Medium findings, and a separate judging fee (secondhand, unverified). Per-nSLoC pricing is commonly cited at $50–$300. — [search summary of smartcontractaudit.com / eco.com guides](https://www.smartcontractaudit.com/guides/smart-contract-audit-pricing-2026)

**Bug bounty / Safe Harbor**
- Immunefi's SEAL Safe Harbor page (updated September 9, 2026) describes whitehats rescuing funds to a protocol-controlled vault, with KYC and a 6-hour return window. — [Immunefi Safe Harbor](https://immunefi.com/bug-bounty/immunefi/safe-harbor/)
- Typical terms: Lido 10% of recovered funds. Compound 10%, capped at 60% of the max critical reward, with no extra cost to Immunefi or SEAL. Lazy Summer used a $100K aggregate cap and 72h return. SEAL offers self-adoption, free onboarding help, or the Immunefi route. — [Lido docs](https://docs.lido.fi/security/safeharbor); [Compound proposal](https://www.tally.xyz/gov/compound/proposal/391); [SEAL checklist](https://frameworks.securityalliance.org/safe-harbor/self-checklist)

**Monitoring and incident response**
- OpenZeppelin Defender's hosted service retired on July 1, 2026. Its replacements are the self-hosted open-source Relayer (EVM, Solana, Stellar) and a Rust/YAML Monitor, both shipped as Docker images. Keys could not be exported from Defender's AWS KMS, so migrating meant new signer addresses and on-chain permission updates. — [OZ Defender sunset FAQ](https://www.openzeppelin.com/news/defender-sunset-faq); [KeeperHub migration guide](https://docs.keeperhub.com/guides/defender-migration) (vendor)
- Hypernative markets automated pre-authorized actions (pauser roles, Safe, guardian contracts). It reports flagging the Parallel stablecoin attack (May 2026). Forta Firewall, launched 2024, does pre-execution attestation, so a risky transaction reverts without the attestation. Tenderly covers simulation and alerting. Claims and pricing were not independently verified. — [Hypernative](https://www.hypernative.io/industry/protocols); [The Block on Forta Firewall](https://www.theblock.co/post/327244/a16z-forta-firewall-smart-contract-exploits)
- Zodiac Roles Modifier v2 scopes a Safe module or keeper by target, function, and parameter conditions, with spending allowances. ENS migrated to it (EP 5.12). — [Zodiac Roles README](https://github.com/gnosisguild/zodiac-modifier-roles/blob/main/README.md); [ENS EP 5.12](https://docs.ens.domains/dao/proposals/5.12)

### Inferences
- **Recommended control stack for cascade:**
  1. Base vault: ERC-7540 async deposit and redeem, ERC-7575 `share`, epoch settlement, decimals offset 6, dead-share seed, internal `totalAssets`, a per-epoch NAV-change bound (e.g., reject settlement if NAV moved more than X% vs. the prior epoch without a guardian ack), and request cancellation plus a timeout refund.
  2. Caps: a global TVL cap (start at $100K–$500K given ~$215K USDC/TAO depth), a per-address cap, a per-epoch inflow and outflow cap, and Hyperlane `RateLimitedIsm` plus `RateLimitedHook` at or below the TVL cap.
  3. Roles: Owner = Safe (e.g., 3-of-5, hardware wallets, signers on separate clients) behind a TimelockController (≥72h for upgrades, ISM changes, and hotkey allowlist changes). Guardian = 1-of-N fast key or monitor bot that can only pause or lower caps, never move funds or raise limits. Keeper = no special privilege, ideally permissionless functions.
  4. Upgradeability: non-upgradeable core accounting. If a proxy is unavoidable, use UUPS behind the timelock and have the guardian able to irrevocably disable upgrades later.
  5. Tests: Foundry invariant suites with handlers for deposit, request, settle, claim, donate, cancel, and bridge-delay/reorder. Add a16z ERC-4626 properties adapted for async, plus a mock Hyperlane Mailbox and a Bittensor precompile mock calibrated against fork tests on live Bittensor EVM (chain ID 964). Run Halmos or Certora on the share math if budget allows (+$20–50K).
- **Budget, my reading of vendor ranges.** A tight, small-scope pair of contracts (Base vault plus Bittensor executor, roughly ≤1,500 nSLoC):
  - Private audit: about $30K–$80K from a mid-tier firm.
  - Competitive contest: about $25K–$60K pool on Code4rena, Sherlock, or Cantina.
  - Expect 4–10 weeks including lead time, and 2–3 months for top-tier firms.
  - If cascade writes custom Hyperlane routing, ISMs, or a custom bridge, expect bridge-tier pricing of $150K+.
  - Using the stock Hyperlane ICA and warp route, as TaoFi does, keeps scope small but inherits the open #8589 question.
- Launch the bug bounty at audit completion with a max critical of about 10% of the TVL cap, and adopt SEAL Safe Harbor (no extra fee). Both are cheap relative to the risk.

### Gaps
- No firm-specific 2026 rate cards were found for Spearbit/Cantina, Zellic, OpenZeppelin, or Trail of Bits.
- Hypernative and Forta Firewall pricing for small protocols. Forta Firewall's availability on Bittensor EVM is unknown, likely not supported.
- I found no Certora or Halmos ERC-4626/7540 spec libraries in this pass.

## Automation without a trusted operator (keepers, oracles, rebalancing)

### Takeaway
The 2024–2025 automation stack has largely gone away. Gelato Web3 Functions/Automate is deprecated (third-party sources say shutdown March 31, 2026). Chainlink Automation is "being deprecated" in favor of Chainlink CRE. Chainlink Functions mainnet shut down September 1, 2026. OZ Defender's hosted service retired July 1, 2026. CRE supports Base but does not list Bittensor EVM, and I found no Chainlink price feeds on Bittensor EVM. The robust pattern is to make every rebalance and settlement function permissionless and fully parameterized on-chain. Then anyone can be the executor (CRE on Base, a self-hosted OZ Relayer, KeeperHub, or the founder's own bot), and the executor's key carries no meaningful power.

### Cited Findings
- Chainlink's Automation registration page says "Chainlink Automation is being deprecated," with CRE as the replacement. It gives no date. A third-party post claims Automation v1.x sunset June 30, 2026 and v2.1 sunset July 31, 2026 (unverified). — [automation.chain.link](https://automation.chain.link/sepolia/new); [dev.to](https://dev.to/0xramprasad/chainlink-runtime-environment-cre-2nh0)
- Chainlink Functions: subscriptions had to migrate to CRE before the mainnet shutdown on September 1, 2026. — [Chainlink CRE migration docs](https://docs.chain.link/cre/reference/clf-migration-ts)
- CRE supported mainnets (docs updated May 2026): ADI, Arbitrum One, Avalanche, Base, BNB, Celo, Ethereum, Gnosis, Hyperliquid, Ink, Jovay, Linea, Mantle, MegaETH, OP Mainnet, Pharos, Plasma, Polygon, Scroll, Sonic. Bittensor is not listed. — [Chainlink CRE supported networks](https://docs.chain.link/cre/supported-networks)
- Aave (forum post, March 31, 2026): Aave Robot moved to CRE because Gelato's automation and Web3 Functions are "being deprecated." The CRE workflow, TypeScript compiled to WASM and run by the DON, calls `checkUpkeep()`, submits a signed report to `MailboxCRE`, which calls `performUpkeep()`. `MailboxCRE` has no access restrictions "because all robot actions are permissionless." — [Aave governance](https://governance.aave.com/t/integration-of-chainlink-cre-into-aave-robot/24366)
- Gelato Web3 Functions (TypeScript, Solidity Functions, Automated Transactions) shut down March 31, 2026, per KeeperHub, a competitor. Gelato's own docs confirm only the earlier Legacy Automate deprecation on June 30, 2024. — [KeeperHub Gelato migration](https://docs.keeperhub.com/guides/gelato-migration); [Gelato legacy migration](https://docs.gelato.cloud/web3-services/web3-functions/legacy-automate-migration-guide)
- KeeperHub supports Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, and other EVM chains. The authoritative list is `GET /api/chains`. I could not confirm Bittensor support. — [KeeperHub concepts](https://docs.keeperhub.com/concepts)
- Chainlink CCIP has been live on Bittensor EVM since November 4, 2025, with LINK and WTAO fee tokens. I found no Chainlink Data Feeds or Automation there. — [Chainlink CCIP Bittensor](https://docs.chain.link/ccip/directory/mainnet/chain/bittensor-mainnet); [changelog](https://dev.chain.link/changelog/ccip-on-bittensor-evm)
- On-chain price data on Bittensor EVM comes natively from the alpha precompile (spot, EMA, reserves, `simSwap`). No external oracle is needed for alpha/TAO. — [Alpha precompile](https://guides.learnbittensor.org/evm-tutorials/alpha-precompile)
- Bittensor's own basket trading (v461) uses on-chain guardrails: a 2% per-leg price band, a daily turnover budget (token bucket, 10% of NAV/day), a 10% per-pool liquidity cap, and a 1/16 concentration cap. It "launches gated off." — [Bittensor releases](https://www.bittensor.com/releases)
- OZ's open-source Relayer and Monitor are the self-hosted replacements for Defender. — [OZ Defender sunset FAQ](https://www.openzeppelin.com/news/defender-sunset-faq)
- Gelato's oracle supported-networks page did not show Bittensor in cached text. Unverified. — [Gelato oracles](https://docs.gelato.cloud/web3-services/oracles/supported-networks)

### Inferences
- **Keeperless-by-design pattern:**
  - **Bittensor side.** Expose `rebalance()` on the executor contract with no arguments, or only a bounded tranche index. The contract reads `getMovingAlphaPrice`, `getTaoInPool`, and `getAlphaOutPool` for its subnet universe and computes target weights by an on-chain rule (e.g., top-N by EMA market cap, capped at 1/16 or 10% each, mirroring Bittensor's own basket guardrails).
  - It computes the next tranche size as min(drift, x% of pool TAO reserve, per-day turnover budget) and executes `addStakeLimit`/`removeStakeLimit` with a limit price of EMA × (1 ± ~0.5–1%) and `allow_partial=true`.
  - Enforce a minimum interval in blocks between calls, and pay a small fixed bounty from vault yield so any third party is incentivized to call.
  - **Base side.** `settleEpoch()` is callable by anyone after the epoch ends and after the NAV message from Bittensor arrives. NAV is computed on Bittensor at a deterministic block by the executor and dispatched via Hyperlane. Base accepts it only within sanity bounds vs. the prior NAV, and optionally cross-checks the TAO/USD component against a Chainlink or DIA TAO/USD feed on Base if one exists.
- **Executor options in October 2026:**
  - Base: Chainlink CRE (Base supported; `MailboxCRE`-style permissionless report forwarding), self-hosted OZ Relayer, or KeeperHub.
  - Bittensor EVM: no major managed automation network is confirmed. Run a self-hosted bot (OZ Relayer or a simple cron service with a KMS-held low-value key) and rely on permissionless incentives as a backup.
  - Hyperlane relayer liveness is also an "automation" dependency. Run your own Hyperlane relayer for cascade's message routes as a backstop alongside the permissionless public relayer.
- **Minimizing keeper power:**
  1. The keeper is not on any allowlist, because functions are permissionless.
  2. If allowlisting is unavoidable, scope it with Zodiac Roles v2 (target, function, parameter conditions, allowances).
  3. Keeper keys hold only gas money.
  4. All size and price parameters come from on-chain state.
  5. A guardian monitor (self-hosted OZ Monitor or Hypernative/Forta) can pause, but cannot move funds.
- A pure on-chain rule avoids any off-chain "index committee" key. The trade-off is reflexivity: a market-cap-weighted index buys what is already pumped. EMA-based weights and concentration caps dampen this.

### Gaps
- No official Chainlink date for Automation contract shutdown on Base. No official Gelato notice of the March 31, 2026 shutdown (sources are a vendor and the Aave forum).
- Whether any keeper network (KeeperHub, Powerloom, CRE) supports Bittensor EVM chain 964. None was found.
- No confirmed Chainlink TAO/USD feed on Base.

## Simplification options that cut risk

### Takeaway
The biggest risk reducer found is Bittensor's own native root baskets, live since v441/v450 (July–August 2026). Each root validator now runs an escrowed, validator-curated index fund of subnet alpha with a 1/16 concentration cap. Root stake enters and exits at face value, with no swap, slippage, or MEV, and `claimRoot` is exposed in the EVM staking precompile. A "USDC on Base → TAO → root stake with a few top validators" product would remove alpha-AMM sandwiching, per-subnet NAV manipulation, deregistration handling, and most rebalancing automation. What remains is bridge and ICA trust, the thin USDC/TAO leg, and validator-curation risk.

Other strong simplifiers:
- Per-user ICAs (TaoFi's existing pattern), which avoid pooled share pricing entirely.
- Withdraw-in-kind on Bittensor.
- A hard-capped beta sized to pool depth.

### Cited Findings
- **Root baskets:** "Each root validator runs an escrowed index fund of subnet alpha," built from dividends. It is reshaped only via `swap_basket`, and root stakers hold a pro-rata claim. Moving TAO into or out of root "is not a pool swap, so there is no swap fee, slippage, or MEV exposure." The claim fee scales with the number of alpha types (about τ0.057 for a full 128-holding basket). Claims below 500,000 rao are skipped but keep accruing. If `RootStakeUnlockInterval` is nonzero, a claim refreshes the hold, so claim and unstake can't be atomic. — [Bittensor staking guide](https://www.bittensor.com/docs/guides/staking)
- **Release timeline:** v441 (July 2026, "Root Reborn": root dividends become validator-curated baskets), v450 (August 2026, "Curated Beta": `set_root_weights` with a 1/16 concentration cap; the chain computes the basket index and staker yield), and v461 (September 2026, `swap_basket` with guardrails, "launches gated off"). — [Bittensor releases](https://www.bittensor.com/releases)
- The EVM staking precompile V2 includes `claimRoot`, which "redeems every validator basket for the mapped caller." — [Staking V2](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)
- **Per-user ICA:** the TaoFi/Hyperlane pattern gives each user a salted ICA, so "funds are partitioned by user and can be managed or refunded safely if a swap fails." — [Hyperlane docs](https://docs.hyperlane.xyz/docs/applications/use-cases/cross-chain-swaps-with-recovery); [Hyperlane/TaoFi post](https://www.hyperlane.xyz/post/hyperlane-unlocks-the-bittensor-ecosystem)
- **In-kind exit primitives:** `transferStake(destination_coldkey, hotkey, origin_netuid, destination_netuid, amount_alpha)` and `unstakeAll` exist in the precompile. — [Staking V2](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2)
- **Capped launch precedent:** TaoFi capped its bridge at $10M TVL at launch. — [Hyperlane Medium](https://medium.com/hyperlane/accelerating-defi-on-bittensor-with-taousd-93bc723c742d)
- **Alternative rails:** Project Rubicon (General TAO Ventures, announced November 19, 2025) issues xAlpha (1:1 liquid-staked alpha ERC-20s) on Base via Chainlink CCIP, with Aerodrome xAlpha/USDC pools seeded at about $300K per subnet across 17 subnets. HashLock audited it in October 2025. Kelp migrated rsETH from LayerZero OFT to Chainlink CCT after its exploit. — [Crypto Times](https://www.cryptotimes.io/2025/11/19/chainlink-ccip-drives-project-rubicons-defi-expansion/); [Chainlink X](https://x.com/chainlink/status/1991129903182299421); [HashLock](https://hashlock.com/audits/rubicon); [Unchained](https://unchainedcrypto.com/kelp-dao-claims-layerzero-approved-the-setup-it-blamed-for-292-million-hack-migrates-to-chainlink/)
- Wrapped alpha (xAlpha, vAlpha, vTAO) trades only on Base via Aerodrome. There is no alpha pool on Bittensor EVM itself. — [Manifold Labs](https://manifoldlabs.substack.com/p/bittensors-liquidity-has-nowhere)

### Inferences (ranked by risk removed per unit of complexity)
1. **Root-basket product (highest leverage).** The vault converts USDC to TAO and root-stakes it across 2–4 vetted root validators selected under a timelocked allowlist.
   - NAV becomes TAO plus accrued basket yield. TAO price can come from a Chainlink or DIA TAO/USD feed or the TAO/USDC pool, and no per-subnet alpha prices enter share pricing.
   - Rebalancing is delegated to validators' on-chain-guardrailed baskets, so cascade's automation reduces to periodic `claimRoot` and epoch settlement.
   - Risks:
     - Validator curation quality and conflicts of interest.
     - `swap_basket` is gated off as of v461, so baskets reflect where dividends were earned rather than an active index.
     - It is a new mechanism (2–3 months old) that may change again.
     - Product differentiation shrinks (a business question, out of scope here).
2. **Per-user ICAs instead of pooled shares.** Each user's assets sit in their own salted ICA on Bittensor EVM. This removes ERC-4626 inflation attacks, NAV manipulation, bank-run socialization, and the naked-redeemer problem. Remaining costs and risks:
   - Gas scales per user, and rebalances happen per user, which suits a "rule-based autopilot" applied per account.
   - Users can still be hurt by ICA/ISM compromise.
   - Pooled-vault "index" economics (shared rebalance cost) are lost. A hybrid is possible: per-user ICAs plus a shared, permissionless rebalance routine that each ICA opts into.
3. **Withdraw-in-kind on Bittensor.** By default, redemption delivers TAO or pro-rata alpha (`transferStake` to the user's coldkey) on Bittensor. USDC-on-Base exit is a slower optional path with its own epoch cap and slippage charged to the redeemer. This removes the vault's dependency on the thin USDC/TAO pool and the bridge-out leg for most exits, and removes the incentive to run.
4. **On-chain rule-based weights.** Compute weights from precompile data (EMA prices, alpha outstanding) with caps of 1/16 to 10% per subnet. Exclude subnets past immunity that rank near the bottom by EMA price, since they are deregistration candidates. Use the deterministic formula as the "index committee." No off-chain signer then has influence.
5. **Capped beta.** Start with a hard TVL cap that is a small multiple of the shallowest leg. With about $215K USDC/TAO depth on Bittensor EVM, something like $100K–$250K, rising only via timelocked governance after weeks of clean operation and a completed audit and contest. Add a per-wallet cap and per-epoch flow caps at or below the RateLimitedIsm capacity.
6. **Single-chain alternative.** Hold xAlpha on Base (Project Rubicon via CCIP) and run an ordinary ERC-4626 on Base. This removes cascade's own cross-chain messaging entirely, but swaps in Rubicon issuer and CCIP risk and about $300K-per-subnet Aerodrome liquidity (launch figure). A further option is to choose CCIP rather than Hyperlane for any custom cross-chain leg, since Chainlink CCIP is live on Bittensor EVM. It isn't automatically safer, but its verifier set isn't left to the app deployer.

### Gaps
- Whether root baskets are fully accessible and claimable from an EVM contract coldkey in practice. `claimRoot` is in the ABI, but fees, unlock interval, and per-validator claim limits for contracts were not tested.
- Current Project Rubicon TVL, liquidity, and incident history after launch were not found.
- How validator basket composition is set when `swap_basket` is gated off, i.e., how "curated" baskets actually are as of October 2026. The docs are thin on this.
