"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useState, type ReactNode } from "react";
import { useCascadeAccount } from "@/lib/account";
import { cancelSentCopy } from "@/lib/cancel-sent";
import { useNow } from "@/lib/client-state";
import { CANCEL_AT_ONCE, CANCEL_OPEN_STATUS, CANCEL_WAITING_STATUS, cancelHoldS, cancelWaitText } from "@/lib/cascade/flows";
import { SEE_YOUR_TAO } from "@/lib/add-to-wallet";
import {
  useBalances,
  useCancelsSent,
  useDeliveryPreference,
  useDeposit,
  useDeposits,
  useIndexerNamed,
  useIsV3,
  useIsV32,
  usePendingEntries,
  usePendingEntry,
  usePosition,
  usePositionHistory,
  useRetired,
  useUsdcDelivery,
  useWithdrawal,
  useWithdrawals,
} from "@/lib/cascade/hooks";
import { type ActivityTab, parseActivityParams } from "@/lib/activity-params";
import { requestFeeEth } from "@/lib/faq";
import { type PendingEntry, pendingRows, pendingTrail, receiptShows } from "@/lib/cascade/pending";
import type { DepositRecord } from "@/lib/cascade/records";
import { depositCancelSent, isDelivering, offersClaim, withdrawalCancelSent } from "@/lib/cascade/trail";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatDay, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
import { claimButtonLabel, claimChoices, deliveryOffClaim, stakeAgainHref, TURN_OFF_DELIVERY, turnOffDeliveryOffered } from "@/lib/stake-form";
import { DepositList, WithdrawalList } from "../ActivityList";
import { AddToWallet } from "../AddToWallet";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { Trail } from "../Trail";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { RetiredNotice } from "./RetiredNotice";
import { BlockNotice, SendItNow } from "./SendItNow";
import { useSentTiming } from "./SentDialog";
import styles from "./ActivityScreen.module.css";

function BackLink({ href = "/activity" }: { href?: string }) {
  return (
    <Link href={href} className={styles.back}>
      Back to activity
    </Link>
  );
}

