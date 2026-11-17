"use client";

import { useConnection } from "wagmi";
import NotFound from "@/app/not-found";
import { useCascadeAccount } from "@/lib/account";
import { explorer } from "@/lib/cascade/config";
import {
  DIRECT_EXIT_SUB,
  DIRECT_EXIT_TITLE,
  type DirectOutcome,
  directExitView,
  GAS_NOTE,
  HELD_NOTE,
  NETWORK_NOTE,
  ORIGIN_STEP_LABEL,
  ORIGIN_STEP_NOTE,
  ORIGIN_STEP_WHY,
  outcomeLines,
  SWITCH_BACK_LABEL,
  switchBackNote,
  withdrawLabel,
} from "@/lib/cascade/direct-exit";
import { useIsV32 } from "@/lib/cascade/hooks";
import { toDisplay } from "@/lib/cascade/units";
import { directStepLabel, useDirectExit, useDirectExitFlow } from "@/lib/cascade/use-direct-exit";
import { useWalletKind } from "@/lib/cascade/use-wallet-kind";
import { formatTao } from "@/lib/format";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { ReceiptLink } from "../ReceiptLink";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { RetiredNotice } from "./RetiredNotice";
import card from "./StakeCard.module.css";
import styles from "./StakeForm.module.css";

/** `/unstake/bittensor`: v3.2's emergency way out (Task 59b), reached from the FAQ and from Unstake's other ways out.
 * Every other deployment has nothing at this address. */
export function BittensorExitScreen() {
  const v32 = useIsV32();
  const { state } = useCascadeAccount();
  if (!v32) return <NotFound />;
  const account = state.status === "wallet" ? state.account : null;
  return (
    <AppShell active="unstake">
      <h1 className={app.title}>{DIRECT_EXIT_TITLE}</h1>
      <p className={app.sub}>{DIRECT_EXIT_SUB}</p>
      {/* a retired deployment keeps this way out (Task 60) */}
      <RetiredNotice />
      {state.status === "loading" ? (
        <Loading />
      ) : account ? (
        <DirectExitCard account={account} />
      ) : (
        <div className={app.card}>
          <div className={card.form}>
            <ConnectWallet variant="pill-block" />
          </div>
        </div>
      )}
    </AppShell>
  );
}

/** What the account can take out on Bittensor, and the steps: the origin step first when it is needed, then the
 * withdrawal of every share. A contract wallet is refused, with nothing to press (direct-exit.ts directExitView). */
export function DirectExitCard({ account }: { account: string }) {
  const reads = useDirectExit(account);
  const flow = useDirectExitFlow(account);
  const { connector } = useConnection();
  // the stake form's reading of the wallet (its connector, its atomic batches on Base); read again at the click
  const kind = useWalletKind(account);
  if (!reads.data) {
    return reads.isError ? (
      <div className={app.card}>
        <div className={card.form}>
          <LoadError what="your stake on Bittensor" onRetry={() => void reads.refetch()} />
        </div>
      </div>
    ) : (
      <Loading />
    );
  }
  const r = reads.data;
  const v = directExitView(r, { ...(connector ? { connectorId: connector.id } : {}), ...(kind.data?.atomic ? { atomic: kind.data.atomic } : {}) });
  const busy = flow.busy !== null;
  const pressing = (step: "origin" | "withdraw" | "base") => flow.busy === directStepLabel(step);
  // a withdrawal not confirmed yet holds a second one until its receipt shows or the shares move (Task 59b review, M7)
  const held = flow.holds(r.shares);
  // the origin step or the switch back, as the chain shows it (M3)
  const changed = flow.outcome && flow.outcome.step !== "withdraw" ? outcomeLines(flow.outcome) : [];

  return (
    <div className={app.card}>
      <div className={card.summary}>
        <div>
          <p className={card.k}>Your stake</p>
          <p className={card.v}>{formatTao(toDisplay(v.valueWei, 18), 4)} TAO</p>
        </div>
      </div>
      <div className={card.form}>
        {flow.outcome?.step === "withdraw" ? (
          <Withdrawn outcome={flow.outcome} />
        ) : v.refusal ? (
          <p role="status" className={styles.error}>
            {v.refusal}
          </p>
        ) : (
          <>
            {v.originStep && (
              <>
                <button type="button" className="pill pill-ghost pill-block" disabled={!v.canSetOrigin || busy} onClick={() => void flow.run("origin", r.shares)}>
                  {pressing("origin") ? "Confirm in your wallet…" : ORIGIN_STEP_LABEL}
                </button>
                <p className={styles.under}>
                  {ORIGIN_STEP_NOTE} {ORIGIN_STEP_WHY}
                </p>
              </>
            )}
            {v.hold && (
              <p role="status" className={styles.error}>
                {v.hold}
              </p>
            )}
            <button type="button" className={`pill pill-block ${styles.submit}`} disabled={!v.canWithdraw || busy || held} onClick={() => void flow.run("withdraw", r.shares)}>
              {pressing("withdraw") ? "Confirm in your wallet…" : withdrawLabel(v.valueWei)}
            </button>
            {/* a withdrawal dropped and never mined holds it until a reload (Task 60 review, Minor 7) */}
            {held && <p className={styles.under}>{HELD_NOTE}</p>}
            {changed.map((line) => (
              <p key={line} role="status" className={styles.note}>
                {line}
              </p>
            ))}
            {flow.error && (
              <p role="alert" className={styles.error}>
                {flow.error.message}
                {flow.error.hash && (
                  <>
                    {" "}
                    <ReceiptLink href={explorer.bittensorTx(flow.error.hash)} className="link">
                      View on Bittensor
                    </ReceiptLink>
                  </>
                )}
              </p>
            )}
            <dl className={styles.details} aria-live="polite">
              <div>
                <dt>You will receive</dt>
                <dd>{v.estimate}</dd>
              </div>
            </dl>
            <p className={styles.under}>{GAS_NOTE}</p>
            <p className={styles.under}>{NETWORK_NOTE}</p>
            {/* the switch back (Task 59b follow-up): Base unstakes this address again, while Base has an active door */}
            {v.switchBack && (
              <>
                <button type="button" className="pill pill-ghost pill-block" disabled={!v.canSwitchBack || busy} onClick={() => void flow.run("base", r.shares)}>
                  {pressing("base") ? "Confirm in your wallet…" : SWITCH_BACK_LABEL}
                </button>
                {/* exact for the address's origin: "again" only where Base worked for it before (Task 59b review, M5) */}
                <p className={styles.under}>{switchBackNote(r.origin)}</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** After the withdrawal: what the vault's events say it paid, and its receipt. */
function Withdrawn({ outcome }: { outcome: Extract<DirectOutcome, { step: "withdraw" }> }) {
  return (
    <div role="status">
      {outcomeLines(outcome).map((line) => (
        <p key={line} className={styles.note}>
          {line}
        </p>
      ))}
      <p className={styles.note}>
        <ReceiptLink href={explorer.bittensorTx(outcome.hash)} className="link">
          View on Bittensor
        </ReceiptLink>
      </p>
    </div>
  );
}
