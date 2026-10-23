# Message to ForeverMoney (draft, 2026-10-22)

Send via their X account (@forevermoney_ai) or the contact on docs.forevermoney.ai. Keep it short; the
questions are what matter.

---

Subject: Integrating ForeverMoney TAO into a staking vault on Bittensor EVM

Hi — I'm building cascade.fi, a simple product that lets people on Base get root-staking exposure to
TAO without a Bittensor wallet. The plan is a batching contract on Base that sends your TAO token over
CCIP to a vault contract on Bittensor EVM, which stakes native TAO and tracks shares. Your bridge is
the only rail that reaches Bittensor, so I'd like to build on it properly rather than reverse-engineer
it. Four questions:

1. **Contract-level redeem.** Can a third-party contract on Bittensor EVM convert your CCIP TAO token
   (0xC5b6…0256) into native TAO in a single call, and is that call permissionless? If so, which
   contract and function (your gateway at 0xd5Fa…eD69?), and what does it need (approval, min
   amount, any fee)?

2. **Data with tokens.** Does your Base gateway let an integrator attach a data payload to the CCIP
   message, so our vault learns who deposited? If not, is it fine for our contract to call the CCIP
   router directly with your token (the Base pool appears to have no sender allowlist)?

3. **Source.** Is the audited source at the Hackerbane review commit
   (e80a4432fc0d58f1e7ab94180137aace7f4286d2) available, and will the gateway / AlphaVault contracts be
   verified on the explorer? I'd rather integrate against verified code.

4. **Operations.** How would a protocol integrator hear about pauses, upgrades or rate-limit changes
   ahead of time? And are Ethereum or BNB pools for TAO on the roadmap?

Happy to share the design doc and the vault's audit when it's done. Thanks.

— Daniel, cascade.fi
