# Cascade

TAO staking exposure for people on Base, without a Bittensor wallet. One vault contract on Bittensor
EVM holds the root stake and the share balances; a thin front door on Base batches deposits and
withdrawals and forwards them over Chainlink CCIP. See `docs/architecture.md` for the money flow and
`contracts/README.md` for the trust model, operator rules and the pre-mainnet checklist.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `CascadeVault`, `CascadeFrontDoor`, `CascadeBase`, tests, invariants |
| `web/` | Next.js demo app; every number comes from the mock service in `src/lib/cascade` |
| `docs/architecture.md` | How the two contracts move money, in plain language |
| `docs/superpowers/specs/` | Design specs; the v2 spec's top section records every ruling made while building |
| `docs/superpowers/plans/` | The task plans the builds followed |
| `docs/forevermoney-probe.md` | On-chain and source findings that fix the bridge-adapter design |
| `reports/`, `research_notes/` | The research the design rests on |

## Working on it

- `main` is the reviewed state. Work happens on a short-lived branch per piece (`adapters`,
  `web-wiring`, `keeper`), with a test-first build and an independent review before it lands.
- Clone with `git clone --recurse-submodules` (the contract dependencies are git submodules under
  `contracts/lib`; on an existing clone run `git submodule update --init`).
- Contracts: `cd contracts && forge test` (262 tests, 9 invariants), `forge build --sizes`
  (the vault must stay under 24,576 bytes), `forge fmt --check`, `slither .`.
- Web: `cd web && pnpm install && pnpm dev`.
- Tags: `v2.0-contracts-reviewed` is the current contracts milestone; `contracts-v1-superseded`
  marks the earlier design, kept for reference.

## Status

Contracts are built and reviewed but not audited and not deployed. Next: the CCIP + ForeverMoney
adapters (design in `docs/forevermoney-probe.md`), then the keeper bot, then wiring the web app to
testnet. Nothing here should hold real money before a professional audit and the checklist in
`contracts/README.md` is done.
