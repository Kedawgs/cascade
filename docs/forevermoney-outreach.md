# Message to ForeverMoney (draft, revised 2026-10-23)

Most of the original questions are now answered from their public source and on-chain simulation
(see `docs/forevermoney-probe.md`): `AlphaVault.withdrawLiquid` and `depositLiquid` are permissionless
and 1:1 for TAO, and the Base pool has no sender allowlist. What is left is a courtesy heads-up and
three operational questions. Send via @forevermoney_ai or the contact on docs.forevermoney.ai.

---

Subject: Integrating ForeverMoney TAO into a staking vault on Bittensor EVM

Hi — I'm building cascade.fi, a product that gives people on Base root-staking exposure to TAO without
a Bittensor wallet. Your TAO token over CCIP is the rail. From your public bridge-contracts repo I've
confirmed that a contract can call `AlphaVault.withdrawLiquid` and `depositLiquid` directly, so the
plan is: our Base contract sends your token plus our batch data to our own receiver on 964 through
the CCIP router; the receiver unwraps via `withdrawLiquid` and stakes natively; payouts go back
through `depositLiquid` and the router. We don't touch your gateways. Three questions:

1. Any objection to that direct integration, or anything about `AlphaVault` you'd want an integrator
   to know (planned migrations, pause policy, the `whenNotMigrating` gate on deposits)?
2. Will you verify `AlphaVault` and the TAO `AlphaToken` on the Taostats explorer? We've matched the
   deployed bytecode to the audit commit ourselves, but verified source is better for everyone's
   auditors.
3. How would an integrator hear ahead of time about pauses, migrations, or CCIP pool-limit changes?

Happy to share our design doc and audit when it's done. Thanks.

— Daniel, cascade.fi
