# Cascade

TAO staking exposure for people on Base, without a Bittensor wallet. One vault contract on Bittensor
EVM holds the root stake and the share balances; a thin front door on Base batches deposits and
withdrawals and forwards them over Chainlink CCIP. See `docs/architecture.md` for the money flow and
`contracts/README.md` for the trust model, operator rules and the pre-mainnet checklist.

Live on mainnet (deployment `v3.2-launch`, since 2026-11-16), early and not audited: see
[Status](#status), and [`SECURITY.md`](SECURITY.md) for the deployed addresses and how to report a
vulnerability.

## Deployed contracts

The live deployment is `v3.2-launch`: the front door, staker, TWAP oracle, CCIP adapter and a
read-only lens on Base (chain 8453), and the vault with its five libraries, the CCIP adapter and a
read-only lens on Bittensor EVM (chain 964). The addresses, with explorer links, and the roles
are in [`SECURITY.md`](SECURITY.md#the-contracts-v32-launch). Use only those. The previous
deployment (`v3-launch`) is empty and is being retired, and the old test deployments (`v3-test` and
`test-2026-10`) still exist on-chain but are not Cascade's product: don't send money to any of them.
The only site is https://cascadefi.xyz.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `CascadeVault` and its linked libraries, `CascadeFrontDoor`, `CascadeStaker`, `CascadeTwapOracle`, `CascadeBase`, the two CCIP bridge adapters, the two read-only lenses, tests, invariants, fork tests, and `script/simulate_inbound.sh` (a live check of the Bittensor adapter) |
| `web/` | Next.js site, live at https://cascadefi.xyz: landing page plus the Stake, Unstake, Rewards and Activity tabs. Every number is read from Base or Bittensor through the data layer in `src/lib/cascade`; builds to a static export. See `web/README.md` |
| `ops/` | The deployment and keeper tool: rehearsal on local forks, budget, deployment, read-back check, ownership hand-off, pause, and the keeper, all signing through Foundry. See `docs/runbook-v3.2.md` (v3.2), `docs/runbook-test-run.md` and `ops/LAUNCH-SETTINGS.md` |
| `keeper/` | v3.2's keeper as its own Cloudflare Worker, running the keeper code in `ops/src/keeper/core`. See `docs/runbook-v3.2.md` |
| `indexer/` | The history indexer and monitor: a Cloudflare Worker that serves the site's history and checks both chains and the bridge every minute. See `indexer/README.md` |
| `docs/architecture.md` | How the two contracts move money, in plain language |
| `docs/runbook-v3.2.md` | How to deploy, run and look after v3.2 |
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
- Tags: `v3.1-contracts-reviewed` is the latest contracts milestone (`v3.0-`, `v2.1-` and
  `v2.0-contracts-reviewed` came before it); `contracts-v1-superseded` marks the earlier design,
  kept for reference.

## Status

Live on Base and Bittensor mainnet since 2026-11-16 (deployment `v3.2-launch`). It is early: so far
it holds only the founder's own money, while a mainnet canary with small amounts runs; deposits are
capped at 40 TAO, and the other launch limits are in `SECURITY.md`. The contracts have been reviewed
many times internally but are not professionally audited.
Their source is verified on Sourcify for all 13 contracts and libraries (an exact match for 11; a match for the vault and `CascadePayoutLib`, the two that link libraries; links in `SECURITY.md`).
The owner is a single hardware-wallet account; in v3.2 its changes that loosen a protection wait
on-chain (48 hours for a setting, 7 days for a new bridge or front door, 8 days for a new owner or
guardian). An audit comes before other people's money, and a Safe as owner is recommended before
then. The previous deployment, `v3-launch` (live from 2026-10-30), is empty and is being retired.
The CCIP + ForeverMoney bridge adapters were fork-tested on both mainnets through the deployed
CCIP 2.0 OffRamp and their inbound conversion simulated against the live Bittensor node. `ops/`
deploys and operates the deployments, `keeper/` is v3.2's keeper, `indexer/` watches them, and the
web app runs on live chain data with real wallet flows (see `web/README.md`).
