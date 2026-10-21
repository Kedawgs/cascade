# cascade.fi: Consumer UX Patterns on Base and the Regulatory Risk Map for a Fee-Charging Subnet Index Vault

_Research notes, current as of 2026-10-20. This is research, not legal advice. Tags: **[older]** means the item predates 2026 and may have changed; **[secondary]** means commentary or an aggregator rather than a primary source; **[single source]** means it needs confirmation; **[background]** means the claim comes from general domain knowledge and was not verified in this session._

---

## A1. Onboarding tooling on Base in 2026 (wallets, passkeys, gas sponsorship, on-ramps, mini apps)

### Takeaway
The lowest-friction Base stack in late 2026 has four parts. Users sign in with a passkey Base Account and/or an embedded wallet (Privy, Dynamic or CDP) that uses smart accounts. CDP Paymaster sponsors gas, so users never need ETH. Coinbase's **Headless** Onramp API handles USDC funding by Apple Pay or card; the hosted-widget guest checkout was discontinued on 30 June 2026. The product ships as a **standard web app** (wagmi/viem plus SIWE), because the Base App stopped honouring the Farcaster mini-app spec on 9 April 2026. Sub Accounts plus Spend Permissions can remove the repeated passkey prompts.

### Cited Findings
- **Base Account Sub Accounts.** A Sub Account is an app-specific address derived from the user's parent Base Account. Its owner can be an embedded wallet or a local key, and it can be configured to skip passkey confirmation on each transaction. Without Sub Accounts, every signature needs a passkey prompt. — [Privy Docs: Base sub accounts](https://docs.privy.io/recipes/react/external-wallets/base-sub-accounts)
- **Spend Permissions.** These let a Sub Account draw on the parent account's balance without prompts, so no separate funding flow is needed. "Auto Spend Permissions" are on by default: when a Sub Account is short of funds, it requests a transfer from the parent and can optionally set up ongoing permissions. — [Base Docs: Sub Accounts](https://docs.base.org/base-account/improve-ux/sub-accounts); the SDK `subAccounts` config can switch this to manual funding — [Base SDK reference](https://docs.base.org/sdks/base-account/reference/core/createBaseAccount)
- Users can revoke spend permissions in their account settings, which requires a passkey signature. — [Coinbase Help](https://help.coinbase.com/en/wallet/getting-started/smart-wallet-permissions)
- `prepareSpendCallData` returns the calls needed to spend, and these can be batched through `wallet_sendCalls`. A manager contract validates Spend Permission calls. — [Base Docs: Spend Permissions](https://docs.base.org/base-account/improve-ux/spend-permissions); [Base blog: From Session Keys to Sub Accounts](https://blog.base.dev/subaccounts)
- **[older]** Sub Accounts were announced in Feb 2025 and slated for mainnet in Q2 2025. I found no explicit 2026 GA or changelog statement; the docs are live. — [Base Build on X](https://x.com/buildonbase/status/1895223624740835624)
- Privy documents integration with both Base Sub Accounts and the Base app as external wallets. — [Privy Docs: Integrating the Base app](https://docs.privy.io/recipes/react/external-wallets/base-app)
- **Base App moved away from mini apps.** After 9 April 2026, the Base App treats every app as a standard web app regardless of Farcaster manifests, and several Farcaster SDK methods are no longer invoked. The replacements are wagmi-based sign-in and transfers, plain `window.open`, and Base deeplinks. Farcaster sign-in and FID identity are not available in the Base App, so apps should use SIWE plus the connected wallet address. — [Base Docs: Migrate to a Standard Web App](https://docs.base.org/apps/guides/migrate-to-standard-web-app). Note: a later WebFetch of this URL returned the Base docs overview page, so the page may have moved. The content above comes from the search index.
- **[secondary]** A third-party write-up says Base announced the change on 12 March and that Neynar-powered notifications in the Base App ended on 9 April. The Base Notifications API targets wallet addresses. Farcaster clients can still run mini apps. — [Paragraph/arcabot](https://paragraph.com/@arcabot/base-and-farcaster-split-the-mini-app-stack)
- **[opinion]** One commentator says the Base App pivoted to "trading-first" after it deprecated mini apps. — [Nicky Sap Substack](https://nickysap.substack.com/p/are-we-still-doing-mini-apps)
- Base docs now organise builder guides by outcome. One is "Integrate DeFi: … a vault-based earn product." — [docs.base.org](https://docs.base.org/apps/guides/migrate-to-standard-web-app) (overview page as fetched)
- **Coinbase Onramp (official FAQ):**
  - The hosted-widget **Guest Checkout (debit card, Apple Pay) was discontinued on 30 June 2026**. Developers are directed to the **Headless Onramp API**, which is available "immediately after your app is approved."
  - Guest checkout had worked without a Coinbase account in the US, UK and Canada.
  - Apple Pay and Google Pay have a minimum of about $5. Credit cards cost 2.5% and ACH 0.5%. Coinbase pays network fees, and Onramp is free for developers.
  - **Zero-fee USDC is only for "select partners" through a subsidy program.**
  - Coverage: debit cards in the US plus 90+ countries; credit cards in 90 countries, not including the US; ACH in the US only.

  — [CDP Onramp FAQ](https://docs.cdp.coinbase.com/onramp/additional-resources/faq)
- In the headless flow, users need only SMS and email verification, with no Coinbase account. **Apple Pay works only in Safari; other browsers show a QR code.** — [Coinbase: Headless onramps launch](https://www.coinbase.com/developer-platform/discover/launches/headless-onramps)
- Coinbase's product page says buying and transferring USDC on Base is free, which conflicts with the FAQ's partner-only zero-fee wording. One third-party comparison reports about 3.99% on Apple Pay or Google Pay for non-Coinbase users. — [Coinbase Onramp product page](https://www.coinbase.com/developer-platform/products/onramp); [Eco comparison](https://eco.com/support/en/articles/15210390-best-stablecoin-onramps-2026-moonpay-transak-coinbase-onramp-compared) **[secondary, conflicting]**
- **Embedded wallets.** The sources below are competitor-written, so treat them as directional.
  - CDP's Paymaster gas sponsorship works only on Base.
  - CDP embedded wallets can opt into smart accounts, which unlocks gas sponsorship and spend permissions.
  - CDP server wallets keep keys in secure enclaves.

  — [Alchemy comparison](https://www.alchemy.com/overviews/best-infrastructure-for-agentic-payments); [Openfort: Coinbase wallet alternatives](https://www.openfort.io/blog/coinbase-wallet-alternatives)
- Privy uses third-party paymasters (Alchemy, Pimlico). Its pricing is reported as a free tier, then $299/month, but sources give different MAU thresholds. — [Openfort: Privy alternatives](https://www.openfort.io/blog/privy-alternatives); [The Signal: AA providers compared](https://thesignal.directory/n/account-abstraction-providers-compared-2026) **[secondary, conflicting]**
- Dynamic has no paymaster of its own and integrates ZeroDev, Biconomy and Alchemy. It reportedly starts at about $249/month for 5,000 MAU, and its strength is auth and onboarding UX. — [Chainscore: Dynamic vs Privy](https://chainscorelabs.com/comparisons/wallets-eoa-vs-smart-contract-wallets/client-side-integration/dynamic-vs-privy-embedded-wallet-and-auth-platforms) **[secondary]**

### Inferences
- **Two entry personas, one auth layer.**
  - Coinbase users already have USDC and a passkey Base Account, so offer them "Sign in with Base".
  - Crypto newcomers should get email or social login into an embedded smart wallet (Privy or CDP Embedded), funded through Headless Onramp with Apple Pay.
  - Privy supports Base Account as an external wallet, so both personas can share one integration.
- **Keep a USDC-only mental model.** Sponsor all gas with CDP Paymaster, and batch approve and deposit into one signature (`wallet_sendCalls`, EIP-5792 style batching).
- **Onramp economics can swamp the vault fee.** A 2.5–4% card or Apple Pay fee on a $200 first deposit may cost more than years of a "small" management fee, so applying for Coinbase's zero-fee USDC partner subsidy is worth it.
- **Regulatory side benefit:** with Coinbase Onramp, the fiat-to-USDC leg (and its KYC and money-transmission obligations) sits with Coinbase, not cascade.
- **Don't build a Farcaster mini app as the primary channel.** Build a standard mobile web app that also works inside the Base App's browser.

### Gaps
- Current (Oct 2026) pricing and terms for Privy, Dynamic and CDP Embedded Wallets could not be verified from primary sources.
- I did not verify OnchainKit or RainbowKit status and maintenance in 2026; there may have been consolidation into Base Account tooling.
- The Headless Onramp app-approval criteria (KYB, use-case restrictions) are not stated in the FAQ.

---

## A2. UX patterns from well-regarded consumer vault and earn products

### Takeaway
The most-used consumer earn flow on Base is Coinbase's USDC lending via Morpho. It hides protocol complexity behind one "Lending" tab, names the curator (Steakhouse), shows a floating rate with "no lock-ups", and creates a smart wallet in the background. Detail on the curator, the underlying markets and the exposure sits one layer down. I could not find verified 2026 UX teardowns for Yearn v3, Spark, Ethena, Index Coop, Glider, or the Rainbow and Phantom earn tabs.

### Cited Findings
- **[older]** Coinbase launched onchain USDC lending in September 2025, advertising up to 10.8% at launch. Users lend without leaving the Coinbase app. — [Blockworks](https://blockworks.com/news/coinbase-usdc-onchain); [The Block](https://www.theblock.co/post/371281/coinbase-usdc-onchain-lending)
- It runs on Base through Morpho, with vaults curated by Steakhouse Financial. An update dated 11 June 2026 lets users choose between **two Steakhouse-curated vaults**. One is a "High Yield" USDC vault that lends against collateral that includes Ethena-linked assets. — [Coinbase blog](https://www.coinbase.com/blog/earn-competitive-yields-by-lending-your-usdc)
- **The flow:**
  - A deposit in the Lending tab is routed to Morpho, then into a Steakhouse-curated vault.
  - Rates float with onchain supply and demand.
  - There are **no lock-ups**.
  - Coinbase One members get a boosted rate where available.

  — [Coinbase blog: Brazil and Canada expansion](https://www.coinbase.com/blog/coinbase-usdc-earning-brazil-canada)
- Coinbase creates a smart contract wallet for the user when they deposit. — [The Block](https://www.theblock.co/post/371281/coinbase-usdc-onchain-lending)
- **[secondary, unverified]** The integration has reportedly driven nearly $500M of USDC into Morpho vaults on Base. — [Crypto Briefing](https://cryptobriefing.com/base-onchain-lending-usdc-vaults/)
- **[secondary, single source]** A "Base Earn and Borrow" path reportedly lets apps route customer USDC into Morpho or Aave markets on Base, citing a 4.45% average stablecoin yield before incentives. — [Stablecoin Insider](https://stablecoininsider.org/base-earn-and-borrow/)
- **Opacity is the common failure.** Many vault products are black boxes with little beyond a headline APY and a broad mandate. Vaults with different strategy labels can share about 80% of the same underlying Morpho markets. — [Chaos Labs](https://chaoslabs.xyz/posts/defi-s-black-box-how-risk-and-yield-are-repackaged)
- **Reserve Index DTFs (the closest onchain analogue to a basket index):**
  - An Index DTF is an ERC-20 basket of a few to hundreds of tokens.
  - It charges a continuous **TVL fee plus a mint fee**; the platform's take buys and burns RSR.
  - Rebalancing runs through **Dutch auctions** with configurable price ranges and needs a rebalance-manager role.
  - Governance can use any ERC-20, including vote-locked tokens.

  — [Metalamp: Reserve Finance](https://metalamp.io/magazine/article/reserve-finance); [Reserve Index DTF FAQ (mintlify mirror)](https://mintlify.wiki/reserve-protocol/reserve-index-dtf/resources/faq) **[secondary/mirror]**

### Inferences
- **Home screen pattern for Cascade:**
  - One big number: current value in USD.
  - One change line: P&L since deposit in $ and %.
  - A composition list or donut showing subnets and target vs actual weights.
  - The next rebalance date.
  - The fee expressed in dollars per year at the current balance.
- **Name the methodology the way Coinbase names its curator.** For example: "Index rule: top N subnets by [metric], each capped at X%, rebalanced [weekly]". This is a trust signal, and (see B1) a fixed, rules-based methodology also helps the legal analysis.
- **Don't headline an APY for a dTAO index.**
  - **[background]** Returns from subnet alpha are dominated by alpha price moves versus TAO and USD, not by staking emissions.
  - Show "staking rewards earned" separately from "price change", and use trailing performance windows (7d, 30d, since inception) instead of a projected APY.
- **Transparency page (Reserve/Morpho-style):**
  - Contract addresses on Base and on the Bittensor side.
  - Live holdings per subnet.
  - A rebalance history log with transaction links.
  - Fees collected to date.
  - Audit reports.
  - Admin roles, multisig signers and timelock durations.
  - Pause and guardian powers.
  - A "what can the team do with your funds" plain-English box.

### Gaps
- No verified 2026 UI details for Yearn v3, Spark, Ethena, Index Coop, Glider, or the Rainbow and Phantom earn tabs. Searches returned generic or unrelated content.
- No primary source shows exactly how Coinbase presents curator risk disclosures inside the Lending tab.

---

## A3. Communicating risk clearly and standard disclosures

### Takeaway
Put plain-language risk at the point of decision, before deposit, and layer it: a short summary with "learn more" links. Never use fixed-income, "guaranteed" or "notes" language. That is a UX choice, but it is also legal hygiene: in BarnBridge, marketing language drove the SEC's securities and investment-company findings.

### Cited Findings
- A headline APY can mislead. Two strategies with the same APY can carry very different risk, so show the yield sources and the underlying exposure, not just a label. — [Chaos Labs](https://chaoslabs.xyz/posts/defi-s-black-box-how-risk-and-yield-are-repackaged)
- Guidance from a low-quality source: show audits and other security information, explain smart-contract risk plainly, and "never hide important information behind multiple clicks". Show real-time progress and estimated completion time for transactions. — [Nadcab DeFi UX practices](https://www.nadcab.com/blog/defi-ui-ux-best-practices) **[secondary, low quality]**
- **The BarnBridge lesson (2023 settled SEC action):**
  - SMART Yield pools took in more than $509M from 1,235 addresses.
  - They were marketed as fixed income with senior and junior tranches.
  - The SEC found the instruments were securities and the pools were an unregistered investment company.
  - **The co-founders were personally liable as control persons, regardless of the DAO label.**

  — [Croke Fairchild "Vault Vacuum" alert, Aug 10 2026](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/)
- The same alert's analysis suggests these practices:
  - Describe receipt tokens as proportional claims, not promised returns.
  - Avoid "notes" and fixed-income framing.
  - Disclose looping, liquidation triggers and counterparty dependencies.
  - Use guardians or sentinels and timelocks (about 3 days).

  — [Croke Fairchild](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/)
- The SEC's protocol-staking safe zone covers only rewards that are not "fixed, guaranteed, or greater than those awarded by the protocol." Return framing therefore matters legally. — [SEC CorpFin Protocol Staking Statement, May 29 2025](https://www.sec.gov/newsroom/speeches-statements/statement-certain-protocol-staking-activities-052925)
- **EU:** under MiCA reverse-solicitation analysis, national regulators assess language, disclaimers and targeting practices. — [CMS](https://cms.law/en/lux/legal-updates/reverse-solicitation-regime-exempting-third-country-firms-from-micar-authorisation-requirements)
- **UK:** qualifying cryptoassets are "restricted mass market investments" for financial-promotion purposes. — [Regulation Tomorrow (FCA policy statements roundup)](https://www.regulationtomorrow.com/2026/06/fca-publishes-cryptoassets-regime-policy-statements-finalised-guidance-and-two-further-guidance-consultations/)

### Inferences
- **A disclosure set for Cascade, as short cards with a one-time acknowledgement checkbox and a persistent "Risks" link:**
  1. You can lose money. Subnet alpha tokens are volatile and can be illiquid.
  2. Smart-contract risk, covering the Base vault, the bridge, and the Bittensor-side contracts and keys.
  3. Bridge and cross-chain delay or failure risk.
  4. Exit liquidity and slippage risk in thin subnet pools.
  5. USDC depeg risk.
  6. Admin and operator powers: what the team can and cannot do, and the timelock.
  7. Fees, in dollars.
  8. Not insured, not a bank deposit, no guaranteed return.
  9. Geographic restrictions.
- **Calibrate the tone.** Lead with "what this is" and "how you can exit", then risks. Avoid numeric "risk scores" that read like a credit rating. Use a qualitative tag such as "High volatility" with a one-line explanation.

### Gaps
- I found no primary UX research measuring how risk-disclosure formats affect conversion or comprehension in crypto earn products.
- I found no sample terms of service or risk-acknowledgement language from top vaults; reviewing live ToS from Morpho, Yearn and Coinbase directly would be a next step.

---

## A4. Cross-chain and multi-step deposit progress UX (flows taking 1–2+ minutes)

### Takeaway
Model each deposit as an **order** with a persistent ID and explicit stages. Poll a status API, show confirmation for each stage with explorer links, set time expectations before the user signs, and make refunds a first-class state: say where and in what asset the refund lands.

### Cited Findings
- **Across.** Relayers fill deposits quickly from their own capital. If no relayer fills, LP funds make a **slow fill a few hours later**. Relayers are repaid after an optimistic challenge period of about 2 hours. Deposits can also expire, and the depositor gets the relayer fee back on a slow fill. — [Across docs: Intent lifecycle](https://docs.across.to/concepts/intent-lifecycle-in-across)
- **Relay.** A refund can occur if the quoted execution is no longer available at submission. Refunds go to the **destination chain by default**, otherwise to the origin chain. A `refundOnOrigin` parameter overrides this. — [Relay docs: The Relay solver](https://docs.relay.link/how-it-works/the-relay-solver)
- **LI.FI.** The `/status` endpoint accepts the sending tx hash, receiving tx hash, or a transactionId. Pending substatuses include `WAIT_SOURCE_CONFIRMATIONS` and `WAIT_DESTINATION_TRANSACTION`. Failure modes include bridge or chain unavailability. — [LI.FI docs: Status tracking](https://docs.li.fi/introduction/user-flows-and-examples/status-tracking)
- **[secondary]** Poll `/status` every 10–30 seconds until a terminal state. Source-chain confirmation is only the start of a transfer, not proof of delivery. — [TypingMind LI.FI skill](https://www.typingmind.com/skills/sendaifun-lifi)
- Intent-based bridges can suffer **liquidity-exhaustion attacks** that stall fills. This is academic research (2026 arXiv). — [arXiv 2602.17805](https://arxiv.org/html/2602.17805v1)

### Inferences
- **[background]** Cascade's deposit is multi-leg: USDC on Base, then swap and bridge to TAO, then stake into N subnets (each stake swaps TAO into alpha through a subnet pool). Present this as 3–4 named stages: "Deposit received" → "Moving to Bittensor" → "Allocating across 12 subnets" → "Done". Show expected durations based on observed medians.
- **Async vault pattern [background: ERC-7540-style request/claim].**
  - Record the deposit request instantly and show the position as "Pending, est. ~2 min".
  - Settle shares when allocation completes.
  - Withdrawals use the same pattern in reverse. Unstaking from subnets and bridging back can take longer, so be explicit.
- **Let users leave.** Persist order state server-side, keyed to onchain events. Send completion and failure notifications by email, web push, and the Base App notifications API by wallet address. Provide a shareable status URL.
- **Failure recovery:**
  - Default to refunding USDC on Base, the asset and chain the user started with.
  - Show "Retry" or "Claim refund" actions.
  - Never leave a user holding an unexplained intermediate asset such as bridged TAO.
  - Surface "taking longer than usual" after about 2x the median, with a support link and the order ID.
- **Batching helps.** Batching user deposits per epoch and running the cross-chain leg once per batch improves UX (one predictable cadence) and cost, at the price of latency. Show the "next allocation in X min" countdown.

### Gaps
- I found no source on actual Base↔Bittensor bridge latencies or failure rates; other researchers may cover the bridge architecture.
- I found no published median end-to-end fill times for Relay or LI.FI, and no refund-specific status value in LI.FI's `/status`.

---

## A5. Mobile-first considerations

### Takeaway
Direct 2026 sources are thin, but the constraints are concrete. Apple Pay onramp works only in Safari. The Base App now loads standard web apps. Passkeys are native on mobile, while wallet pop-ups and app-switching are the friction to remove.

### Cited Findings
- In the headless onramp, Apple Pay works only in Safari; other browsers show a QR code. — [Coinbase: Headless onramps](https://www.coinbase.com/developer-platform/discover/launches/headless-onramps)
- Since 9 April 2026, the Base App opens apps as standard web apps, with Base deeplinks for tokens and profiles and SIWE for authentication. — [Base Docs: Migrate to a Standard Web App](https://docs.base.org/apps/guides/migrate-to-standard-web-app)
- Without Sub Accounts, every signature requires a passkey prompt. — [Privy Docs](https://docs.privy.io/recipes/react/external-wallets/base-sub-accounts)
- The Coinbase Onramp FAQ sends App Store review questions to its CDP Discord #onramp channel, which suggests native-app review friction for onramps. — [CDP Onramp FAQ](https://docs.cdp.coinbase.com/onramp/additional-resources/faq)

### Inferences
- **Ship a responsive PWA or mobile web app first.** Native iOS and Android come later, because App Store crypto and onramp review adds risk and time for a solo founder.
- **Keep the deposit screen to one input.** Use preset amounts ($50, $100, $500), show the fee breakdown before confirmation, put the primary CTA in the thumb zone, and keep the confirmation sheet to one passkey prompt.
- On non-Safari mobile browsers, detect the browser and route Android users to Google Pay or card, rather than showing a QR code on the same device.

### Gaps
- I found no 2026 mobile conversion or drop-off data for crypto onboarding funnels.

---

## B1. US securities law: staking guidance, the 2026 taxonomy, and whether a pooled, fee-charging index vault is an investment contract, investment company or investment adviser

### Takeaway
The SEC under Chairman Atkins has been much friendlier to protocol staking and to most tokens (2025 staff statements; the March 2026 Commission interpretation). But a **pooled vault whose operator selects the assets and charges a fee** sits squarely in the zone Commissioner Peirce flagged on 22 July 2026: investment contract, investment company or unit investment trust, and investment adviser. The May 2025 staking statement expressly excludes arrangements where the provider decides "whether, when, or how much" to stake, which is what an index vault does by design.

### Cited Findings
- **Protocol staking statement (SEC Division of Corporation Finance, 29 May 2025) [older]:**
  - Covers solo staking, self-custodial staking with a third party, and custodial staking.
  - Treats these ancillary services as administrative or ministerial: slashing coverage, early unbonding, alternate reward schedules (if not "fixed, guaranteed, or greater than those awarded by the protocol"), and **aggregation** to meet minimums.
  - **Out of scope:** liquid staking, restaking, guaranteed returns, and any custodian that "decide[s] whether, when, or how much of an owner's Covered Crypto Assets to stake".
  - Excludes assets with intrinsic economic rights.
  - It is a staff statement and "has no legal force or effect."

  — [SEC staff statement](https://www.sec.gov/newsroom/speeches-statements/statement-certain-protocol-staking-activities-052925)
- **Liquid staking statement (5 Aug 2025) [older].** Certain liquid staking activities and staking receipt tokens do not involve securities offerings, where activities are administrative or ministerial, rewards are protocol-driven and the assets are "Covered Crypto Assets." Restaking and provider-guaranteed returns are out of scope. — [SEC press release 2025-104](https://www.sec.gov/newsroom/press-releases/2025-104-securities-exchange-commission-division-corporation-finance-issues-staff-statement-certain-liquid); [Fenwick](https://www.fenwick.com/insights/publications/sec-statement-on-liquid-staking); [Dechert](https://www.dechert.com/knowledge/onpoint/2025/8/sec-staff-clarifies-stance-on-liquid-staking-.html)
- **Commission interpretation of 17 March 2026, joined by the CFTC:**
  - Sets a taxonomy of digital commodities, digital collectibles, digital tools, stablecoins and digital securities.
  - Clarifies how securities laws apply to protocol staking, mining, airdrops and wrapping.
  - Explains how an investment contract can end ("investment contracts can come to an end").
  - Atkins: "most crypto assets are not themselves securities."

  — [SEC press release 2026-30](https://www.sec.gov/newsroom/press-releases/2026-30-sec-clarifies-application-federal-securities-laws-crypto-assets)
- **Release identifiers.** Release Nos. 33-11412 and 34-105020, 91 Fed. Reg. 13714, effective 23 March 2026. — [Croke Fairchild March 2026 alert](https://crokefairchild.com/2026/03/client-alert-sec-cftc-joint-interpretation-on-crypto-asset-classification) **[secondary]**
- **Named digital commodities.** Jones Day lists Bitcoin, Ether, Solana and Dogecoin as examples. Other firms say the interpretation names 16 or 18 tokens, drawn from tokens underlying CFTC-regulated futures, and that the list is **non-exhaustive**. **I found no source saying TAO is on the list.** — [Jones Day](https://www.jonesday.com/en/insights/2026/03/a-longawaited-step-sec-and-cftc-provide-interpretation-for-crypto-asset-taxonomy); [Jenner & Block](https://www.jenner.com/en/news-insights/client-alerts/sec-and-cftc-issue-landmark-joint-interpretation-on-crypto-asset-classification) **[conflicting count]**
- **Legal weight is described inconsistently.** One summary calls it binding on both agencies; Jones Day says the interpretation is "not law" and does not bind DOJ. — [Jones Day](https://www.jonesday.com/en/insights/2026/03/a-longawaited-step-sec-and-cftc-provide-interpretation-for-crypto-asset-taxonomy) **[conflict noted]**
- **Vault deposit tokens.** Commentary says the March 2026 release may let them be characterised as receipts evidencing a lending position, and that it excludes staking, wrapping and ministerial functions, "but significant gray areas remain." — [Croke Fairchild Aug 2026](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/) **[secondary]**
- **Peirce, "Headstands and Summervaults" (22 July 2026):**
  - Moving activities onchain "does not take them outside" the securities laws.
  - "A vault … could be a common enterprise in which users invest money" tied to the efforts of the deployer and curator.
  - Vaults holding or allocating to securities "could fall into investment company territory".
  - Some vaults resemble **unit investment trusts**, holding a "fixed portfolio of assets with little or no active management." Others resemble **separately managed accounts**.
  - Those who select yield activities or reallocate "may need to assess" securities-law status, and managing vaults "also may implicate investment adviser issues."
  - She invites inquiries and views on rule changes.
  - She warned that legal "headstands, backflips and other gymnastics" will "have a painful fall."
  - This is the statement of one Commissioner and is not binding. She leads the Crypto Task Force.

  — [SEC: Peirce statement](https://www.sec.gov/newsroom/speeches-statements/peirce-statement-crypto-vaults-lending-strategies-072226); [Rimon Law](https://www.rimonlaw.com/sec-commissioner-hester-peirce-statement-on-crypto-vaults-and-lending-strategies-managerial-discretion-is-a-leading-indicator/)
- **Croke Fairchild's vault analysis (10 Aug 2026):**
  - **Howey:** pooled vaults generally meet the investment-of-money and common-enterprise prongs. The profit expectation is met when yield is marketed. "Efforts of others" is the key prong: immutable, fully automated vaults argue better against it, while active management or rebalancing by a team strengthens it.
  - **Investment Company Act:** s.3(a)(1)(C) applies when investment securities exceed 40% of total assets.
  - **Advisers Act:** curators with discretion who charge fees "closely resemble" advisers, and the publisher's exclusion is unpersuasive for ongoing discretion. Their suggested route is a genuinely ministerial, fixed, rules-based methodology with no ongoing human judgment.
  - **Fees:** compensation is a threshold element for both adviser and CPO status. Curator fees reportedly grew about 600% year on year.
  - **CFTC:** derivatives or leverage can create commodity-pool status (see bZeroX and Ooki DAO). Decentralisation is not a defence.

  — [Croke Fairchild](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/)
- **Fact factors.** Whether assets are pooled, who selects strategies, who can change allocations or fees, whether upgrade keys remain, and whether a curator keeps ongoing economic incentives. — [Practus](https://practus.com/crypto-vaults-and-onchain-lending-sec-securities-law-analysis/)
- **[secondary; page returned 403, from search summary]** As drafted, CLARITY's Title VI would not resolve the investment-company, adviser or Reves questions for vaults. A non-US curator earning fees on a securities-holding vault cannot assume cross-border exemptions apply. — [White & Case](https://www.whitecase.com/insight-alert/onchain-yield-offchain-obligations-securities-law-issues-crypto-vaults)
- **Proposed "Regulation Crypto Assets" (18 Aug 2026; comments due 20 Oct 2026, today).** It would create two Securities Act exemptions for crypto investment contracts with principles-based disclosure, a conditional safe harbor from the "investment contract" definition, and preemption of state registration. — [Orrick, 2 Oct 2026](https://www.orrick.com/en/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation)
- **[single source]** The exemptions are reportedly about $5M (startup) and up to $75M per 12 months (fundraising), and the safe harbor lets tokens move to non-security status when the issuer's essential managerial efforts end. — [Astraea](https://astraea.law/insights/sec-innovation-exemption-founders-guide)
- The SEC's separate "innovation exemption" of 17 Sept 2026 is for **tokenized-securities trading venues**, not vaults. — [CoinDesk](https://www.coindesk.com/policy/2026/09/17/sec-rolls-out-long-awaited-innovation-exemption-for-tokenized-securities-venues)
- Firms are engaging the Crypto Task Force on vaults; for example, a memo from Inherence on 4 Aug 2026. — [SEC CTF memo](https://www.sec.gov/files/ctf-memo-inherence-labs-080426.pdf)

### Inferences
- **The underlying exposure is not "protocol staking" in the 2025 sense.**
  - **[background]** Under Bittensor dTAO, staking TAO into a subnet swaps it through that subnet's AMM pool into the subnet's alpha token. Alpha value depends heavily on the subnet owner's and participants' work.
  - So the vault gives price exposure to many project-specific tokens, plus emissions.
  - Whether subnet alpha tokens are "digital commodities" or "digital securities" under the 2026 taxonomy is unresolved, and identifiable subnet-owner teams make the Howey analysis of individual alpha tokens weaker than for TAO itself.
- **The vault shares themselves are the bigger issue.** Pooling, profit marketing, and the rebalancer choosing subnets for a fee map closely onto Peirce's framing.
  - If a meaningful share (>40%) of the vault's assets were securities (for example, some alpha tokens), Investment Company Act status becomes a live risk, as in BarnBridge.
  - A passive, rules-based index doesn't escape: Peirce's UIT analogy targets exactly "fixed portfolio, little active management."
- **Ways to reduce risk (judgment calls for counsel):**
  - A published, deterministic index rule executed by contracts or keepers without discretion.
  - Immutable or timelocked parameters, with no team ability to change weights ad hoc.
  - No "yield" or "APY" marketing.
  - A fee framed as a protocol fee coded into the contract rather than discretionary management compensation. This is still compensation, so it reduces but does not remove adviser risk.
  - Possibly no fee at launch.
  - Possibly excluding US persons until the Regulation Crypto Assets exemptions or safe harbor are final.
- **Peirce's explicit invitation to engage** is a real option for a security-first founder, but it creates a record. Do it through counsel.

### Gaps
- I did not review the primary text of Release 33-11412, so whether it addresses TAO, subnet tokens, baskets, or staking where a provider chooses the validator or subnet is unverified.
- Regulation Crypto Assets exemption sizes come from one firm only.
- I found no SEC guidance or law-firm analysis specific to index or basket vaults of staked tokens.
- I found no analysis of whether a USDC-in index vault could fit within the March 2026 "receipt" characterisation.

---

## B2. US market structure legislation (CLARITY Act) and SEC/CFTC posture

### Takeaway
CLARITY passed the House in July 2025 but **stalled in the Senate**: cloture failed 49–50 on 15 Sept 2026. A motion to reconsider keeps it technically alive, but passage this Congress is widely seen as unlikely. The SEC and CFTC are building an interim regime under existing authority, and state money-transmitter and securities law keeps governing in the meantime.

### Cited Findings
- **Senate history and status:**
  - The House passed H.R. 3633 on 17 July 2025, 294–134.
  - Senate cloture on the motion to proceed failed 49–50 on 15 Sept 2026. Sen. Tillis voted no so he could move to reconsider.
  - The main obstacles were ethics provisions on officials' crypto holdings and stablecoin yield.
  - Passage this Congress is "widely viewed as unlikely" given the midterms.

  — [Orrick, 2 Oct 2026](https://www.orrick.com/en/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation); [CNBC, 15 Sept 2026](https://www.cnbc.com/2026/09/15/senate-cloture-vote-on-clarity-act-fails-dealing-regulatory-setback-to-crypto-industry.html); [DLA Piper](https://www.dlapiper.com/en/insights/publications/2026/09/senate-fails-to-advance-the-clarity-act)
- **[secondary, conflicting]** Reports say Sen. Lummis declared it dead and that the next window might be 2030. Others say it is not dead. — [FinTech Weekly tracker](https://www.fintechweekly.com/news/what-is-the-clarity-act-digital-asset-market-structure-explained-2026); [Finextra](https://www.finextra.com/blogposting/33035/is-the-us-clarity-act-dead-no)
- **[low-tier]** Polymarket odds of passage were about 7.8% on 18 Sept. — [DeFi Rate](https://defirate.com/clarity-act-fact-sheet/)
- **CFTC:**
  - On 17 Sept 2026 it sent "Regulation Crypto Asset Transactions and Regulation Crypto Asset Markets" (RIN 3038-AF80) to OIRA at the prerule stage.
  - In August, Chairman Selig floated a "crypto asset market" contract-market type.
  - Binding rules may be more than a year away.
  - Staff FAQs were issued on 20 March 2026 and updated on 24 Sept 2026.

  — [Orrick](https://www.orrick.com/en/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation)
- **States still govern meanwhile.** Without federal legislation, "state money transmitter, virtual currency, securities registration, and consumer protection regimes will continue to govern" much activity. — [Orrick](https://www.orrick.com/en/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation)
- **The BRCA developer safe harbor is folded into CLARITY as Section 604**, so its fate is tied to CLARITY's. — [Advisers.law](https://advisers.law/blog/clarity-act-section-604-and-the-real-liability-line-for-crypto-developers/) **[secondary]**

### Inferences
- **Plan for no federal market-structure statute through at least 2027.** The friendlier posture comes from agency interpretations and proposals that a future Commission could reverse, and the statute of limitations outlasts any one administration.
- State law (money transmission, state securities "blue sky", consumer protection) is the more immediate US exposure for a small US-based team. Regulation Crypto Assets would preempt state registration only for offerings under its exemptions, if adopted.

### Gaps
- I found no October 2026 reporting on lame-duck plans for CLARITY.
- I did not confirm the exact status of a separate Senate Banking or Agriculture DeFi title.

---

## B3. Money transmission (FinCEN), DOJ posture, Tornado Cash / Roman Storm, developer liability

### Takeaway
Non-custodial design is the main protection. FinCEN's 2019 guidance and DOJ's August 2025 policy both turn on **custody or control of user assets**. Storm was convicted on the money-transmission conspiracy count, and his retrial on the remaining counts is set for **26 April 2027**. The BRCA safe harbor is pending and not law.

### Cited Findings
- **DOJ's August 2025 policy (Matthew Galeotti, 21 Aug 2025):**
  - DOJ will not approve new 18 U.S.C. §1960(b)(1)(C) charges against third parties where the software is "truly decentralized," solely automates peer-to-peer transactions, and no third party has custody or control.
  - Criminal intent can still support other charges, and DOJ looks at conduct "end-to-end."
  - The April 2025 Blanche memo had already limited (b)(1)(A) and (B) charges, which now require clear evidence of knowing, willful violation.
  - FinCEN's 2019 guidance, which exempts non-custodial services, is not binding on DOJ but can factor into charging decisions.

  — [WilmerHale](https://www.wilmerhale.com/en/insights/client-alerts/20250910-doj-signals-approach-to-digital-assets-what-it-means-for-developers-and-platforms); [Alston & Bird](https://www.alston.com/en/insights/publications/2025/09/doj-illicit-finance-enforcement-defi); [Fintech & Digital Assets blog](https://www.fintechanddigitalassets.com/2025/09/doj-official-addresses-defi-platform-developer-liability-under-money-transmission-statute/) **[older]**
- **Samourai Wallet.** Its developers pleaded guilty to the §1960 conspiracy charge. — [WilmerHale](https://www.wilmerhale.com/en/insights/client-alerts/20250910-doj-signals-approach-to-digital-assets-what-it-means-for-developers-and-platforms)
- **Roman Storm:**
  - Convicted in August 2025 of conspiracy to operate an unlicensed money transmitting business; the jury did not resolve two other counts.
  - The retrial on those counts moved to **26 April 2027** at Storm's request; prosecutors wanted October 2026.
  - Storm's Rule 29 motion was argued on 9 April 2026 and was undecided as of the latest order (late Aug 2026).

  — [The Block, 26 Aug 2026](https://www.theblock.co/news/regulation/2026-08-26-tornado-cash-roman-storm-retrial-april-2027-412761); [Cointelegraph](https://cointelegraph.com/news/roman-storm-retrial-delayed-april-2027)
- **BRCA.** H.R. 3533 (May 2025) and S. 3611 (introduced 12 Jan 2026). A "non-controlling developer," meaning one without the legal right or unilateral ability to control user assets, would not be treated as a money transmitter. The bill is not enacted. — [Congress.gov H.R.3533](https://www.congress.gov/bill/119th-congress/house-bill/3533/text); [Congress.gov S.3611](https://www.congress.gov/bill/119th-congress/senate-bill/3611/text); [DeFi Education Fund](https://www.defieducationfund.org/brca/)
- **Curators.** A curator with custody or control may be a money transmitter under FinCEN's 2019 framework. Ongoing discretion over where assets go, even without withdrawal authority, is a gray area, and lacking withdrawal authority is "not dispositive." — [Croke Fairchild](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/)

### Inferences
- **The Bittensor leg is the custody crux [background].**
  - If the pooled alpha positions sit under a coldkey or multisig the team controls, the team arguably has custody and control of user assets. That is a very different regime from a non-custodial vault: MSB/state MTL questions in the US, custody as a CASP service under MiCA, and safeguarding under the UK regime.
  - A security-first design should put Bittensor-side positions under contract control, for example via Bittensor EVM staking precompiles if feasible, with no unilateral team withdrawal path. If that isn't feasible, the design needs to be disclosed and analysed as custodial.
- Using Coinbase Onramp keeps fiat handling with a licensed party, so cascade never touches fiat.
- Storm's conviction and the pending retrial show developer liability is not settled, even with DOJ's softer 2025 policy, which is prosecutorial discretion and not law.

### Gaps
- I did not retrieve DOJ's primary text of the Galeotti remarks.
- I found no FinCEN 2026 updates to the 2019 CVC guidance.
- Bittensor-specific custody mechanics (precompiles, proxy accounts) need technical confirmation from other research.

---

## B4. OFAC sanctions screening and geoblocking norms

### Takeaway
The norm for DeFi front-ends is to geoblock sanctioned jurisdictions using **multiple location signals, not IP alone**, plus **screening of connecting wallets** against sanctions lists through analytics vendors. Front-ends carry most of the practical burden. Many DeFi front-ends also geoblock the UK because of FCA promotion rules.

### Cited Findings
- **OFAC enforcement.** OFAC faulted BitGo and Exodus for not using available location (IP) data to block sanctioned users. IP blocking is "not foolproof" (VPNs) but is "a necessary measure."
- **Screening norms.** Many firms apply OFAC screening even when not strictly required, and decentralised protocols can't easily stop sanctioned users, so front-ends do most of the screening.

  — for both points: [AML RightSource sanctions whitepaper](https://info.amlrightsource.com/hubfs/Crypto%20White%20Papers/Issuance_5_Sanctions_Compliance_Full%20WP.pdf?hsLang=en)
- **Methods.** Geofencing has moved beyond IP checks to multi-source geolocation, and blockchain analytics tools automatically flag sanctioned addresses. — [Didit guide](https://didit.me/es/blog/orchestrating-sanctions-screening-in-defi-a-guide/) **[vendor]**; [DeFi Education Fund: sanctions compliance in DeFi](https://www.defieducationfund.org/aml-cft-part-2-sanctions-compliance-and-law-enforcement-in-the-defi-ecosystem/)
- **UK geoblocks.** Marinade and Orca geoblocked UK users, citing the FCA's financial promotions rules; Binance paused UK sign-ups, and Bybit and PayPal exited. — [Cointelegraph](https://cointelegraph.com/news/defi-solana-marinade-uk-regulations); [Blockworks](https://www.blockworks.com/news/solana-protocols-geofence-uk). **Date conflict:** the search summary dated these events to Oct 2025. **[background]** My understanding is that the FCA crypto promotions regime took effect on 8 Oct 2023 and these geoblocks date from Oct 2023. Verify.

### Inferences
- **A practical baseline for Cascade:**
  - Block comprehensively sanctioned jurisdictions and regions (check the current OFAC list; it has changed in 2025–26).
  - Screen every connecting wallet and every deposit source address with a sanctions API.
  - **[background]** Chainalysis offers a free sanctions screening API and an onchain oracle; TRM has similar products. Verify current terms.
  - Log screening decisions.
  - Put restricted-jurisdiction representations in the ToS.
  - Geoblock the UK at launch unless an authorised firm approves promotions (see B6).
  - Consider excluding US persons from the fee-charging vault until counsel signs off (see B1).
- **Geoblocking is evidence of good faith, not a shield.** If the team still controls the contracts and fees, regulators may still view it as serving users who bypass the block via VPN.

### Gaps
- I found no primary OFAC guidance specific to DeFi front-ends in 2026.
- I did not verify the exact BitGo and Exodus enforcement dates or amounts.
- I did not verify current Chainalysis and TRM product terms.

---

## B5. EU: MiCA (and AIFMD) implications, and the .fi domain

### Takeaway
**MiCA's grandfathering ended on 1 July 2026.** A front-end operated by an identifiable person that charges fees, with admin keys, is unlikely to qualify for the "fully decentralised" carve-out. MiCA "portfolio management" is defined **client by client**, so a pooled index vault may instead raise **AIFMD** collective-investment questions; this point is unresolved. Marketing to EU users without authorisation relies on a narrow reverse-solicitation exemption. The **.fi domain carries no residency requirement**, and choosing a TLD does not by itself determine regulatory jurisdiction.

### Cited Findings
- **The transitional period ended on 1 July 2026.** ESMA expected unauthorised providers to have wind-down plans by then. — [ESMA statement, April 2026](https://www.esma.europa.eu/sites/default/files/2026-04/ESMA75-113276571-1679_Statement_on_the_end_of_transitional_periods_under_MiCA.pdf)
- **The decentralisation carve-out is narrow.** MiCA Recital 22 excludes services provided in a fully decentralised manner without an intermediary. Commentary says the carve-out fails where an identifiable operator or legal person executes, settles or holds custody. — [LegalBison](https://legalbison.com/blog/defi-protocols-under-mica/) **[secondary]**
- **Control indicators.** A practitioner source says regulators look for an identifiable controlling person: front-end operation, **fee capture**, admin keys, order matching. — [GenCompl](https://gencompl.ai/regulations/mica) **[secondary]**
- **Definition of portfolio management.** MiCA Art. 3(1)(25) defines portfolio management of crypto-assets as managing portfolios under client mandates "on a discretionary client-by-client basis." — [MiCA definitions mirror](https://www.mica.wtf/definitions/definitions/mica/providing-portfolio-management-of-crypto-assets)
- **AIFMs and MiCA.** AIFMs are not separately authorised under MiCA and fall within it only when they provide services such as discretionary portfolio management. — [DLA Piper, Apr 2025](https://www.dlapiper.com/en/insights/publications/2025/04/how-is-mica-impacting-fund-managers) **[older]**
- **[vendor]** A commingled DeFi vault can read as a collective investment undertaking under AIFMD, and transferable vault tokens can resemble fund units. — [Tesseract](https://tesseract.fi/vaults/)
- **AIFMD II** required transposition by 16 April 2026 and expands delegation and conflict requirements. — [P2P.org](https://p2p.org/economy/conflict-of-interest-defi-vault-regulation-institutional/) **[secondary]**
- **Reverse solicitation.** ESMA's guidelines (Feb 2025) make the exemption very narrow:
  - It "cannot be assumed."
  - Any promotion, advertising or offer to EU clients counts as solicitation, including partnerships, influencers and referrals.
  - A website reachable from the EU is not enough on its own, but language, disclaimers and targeting are assessed.
  - Firms should keep records showing each EU client approached them on their own initiative.

  — [CMS](https://cms.law/en/lux/legal-updates/reverse-solicitation-regime-exempting-third-country-firms-from-micar-authorisation-requirements); [Morais Leitão](https://www.mlgts.pt/xms/files/site_2018/Newsletters/2025/ESMA_issues_Guidelines_on_reverse_solicitation_under_MiCA_regulation_-_Legal_Alert_ML_-EN-.pdf)
- **Possible future direction.** ESMA's 30 Sept 2026 response to the Commission's MiCA review proposes a narrow DeFi exemption with a legal definition of DeFi. It also proposes a **new regulated service: access to decentralised protocols provided by a CASP on behalf of clients**. These are recommendations, not law. — [ESMA response](https://www.esma.europa.eu/sites/default/files/2026-09/ESMA75-113276571-1721_Response_to_the_EC_consultation_MiCA_regulation_review.pdf)
- **.fi eligibility.** "Companies, organisations and private persons, regardless of their domicile," can hold .fi names. Names are first come, first served and registered through Traficom-accredited registrars; Traficom does not sell directly. — [Traficom: .fi domain names](https://traficom.fi/en/fi-domain-names); [Traficom: How to get an fi-domain name](https://traficom.fi/en/fi-domains/applying-and-using-fi-domains/how-get-fi-domain-name)
- **.fi holder data.** The name must be registered to its **actual holder**, and incorrect holder data can lead to removal. A name must not infringe protected names or trademarks, including Finnish registers and EUIPO marks, and Traficom can remove it at the right-holder's request. — [Traficom: Make sure your fi-domain name is lawful](https://www.traficom.fi/en/fi-domains/domain-disputes/make-sure-your-fi-domain-name-lawful); [Traficom: Who has the right to an fi-domain name?](https://traficom.fi/en/fi-domains/domain-disputes/who-has-right-fi-domain-name). The statutory basis is summarised in Traficom's [summary of domain name provisions](https://www.traficom.fi/files/media/regulation/Summary_of_domain_name_provisions_in_the_Act_on_Electronic_Services.pdf).
- **Registrar requirements for foreign holders.** Foreign individuals give a date of birth; companies give a business registration number, which the registry may validate. The technical contact must be a legal entity. Privacy and proxy services cannot be listed as the holder. — [OpenProvider KB](https://support.openprovider.eu/hc/en-us/articles/360000754788--fi); [Hostaan](https://www.hostaan.fi/en/fi-domain-requirements/) **[registrar sources]**
- **Non-EU/EEA registrars.** Sources conflict on whether they can serve private individuals. — [Hostaan](https://www.hostaan.fi/en/fi-domain-requirements/) **[secondary, unverified]**

### Inferences
- **The .fi TLD does not make cascade a Finnish or EU-regulated business.** MiCA and AIFMD turn on the services provided and on targeting EU clients.
  - Some practical implications follow: disputes fall under Traficom and Finnish law, the real holder identity must be on file (register via an entity if founder privacy matters), and trademark exposure exists because "Cascade" is a common mark. Run EUIPO and Finnish trademark searches before building the brand.
  - A ".fi" domain could marginally read as Finland-targeting in a reverse-solicitation analysis, but ".fi = finance" is a widespread DeFi convention. This is low risk, but be consistent: don't localise into Finnish or other EU languages if relying on non-solicitation.
- **Rough EU positioning for a non-EU entity:**
  1. Don't actively market to the EU, and geoblock or restrict where practical.
  2. Or partner with a MiCA-authorised CASP or AIFM.
  3. Or seek authorisation, which is unrealistic for a solo founder at launch.

  A front-end that charges a fee while the team holds admin keys is the profile most likely to be seen as an identifiable intermediary.

### Gaps
- No authoritative source resolves whether a pooled crypto index vault is an AIF under AIFMD or a MiCA portfolio-management service. National competent authority views (e.g., FIN-FSA, BaFin, AMF) were not found.
- I did not confirm whether .fi registrant data for private individuals is publicly displayed.
- I did not verify Traficom's current (2026) Registrar's Guide text on non-EU/EEA registrars.

---

## B6. UK: FCA financial promotions and the new cryptoasset regime

### Takeaway
The FCA finalised its crypto regime on 30 June 2026 (five policy statements), but it **does not take effect until 25 October 2027**. Until then, crypto activity in the UK is governed mainly by **financial promotions rules** (crypto as "restricted mass market investments") plus AML registration. Draft perimeter guidance (CP26/13) could bring overseas web3 interfaces into scope as "arranging." Many DeFi front-ends simply geoblock the UK.

### Cited Findings
- **Final rules.** The five policy statements were published on 30 June 2026:
  - PS26/9: admissions, disclosures and market abuse.
  - PS26/10: stablecoins.
  - PS26/11: regulated activities, including trading platforms, intermediaries, lending, borrowing, **staking** and custody.
  - PS26/12: prudential.
  - PS26/13: the wider Handbook.

  The regime starts on **25 Oct 2027**, and the authorisation window runs from **30 Sept 2026 to 28 Feb 2027**. — [FCA: Overview of cryptoasset regime policy statements](https://www.fca.org.uk/publications/policy-statements/cryptoasset-regime); [FCA PS26/11](https://www.fca.org.uk/publication/policy/ps26-11.pdf); [Skadden](https://www.skadden.com/insights/publications/2026/07/fca-finalises-core-rules-for-the-uk-cryptoasset-regime); [Freshfields](https://www.freshfields.com/en/our-thinking/briefings/2026/07/set-in-stone-five-landmark-crypto-policy-statements)
- **Staking.** PS26/11 relaxed the rules so that consent can cover ongoing staking of current and future holdings, with conditions and an annual notification. It also clarified record-keeping for liquid staking. — [Regulation Tomorrow](https://www.regulationtomorrow.com/2026/06/fca-publishes-cryptoassets-regime-policy-statements-finalised-guidance-and-two-further-guidance-consultations/); [KPMG](https://kpmg.com/xx/en/our-insights/regulatory-insights/the-uk-finalised-regulatory-regime-for-cryptoassets.html)
- **DeFi, interim approach.** The rules apply where there is an identifiable controlling entity. A DeFi guidance consultation is planned for later in 2026. — [Skadden](https://www.skadden.com/insights/publications/2026/07/fca-finalises-core-rules-for-the-uk-cryptoasset-regime); [KPMG](https://kpmg.com/xx/en/our-insights/regulatory-insights/the-uk-finalised-regulatory-regime-for-cryptoassets.html) **[from search summary]**
- **Perimeter guidance (CP26/13, 15 April 2026; consultation closed 3 June 2026).**
  - It reads "arranging" broadly, so it could bring "a large segment of global web3 interface providers and wallets" into scope.
  - Overseas firms serving UK consumers may be in scope.
  - Final guidance was planned for September 2026. **I did not confirm it has been published.**

  — [Latham via JD Supra](https://www.jdsupra.com/legalnews/fca-consultation-on-cryptoasset-2349812/); [Hogan Lovells](https://www.hoganlovells.com/en/publications/fca-consults-on-perimeter-guidance-for-the-uks-new-cryptoassets-regime); [Linklaters](https://techinsights.linklaters.com/post/102mqx3/uk-fca-drafts-cryptoasset-perimeter-guidance)
- **Until October 2027**, FCA oversight of crypto is limited to financial promotions and AML. Qualifying cryptoassets, other than UK-issued qualifying stablecoins, are classed as restricted mass market investments for promotion purposes. — [Regulation Tomorrow](https://www.regulationtomorrow.com/2026/06/fca-publishes-cryptoassets-regime-policy-statements-finalised-guidance-and-two-further-guidance-consultations/)
- **DeFi geoblocks of UK users** (Marinade, Orca), citing the promotions regime. — [Cointelegraph](https://cointelegraph.com/news/defi-solana-marinade-uk-regulations); [Blockworks](https://www.blockworks.com/news/solana-protocols-geofence-uk) (see the date conflict noted in B4)

### Inferences
- **For a solo founder, geoblock the UK at launch.**
  - **[background]** Promoting crypto to UK retail requires communication or approval by an FCA-authorised or registered firm, plus prescriptive features: risk warnings, a 24-hour cooling-off period for first-time investors, appropriateness assessments, and no referral bonuses. Building that for one market is disproportionate pre-revenue.
  - Revisit once the final perimeter and DeFi guidance land and the regime goes live in October 2027.

### Gaps
- I did not retrieve primary FCA text on the current (2026) financial promotion requirements: cooling-off, appropriateness, risk-warning format.
- I did not confirm whether the final perimeter guidance (planned September 2026) has been published, or what it says about overseas front-ends.

---

## B7. Common structures small DeFi teams use, and their trade-offs

### Takeaway
The typical pattern has three parts. An offshore no-owner entity, usually a **Cayman foundation company** (sometimes BVI), holds the IP, treasury and governance. A **separate company** (often in Panama) operates the front-end. The front-end layers terms of service, risk acknowledgements and geofencing on top. This manages some risks but **does not shield the individuals who control the system**: BarnBridge's co-founders were held personally liable as control persons, and DOJ evaluates conduct end to end. A US-resident solo founder is also exposed to US tax (Subpart F and check-the-box) and personal jurisdiction regardless of where the entity sits.

### Cited Findings
- **Cayman foundations.** The Cayman foundation company is described as the dominant structure for DeFi governance entities. It can exist without shareholders and operate purely for its stated objects. It typically holds smart-contract IP, contracts with front-end hosting providers and manages the treasury. — [Astraea: DeFi protocol legal structure](https://astraea.law/insights/defi-protocol-legal-structure-llc-foundation-dao-2025); [Cavenwell](https://cavenwell.io/insights/cayman-foundations-for-token-issuance-web-3) **[service-provider sources; claim-to-source attribution comes from search summaries]**
- **Separate front-end company.** The front-end is often housed in a separate company, "typically in Panama." — [DAO SPV blog: Crypto catamaran](https://blog.daospv.com/crypto-catamaran-why-when-and-how-to-use-the-bvi-cayman-structure-for-token-issuance/) **[secondary]**
- **No Cayman DeFi carve-out.** The Cayman VASP Act has no DeFi safe harbour; its test is activity-based, asking whether a person conducts a regulated activity "in or from" Cayman. — [Appleby 2026 Cayman guide](https://www.applebyglobal.com/publications/2026-guide-to-blockchain-crypto-assets-in-the-cayman-islands/)
- **Cost and US tax.** Reported costs are about $25k–$50k to form and $20k–$40k a year to maintain; a supervisor is often required when there are no members. Economic substance rules apply. US founders face Subpart F and check-the-box issues. — [Xavion Capital: Cayman DeFi protocol](https://xavioncapital.com/resources/company-formations/cayman-defi-protocol); [Xavion Capital: BVI for US founders](https://xavioncapital.com/resources/company-formations/bvi-defi-protocol-for-american) **[provider marketing]**
- **Personal liability.** BarnBridge co-founders were held personally liable as control persons despite the DAO label, and the CFTC's bZeroX and Ooki DAO actions show decentralised structure is not a defence. — [Croke Fairchild](https://crokefairchild.com/2026/08/client-alert-the-vault-vacuum-the-registration-status-of-defi-vault-protocols-under-u-s-federal-securities-and-commodities-laws/)
- **DOJ looks at the whole picture.** It considers a subject's conduct "end-to-end." — [WilmerHale](https://www.wilmerhale.com/en/insights/client-alerts/20250910-doj-signals-approach-to-digital-assets-what-it-means-for-developers-and-platforms)
- **Fees and front-ends signal control.** Under MiCA analysis, front-end operation and fee capture are indicators of an identifiable controlling person. — [GenCompl](https://gencompl.ai/regulations/mica) **[secondary]**

### Inferences
These are options with trade-offs, for discussion with counsel.
1. **Where the fee sits.**
   - A *contract-level fee* (management or streaming fee minted to a treasury) is transparent and automatic. It is still compensation (adviser and CPO analysis) and makes the recipient identifiable.
   - A *front-end-only fee* (a surcharge on deposits through cascade.fi) creates a clearer "identifiable intermediary" in MiCA and UK terms.
   - *No fee at launch* minimises the compensation element but delays revenue.
2. **Entity.**
   - A US LLC is cheap and simple, but squarely in US jurisdiction for a pooled, fee-charging product.
   - An offshore foundation plus a separate front-end operator costs more (about $45k–$90k in year one per provider estimates). It gives an organisational wrapper for governance and treasury, but limited protection if the US founder remains the de facto control person.
3. **Geographic scope at launch.** Excluding US persons, the UK, and actively marketed EU audiences, combined with OFAC screening, is the common conservative posture. It shrinks the addressable market, which is especially painful because Coinbase/Base users skew US.
4. **Product design levers that reduce regulatory surface:**
   - A non-custodial architecture on both chains.
   - A deterministic, published index methodology.
   - Immutable or timelocked parameters with no discretionary rebalancing.
   - No yield or APY marketing.
   - Transparent onchain holdings.
   - Users can always exit without team permission.

   These are also the "security-first" UX features, so the legal and product goals align.
5. **Terms of service and risk acknowledgements** are standard and useful (restricted-jurisdiction representations, assumption of risk, no advice, no guaranteed returns), but they don't override securities, money-transmission or sanctions law.

### Gaps
- I found no authoritative (regulator or case-law) analysis of whether separating the front-end operator materially reduces liability. The sources are provider marketing.
- I found no sample ToS or risk-acknowledgement language from leading vaults.
- I found no analysis specific to a US-resident solo founder operating through an offshore foundation; this needs US securities, tax and sanctions counsel.
- The founder's jurisdiction is unknown, and the analysis changes materially for EU residents (MiCA/AIFMD directly) or UK residents (the "in or from" analysis and promotions).
