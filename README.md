# Cascade

TAO staking exposure for people on Base, without a Bittensor wallet. One vault contract on Bittensor
EVM holds the root stake and the share balances; a thin front door on Base batches deposits and
withdrawals and forwards them over Chainlink CCIP. See `docs/architecture.md` for the money flow and
`contracts/README.md` for the trust model, operator rules and the pre-mainnet checklist.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `CascadeVault`, `CascadeFrontDoor`, `CascadeBase`, the two CCIP bridge adapters, tests, invariants, fork tests, and `script/simulate_inbound.sh` (a live check of the Bittensor adapter) |
| `web/` | Next.js site: landing page plus the Stake, Unstake, Rewards and Activity tabs. Every number comes from the data layer in `src/lib/cascade` (the mock adapter today); builds to a static export. See `web/README.md` |
| `ops/` | The test-run tool: rehearsal on local forks, budget, deployment, read-back check and the hand-run keeper, all signing through Foundry. See `docs/runbook-test-run.md` |
| `docs/architecture.md` | How the two contracts move money, in plain language |
| `docs/runbook-test-run.md` | Step by step through the owner's $20 test run on mainnet |
| `docs/superpowers/specs/` | Design specs; the v2 spec's top section records every ruling made while building |
| `docs/superpowers/plans/` | The task plans the builds followed |
| `docs/forevermoney-probe.md` | On-chain and source findings that fix the bridge-adapter design |
| `reports/`, `research_notes/` | The research the design rests on |

## Working on it

- `main` is the reviewed state. Work happens on a short-lived branch per piece (`adapters`,
  `web-wiring`, `keeper`), with a test-first build and an independent review before it lands.
- Clone with `git clone --recurse-submodules` (the contract dependencies are git submodules under
  `contracts/lib`; on an existing clone run `git submodule update --init`).
- Contracts: `cd contracts && forge test` (356 tests, 9 invariants; `FORK=1` adds 12 fork tests,
  see `contracts/README.md`), `forge build --sizes` (the vault must stay under 24,576 bytes),
  `forge fmt --check`, `slither .`.
- Web: `cd web && pnpm install && pnpm dev`; `pnpm build` writes the static site to `web/out/`.
- Ops: `cd ops && pnpm install && pnpm test`; `pnpm ops` lists the commands.
- Tags: `v2.0-contracts-reviewed` is the current contracts milestone; `contracts-v1-superseded`
  marks the earlier design, kept for reference.

## Status

Contracts are built and reviewed but not audited and not deployed. The CCIP + ForeverMoney bridge
adapters are built and fork-tested on both mainnets through the deployed CCIP 2.0 OffRamp, and
their inbound conversion was simulated against the live Bittensor node. The web app has its real
design (landing page and stake app) but still runs on mock data. The test-run tool (`ops/`) and
its runbook are built and rehearsed on forks of both chains; next is the owner's own $20 test run,
then wiring the web app. Nothing here should hold real money before a professional
audit and the checklist in `contracts/README.md` is done.