function NotFound({ what }: { what: "deposit" | "unstake" }) {
  return (
    <div className={`${app.card} ${styles.panel}`}>
      <p className={styles.panelTitle}>We couldn&apos;t find this {what}.</p>
      <p className={styles.panelText}>It may belong to a different wallet.</p>
      <BackLink href={what === "unstake" ? "/activity?tab=unstakes" : "/activity"} />
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

/** A receipt Activity hasn't read from the chain yet: this browser's own entry for it, in the layout its record
 * will have (the same steps: pending.ts pendingTrail), the step it sent said plainly to be confirming, with the
 * figures it was sent with and its transaction, until the list read from the chain holds its record. `onRetry` when
 * that read failed. */
export function PendingReceipt({ entry, onRetry }: { entry: PendingEntry; onRetry?: () => void }) {
  const n = entry.notice;
  const timing = useSentTiming();
  const deposit = n.kind === "deposit";
  const title = deposit
    ? `Where your ${n.usdc !== undefined ? formatUsdShort(n.usdc) : `${formatTao(n.tao, 4)} TAO`} is going`
    : n.usdc !== undefined
      ? `Your unstake of about ${formatUsd(n.usdc)}`
      : `Your unstake of about ${formatTao(n.tao, 4)} TAO`;
  return (
    <>
      <BackLink href={deposit ? "/activity" : "/activity?tab=unstakes"} />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>
          {formatDay(entry.createdAt)} {deposit ? "deposit" : "unstake"}
        </p>
        <h2 className={styles.panelTitle}>{title}</h2>
        {/* the receipt's own layout from the moment it is sent: its steps, the one it sent confirming, the rest ahead */}
        <Trail steps={pendingTrail(entry, timing.payoutDelayS !== undefined ? { payoutDelayS: timing.payoutDelayS } : {})} label={deposit ? "Deposit steps" : "Unstake steps"} />
        <dl className={styles.rows}>
          {pendingRows(n).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {onRetry && <LoadError what={deposit ? "this deposit" : "this unstake"} onRetry={onRetry} />}
    </>
  );
}

/** A deposit's cancel while it waits in its open batch. On v3.2 (R11) it waits out the five-minute cooldown first: until
 * `cancelableAt` (the account's, as last read; 0 is no wait) it says how long, each second, and holds the button; the
 * click checks the deposit and the clock on Base again (flows.ts planCancelDeposit), and that check decides. R12d (M1):
 * the wait is counted on Base's clock (the block's time the read came with, and the time since by this device:
 * flows.ts cancelHoldS), never this device's clock alone, which can be minutes off; never held more than the cooldown
 * past the read; a record without that clock holds nothing. The countdown is no live region: a screen reader is told the
 * state, once as it changes (waiting, then open). Build B's 0 (deposits paused, or batches unable to leave) says a
 * cancel works at once.
 *
 * The button and its words sit apart on the receipt (the button in the row beside Send it now, the words under the row:
 * SendItNow's `action` and `actionNote`), so each counts the same wait for itself, each second. */
function useCancelHold(deposit: DepositRecord): { wait: string | null; atOnce: boolean; read: boolean } {
  const now = useNow(1_000);
  const at = deposit.cancelableAt;
  const hold = at !== undefined && deposit.cancelClock ? cancelHoldS(at, deposit.cancelClock, now) : 0;
  // atOnce, build B: 0 is the door's word that nothing waits now (deposits paused, or its primary bridge disabled);
  // read: a cooldown was read at all (v3.2), so its state is told to a screen reader
  return { wait: cancelWaitText(hold), atOnce: at === 0, read: at !== undefined };
}

/** The cancel itself: held while a flow runs (`busy`: its label, "cancel" while it is this one, which then says to
 * confirm in the wallet, as every other button here does), and through the cooldown. */
function CancelDepositButton({ deposit, busy, onCancel }: { deposit: DepositRecord; busy: string | null; onCancel: () => void }) {
  const { wait } = useCancelHold(deposit);
  return (
    <button type="button" className="pill pill-ghost pill-danger" disabled={busy !== null || wait !== null} onClick={onCancel}>
      {busy === "cancel" ? "Confirm in your wallet…" : "Cancel deposit"}
    </button>
  );
}

/** Its words, under the row: how long until a cancel works, or that it works at once, and the state for a screen reader. */
function CancelDepositNote({ deposit }: { deposit: DepositRecord }) {
  const { wait, atOnce, read } = useCancelHold(deposit);
  return (
    <>
      {wait !== null && <p>{wait}</p>}
      {atOnce && <p>{CANCEL_AT_ONCE}</p>}
      {read && (
        <p role="status" className="sr-only">
          {wait !== null ? CANCEL_WAITING_STATUS : CANCEL_OPEN_STATUS}
        </p>
      )}
    </>
  );
}

export function DepositDetail({ account, id }: { account: string; id: string }) {
  const { data: read, isPending, isFetching, isError, refetch } = useDeposit(account, id);
  const entry = usePendingEntry(account, "deposit", id);
  const v3 = useIsV3();
  const { data: position } = usePosition(account);
  const wallet = useBalances(account);
  const flows = useFlows(account);
  const router = useRouter();
  // a cancel this browser sent that the record, read before it, doesn't show yet: the receipt goes by this browser's own
  // word until the read catches up, so a deposit already taken back out is never offered its cancel, or Send it now,
  // again (cancel-sent.ts). With no such cancel, the record as read
  const cancelSent = useCancelsSent(account, "deposit", flows.busy !== null)(read);
  const deposit = read && cancelSent ? depositCancelSent(read, cancelSent) : read;
  // a retired deployment carries on no stake, and with USDC delivery off no swap back to USDC is offered (Task 60)
  const retired = useRetired();
  const usdcDelivery = useUsdcDelivery();
  const shows = receiptShows({ record: deposit, entry, isPending, isFetching, isError });
  if (entry && (shows === "pending" || shows === "pending-error")) {
    return <PendingReceipt entry={entry} {...(shows === "pending-error" ? { onRetry: () => void refetch() } : {})} />;
  }
  if (shows === "error") return <LoadError what="this deposit" onRetry={() => void refetch()} />;
  if (shows === "loading") return <Loading label="Loading your deposit…" />;
  if (!deposit) return <NotFound what="deposit" />;

  const staked = deposit.status === "staked";
  const walletTao = wallet.data?.tao ?? 0n;
  const walletTaoBack = usdcDelivery && deposit.status === "cancelled" ? (walletTao < deposit.taoWei ? walletTao : deposit.taoWei) : 0n;
  const amount = deposit.amountUsd !== undefined ? formatUsdShort(deposit.amountUsd) : `${formatTao(deposit.taoAmount, 4)} TAO`;
  // a stake to carry on here: held, with its reason, while the contracts don't match; none on a retired deployment
  const carriesOn = !retired && (deposit.status === "needs_you" || (deposit.status === "failed" && !!deposit.retryable));
  const restake = !retired && deposit.status === "failed" && !!deposit.restake;
  // still in its open batch: the TAO a cancel takes back out of it
  const cancellableWei = deposit.cancellableWei;
  return (
    <>
      <BackLink />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(deposit.createdAt)} deposit</p>
        <h2 className={styles.panelTitle}>{staked ? `Where your ${amount} went` : `Where your ${amount} is going`}</h2>
        <Trail steps={deposit.steps} label="Deposit steps" />
        <dl className={styles.rows}>
          <div>
            <dt>{staked ? "Worth now" : "TAO in this deposit"}</dt>
            <dd>
              {staked
                ? position && !position.priceMissing
                  ? formatUsd(deposit.taoAmount * position.taoPriceUsd)
                  : "–"
                : `${formatTao(deposit.taoAmount, 4)} TAO`}
            </dd>
          </div>
          {/* the price this deposit's TAO was bought at (known for a deposit made from this browser): the list's row
              leaves it out on a phone, so the receipt carries it */}
          {deposit.taoPriceUsd !== undefined && (
            <div>
              <dt>Bought at</dt>
              <dd>{formatUsd(deposit.taoPriceUsd)} per TAO</dd>
            </div>
          )}
          {deposit.feesUsd !== undefined && (
            <div>
              {/* v3's figure is Cascade's fees and the pools' together */}
              <dt>{v3 ? "Fees" : "Swap fees"}</dt>
              <dd>{formatUsd(deposit.feesUsd)}</dd>
            </div>
          )}
        </dl>
        {/* still in its open batch: when it leaves, and its two buttons in one row, Send it now and the cancel. The cancel
            is the receipt's own: it shows whatever the batch's block has to show (SendItNow, `action`) */}
        <SendItNow
          account={account}
          what="deposit"
          waiting={cancellableWei !== undefined}
          href={`/activity?deposit=${id}`}
          {...(cancellableWei !== undefined
            ? {
                action: (
                  <CancelDepositButton
                    deposit={deposit}
                    busy={flows.busy}
                    onCancel={() => void flows.cancel("deposit", id, cancellableWei, deposit.cancelBatchId).catch(() => undefined)}
                  />
                ),
                actionNote: <CancelDepositNote deposit={deposit} />,
              }
            : {})}
        />
        {/* a cancel sent from this browser, in the buttons' place: on its way, then what it came to */}
        {cancelSent && <BlockNotice {...cancelSentCopy("deposit", cancelSent)} />}
        {(carriesOn || restake || deposit.nothingSent || walletTaoBack > 0n) && (
          <Actions>
            {carriesOn &&
              deposit.status === "needs_you" &&
              (flows.moved?.id === id ? (
                // the price moved since the user last saw a figure (flows.error says by how much): today's
                // quote goes only once they say so, and is quoted again on the way (use-flows.ts, resumeStake)
                <button type="button" className="pill pill-block" disabled={flows.locked} onClick={() => void flows.resumeStake(id, flows.moved?.nowTao).catch(() => undefined)}>
                  {flows.busy === "stake" ? "Confirm in your wallet…" : "Continue at today's price"}
                </button>
              ) : (
                <button type="button" className="pill pill-block" disabled={flows.locked} onClick={() => void flows.resumeStake(id).catch(() => undefined)}>
                  {flows.busy === "stake" ? "Confirm in your wallet…" : "Continue this deposit"}
                </button>
              ))}
            {carriesOn && deposit.status === "failed" && deposit.retryable && (
              <button type="button" className="pill pill-block" disabled={flows.locked} onClick={() => void flows.resumeStake(id).catch(() => undefined)}>
                {flows.busy === "stake" ? "Confirm in your wallet…" : "Try the deposit again"}
              </button>
            )}
            {restake && (
              // a fresh stake of the same amount, quoted afresh on the stake form
              <Link href={stakeAgainHref(deposit.amountUsd)} className="pill pill-block">
                Stake again at today&apos;s price
              </Link>
            )}
            {walletTaoBack > 0n && (
              <button type="button" className="pill pill-block" disabled={flows.busy !== null} onClick={() => void flows.sellWalletTao(walletTaoBack).catch(() => undefined)}>
                {flows.busy === "swap" ? "Confirm in your wallet…" : "Swap your TAO back to USDC"}
              </button>
            )}
            {deposit.nothingSent && (
              <button
                type="button"
                className="pill pill-ghost pill-block"
                // sends nothing, so the wiring check doesn't hold it
                disabled={flows.busy !== null}
                onClick={() => {
                  if (flows.remove(id)) router.push("/activity");
                }}
              >
                Remove it (nothing was sent)
              </button>
            )}
          </Actions>
        )}
        {/* the contracts not matching holds only the carrying on; the ways out stay open */}
        {(flows.error ?? (carriesOn ? flows.blocked : null)) && (
          <p role="alert" className={styles.alert}>
            {flows.error ?? flows.blocked}
          </p>
        )}
      </div>
    </>
  );
}

export function WithdrawalDetail({ account, id }: { account: string; id: string }) {
  const { data: read, isPending, isFetching, isError, refetch } = useWithdrawal(account, id);
  const entry = usePendingEntry(account, "withdrawal", id);
  // the same query as the receipt's: one read serves both
  const all = useWithdrawals(account);
  const flows = useFlows(account);
  // a cancel this browser sent that the record, read before it, doesn't show yet (as a deposit's receipt: cancel-sent.ts)
  const cancelSent = useCancelsSent(account, "withdrawal", flows.busy !== null)(read);
  const withdrawal = read && cancelSent ? withdrawalCancelSent(read, cancelSent) : read;
  // the cancel's small print, which its button is described by
  const cancelNoteId = useId();
  // v3.2 with USDC delivery off (Task 60, spec §5): claims as TAO alone, and the prompt while the chain holds a preference
  const usdcDelivery = useUsdcDelivery();
  const preference = useDeliveryPreference(account, !usdcDelivery);
  // the request fee the cancel doesn't refund, as the deployment launched with it (v3.2's 0.0002 ETH, v3-launch's 0.0001)
  const feeEth = requestFeeEth(useIsV32());
  // a claim whose swap failed (with a batching wallet both roll back): offer the TAO without the swap
  const [claimFailed, setClaimFailed] = useState(false);
  // the claim button pressed (its keepTao), while its claim runs: only it says to confirm in the wallet
  const [pressed, setPressed] = useState<boolean | null>(null);
  // one claim pays everything back on Base, so it settles every unstake that is ready
  const ready = (all.data ?? []).filter(offersClaim).map((w) => w.id);
  const claimIds = ready.includes(id) ? ready : [...ready, id];
  const shows = receiptShows({ record: withdrawal, entry, isPending, isFetching, isError });
  if (entry && (shows === "pending" || shows === "pending-error")) {
    return <PendingReceipt entry={entry} {...(shows === "pending-error" ? { onRetry: () => void refetch() } : {})} />;
  }
  if (shows === "error") return <LoadError what="this unstake" onRetry={() => void refetch()} />;
  if (shows === "loading") return <Loading label="Loading your unstake…" />;
  if (!withdrawal) return <NotFound what="unstake" />;

  const paid = withdrawal.status === "paid";
  // what this receipt claims: the claim it offers, and with USDC delivery off one being delivered too (claiming it as TAO
  // now clears the preference before the keeper sells it)
  const claimHere = offersClaim(withdrawal) || (!usdcDelivery && isDelivering(withdrawal) && withdrawal.claimable > 0n);
  const choices = claimHere ? claimChoices({ keepsTao: withdrawal.keepsTao === true, saleHeld: flows.saleHeld, claimFailed, usdcDelivery }) : [];
  const prompt = !usdcDelivery && claimHere ? deliveryOffClaim(withdrawal.claimable, { data: preference.data, isError: preference.isError })?.prompt : null;
  // the TAO this receipt claims or claimed as TAO: Add to wallet beside it, so the wallet shows it (Task 59b review, M4)
  const seeTao = choices.some((c) => c.keepTao) || withdrawal.received?.keptTao !== undefined;
  // dollars first: what comes back in USDC, falling back to TAO when there is no estimate
  const got = paid ? withdrawal.received?.usdc : undefined;
  const title =
    got !== undefined
      ? `Your unstake of ${formatUsd(got)}`
      : withdrawal.usdcAmount !== undefined
        ? `Your unstake of about ${formatUsd(withdrawal.usdcAmount)}`
        : `Your unstake of ${formatTao(withdrawal.taoAmount, 4)} TAO`;
  // still in its open batch: the shares a cancel takes back out of it
  const cancellableShares = withdrawal.cancellableShares;
  return (
    <>
      <BackLink href="/activity?tab=unstakes" />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>{formatDay(withdrawal.createdAt)} unstake</p>
        <h2 className={styles.panelTitle}>{title}</h2>
        <Trail steps={withdrawal.steps} label="Unstake steps" />
        <dl className={styles.rows}>
          {paid && withdrawal.received ? (
            <div>
              <dt>You received</dt>
              <dd>
                {withdrawal.received.usdc !== undefined
                  ? `${formatUsdc(withdrawal.received.usdc)} USDC on Base`
                  : `${formatTao(withdrawal.received.keptTao ?? 0, 4)} TAO on Base`}
              </dd>
            </div>
          ) : withdrawal.belowMinimum ? (
            // v3, the price under the minimum: what it would fetch now, not the estimate from the request
            withdrawal.belowMinimum.usdcNow !== undefined && (
              <div>
                <dt>You will receive</dt>
                <dd>about {formatUsd(withdrawal.belowMinimum.usdcNow)} at today&apos;s price</dd>
              </div>
            )
          ) : (
            !paid &&
            withdrawal.status !== "cancelled" &&
            withdrawal.usdcAmount !== undefined && (
              <div>
                <dt>You will receive</dt>
                <dd>about {formatUsdc(withdrawal.usdcAmount)} USDC on Base</dd>
              </div>
            )
          )}
        </dl>
        {/* still in its open batch: when it leaves, and its two buttons in one row, Send it now and the cancel (the
            receipt's own, shown whatever the batch's block has to show), with what the cancel doesn't refund under them */}
        <SendItNow
          account={account}
          what="unstake"
          waiting={cancellableShares !== undefined}
          href={`/activity?withdrawal=${id}`}
          {...(cancellableShares !== undefined
            ? {
                action: (
                  <button
                    type="button"
                    className="pill pill-ghost pill-danger"
                    aria-describedby={cancelNoteId}
                    disabled={flows.busy !== null}
                    onClick={() => void flows.cancel("withdrawal", id, cancellableShares).catch(() => undefined)}
                  >
                    {flows.busy === "cancel" ? "Confirm in your wallet…" : "Cancel unstake"}
                  </button>
                ),
                actionNote: <p id={cancelNoteId}>{`If you cancel, the ${feeEth} ETH request fee isn't refunded.`}</p>,
              }
            : {})}
        />
        {/* a cancel sent from this browser, in the buttons' place: on its way, then what it came to */}
        {cancelSent && <BlockNotice {...cancelSentCopy("unstake", cancelSent)} />}
        {usdcDelivery && withdrawal.status === "needs_you" && withdrawal.steps[3]?.status === "action" && (
          <Actions>
            <button type="button" className="pill pill-block" disabled={flows.busy !== null} onClick={() => void flows.resumeClaim(id).catch(() => undefined)}>
              {flows.busy === "claim" ? "Confirm in your wallet…" : "Swap it to USDC"}
            </button>
          </Actions>
        )}
        {withdrawal.unstakeAgain && (
          <Actions>
            <Link href="/unstake" className="pill pill-block">
              Unstake again
            </Link>
          </Actions>
        )}
        {claimHere && (
          <Actions>
            {prompt && (
              <p role="status" className={styles.panelText}>
                {prompt}
              </p>
            )}
            {claimHere &&
              // Claim as USDC first, the TAO itself after a sale held by the price check (flows.error says why) or a claim
              // whose swap failed; v3.2's Receive TAO asked for it as TAO from the start, so that leads (stake-form.ts); with
              // USDC delivery off, Claim as TAO alone
              choices.map((choice, i) => (
                <button
                  key={choice.label}
                  type="button"
                  className={i === 0 ? "pill pill-block" : "pill pill-ghost pill-block"}
                  disabled={flows.busy !== null}
                  onClick={() => {
                    setPressed(choice.keepTao);
                    void (choice.keepTao
                      ? flows.claim(claimIds, true).catch(() => undefined)
                      : flows.claim(claimIds, false).then(() => setClaimFailed(false), () => setClaimFailed(true))
                    ).finally(() => setPressed(null));
                  }}
                >
                  {claimButtonLabel(choice, { busy: flows.busy, pressed })}
                </button>
              ))}
            {/* beside the claim with USDC delivery off: the preference turned off at once (Task 60 follow-up) */}
            {claimHere && turnOffDeliveryOffered(usdcDelivery, { data: preference.data, isError: preference.isError }) && (
              <button type="button" className="pill pill-ghost pill-block" disabled={flows.busy !== null} onClick={() => void flows.turnOffDelivery().catch(() => undefined)}>
                {flows.busy === "delivery" ? "Confirm in your wallet…" : TURN_OFF_DELIVERY}
              </button>
            )}
          </Actions>
        )}
        {seeTao && (
          <Actions>
            <p className={styles.panelText}>{SEE_YOUR_TAO}</p>
            <AddToWallet className="pill pill-ghost pill-block" noteClassName={styles.panelText} />
          </Actions>
        )}
        {/* an unstake's actions here (claim, swap, cancel) are all ways out, never held */}
        {flows.error && (
          <p role="alert" className={styles.alert}>
            {flows.error}
          </p>
        )}
      </div>
    </>
  );
}

/** Under the deposits while the history indexer's older history is still being checked against the chain. */
export const OLDER_CHECKING = "Checking older history against the chain…";

const TABS: { key: ActivityTab; label: string; href: string }[] = [
  { key: "deposits", label: "Deposits", href: "/activity" },
  { key: "unstakes", label: "Unstakes", href: "/activity?tab=unstakes" },
];

/** Deposits or unstakes, one at a time. Each tab shows its count once known, and Unstakes a dot while
 * money is ready to claim (`offersClaim`, which clears once it's claimed or delivered), so a claim
 * can't hide behind Deposits. The open tab shows as soon as its own list is read. Until then (and above a
 * list read before them) this browser's deposits and unstakes of the last day show at once from its own
 * records, said to be unconfirmed, each giving way to its record once the list holds it. */
export function Lists({ account, tab }: { account: string; tab: ActivityTab }) {
  const deposits = useDeposits(account);
  const withdrawals = useWithdrawals(account);
  // older history from the indexer the browser hasn't read itself yet: a deposit made from another
  // browser may still be missing from the list, so the list says so. Read only for the deposits, and
  // only where an indexer is named (with none, nothing is ever seeded: no reads for it)
  const indexer = useIndexerNamed();
  // a retired deployment's empty deposit list invites no stake (Task 60 review, Minor 1)
  const retired = useRetired();
  const asked = tab === "deposits" && indexer;
  const history = usePositionHistory(account, asked);
  const olderChecking = asked && history.data?.provisional === true;
  const pending = {
    deposits: usePendingEntries(account, "deposit", deposits.data),
    unstakes: usePendingEntries(account, "withdrawal", withdrawals.data),
  };
  const lists = { deposits: deposits.data, unstakes: withdrawals.data };
  const open = tab === "deposits" ? deposits : withdrawals;
  const list = lists[tab];
  const sent = pending[tab];
  const rows =
    tab === "deposits" ? (
      <DepositList deposits={deposits.data ?? []} pending={sent} retired={retired} />
    ) : (
      <WithdrawalList withdrawals={withdrawals.data ?? []} pending={sent} />
    );
  return (
    <>
      <nav className={styles.switch} aria-label="Activity">
        {TABS.map((t) => {
          const items = lists[t.key];
          return (
            <Link
              key={t.key}
              href={t.href}
              replace
              scroll={false}
              className={`${styles.switchTab} ${t.key === tab ? styles.switchOn : ""}`}
              aria-current={t.key === tab ? "page" : undefined}
            >
              {t.label}
              {items && <span className="sr-only">: </span>}
              <span className={styles.count}>{items ? items.length + pending[t.key].length : ""}</span>
              {t.key === "unstakes" && withdrawals.data?.some(offersClaim) && (
                <span className={styles.attention}>
                  <span className="sr-only">, money ready to claim</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      {open.isError ? (
        <>
          {/* only what was just sent: records kept from an earlier read never show above the error */}
          {sent.length > 0 && (
            <section className={styles.section}>
              {tab === "deposits" ? <DepositList deposits={[]} pending={sent} /> : <WithdrawalList withdrawals={[]} pending={sent} />}
            </section>
          )}
          <LoadError
            what="your activity"
            onRetry={() => {
              void deposits.refetch();
              void withdrawals.refetch();
            }}
          />
        </>
      ) : !list && sent.length === 0 ? (
        <Loading />
      ) : (
        <section className={styles.section} aria-label={tab === "deposits" ? "Your deposits" : "Your unstakes"}>
          {rows}
          {!list && <Loading inline label="Reading the rest from Base and Bittensor…" />}
          {list && olderChecking && <p className="small">{OLDER_CHECKING}</p>}
        </section>
      )}
    </>
  );
}

function ActivityBody({ account }: { account: string }) {
  const params = useSearchParams();
  const view = parseActivityParams(params);
  if (view.kind === "deposit") return <DepositDetail account={account} id={view.id} />;
  if (view.kind === "withdrawal") return <WithdrawalDetail account={account} id={view.id} />;
  return <Lists account={account} tab={view.tab} />;
}

/** `/activity`: the lists, or one receipt trail when the query string names a deposit or unstake. */
export function ActivityScreen() {
  const { state } = useCascadeAccount();
  const account = state.status === "wallet" ? state.account : null;

  return (
    <AppShell active="activity">
      <h1 className={app.title}>Activity</h1>
      <p className={app.sub}>Every deposit and unstake, with receipts</p>
      <RetiredNotice />
      {state.status === "loading" ? (
        <Loading />
      ) : account ? (
        <Suspense fallback={<Loading />}>
          <ActivityBody account={account} />
        </Suspense>
      ) : (
        <div className={`${app.card} ${styles.panel}`}>
          <p className={styles.panelTitle}>Connect a wallet to see your activity.</p>
          <p className={styles.panelText}>Your deposits and unstakes show up here with a receipt for every step.</p>
          <ConnectWallet variant="pill-block" />
        </div>
      )}
    </AppShell>
  );
}
