# Security

Status: the contracts in `contracts/` are built and reviewed but **not audited and not deployed**.
Nothing here holds real funds. Until a professional audit and the pre-mainnet checklist in
`contracts/README.md` are complete, treat every address in the docs as a test target, not a product.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a
vulnerability") rather than a public issue. Include the affected file and function, the scenario, and
a proof-of-concept test if you have one. We will acknowledge within a few days.

## Scope

In scope: everything under `contracts/src/`. Out of scope for now: the demo web app (mock data only),
research notes, and third-party contracts we integrate with (Chainlink CCIP, ForeverMoney's
AlphaVault, the Bittensor precompiles), though we welcome notes on how our use of them could fail.

## What has been done

- Every task of the build was reviewed by an independent reviewer before the next started, and the
  whole branch was reviewed again at the end; the rulings are listed at the top of the v2 spec in
  `docs/superpowers/specs/`.
- 262 Foundry tests including 9 invariants; Slither 0.11.6 with the triage in `contracts/README.md`.
- The trust model, soft spots and operator rules are written down honestly in `contracts/README.md`.
