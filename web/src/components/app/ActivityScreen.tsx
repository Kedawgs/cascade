"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { useCascadeAccount } from "@/lib/account";
import {
  useBalances,
  useDeposit,
  useDeposits,
  useIsV3,
  usePendingEntries,
  usePendingEntry,
  usePosition,
  useWithdrawal,
  useWithdrawals,
} from "@/lib/cascade/hooks";
import { type ActivityTab, parseActivityParams } from "@/lib/activity-params";
import { type PendingEntry, receiptShows } from "@/lib/cascade/pending";
import { offersClaim } from "@/lib/cascade/trail";
import { useFlows } from "@/lib/cascade/use-flows";
import { formatDay, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
import { sentRows } from "@/lib/sent";
import { stakeAgainHref } from "@/lib/stake-form";
import { DepositList, WithdrawalList } from "../ActivityList";
import { ConnectWallet } from "../ConnectWallet";
import { LoadError } from "../LoadError";
import { Loading } from "../Loading";
import { ReceiptLink } from "../ReceiptLink";
import { Trail } from "../Trail";
import app from "./App.module.css";
import { AppShell } from "./AppShell";
import { SendItNow } from "./SendItNow";
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

/** A receipt Activity hasn't read from the chain yet: this browser's own entry for it, said plainly to be
 * unconfirmed, with the figures it was sent with and its transaction, until the list read from the chain
 * holds its record (pending.ts). `onRetry` when that read failed. */
export function PendingReceipt({ entry, onRetry }: { entry: PendingEntry; onRetry?: () => void }) {
  const n = entry.notice;
  const deposit = n.kind === "deposit";
  const title = deposit
    ? `Where your ${n.usdc !== undefined ? formatUsdShort(n.usdc) : `${formatTao(n.tao, 4)} TAO`} is going`
    : `Your unstake of about ${formatUsd(n.usdc)}`;
  return (
    <>
      <BackLink href={deposit ? "/activity" : "/activity?tab=unstakes"} />
      <div className={`${app.card} ${styles.panel}`}>
        <p className={styles.kicker}>
          {formatDay(entry.createdAt)} {deposit ? "deposit" : "unstake"}
        </p>
        <h2 className={styles.panelTitle}>{title}</h2>
        <p className={styles.confirming} role="status">
          <span className="loading-spinner" aria-hidden="true" />
          Submitted, confirming…
        </p>
        <p className={styles.panelText}>
          Sent from this browser, and not confirmed here yet: its steps show as soon as Base and Bittensor have been read. Until
          then, these are the figures it was sent with.
        </p>
        <dl className={styles.rows}>
          {sentRows(n).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {entry.txUrl && (
          <ReceiptLink href={entry.txUrl} className={styles.tx}>
            View the transaction on Base
          </ReceiptLink>
        )}
      </div>
      {onRetry && <LoadError what={deposit ? "this deposit" : "this unstake"} onRetry={onRetry} />}
    </>
  );
}

export function DepositDetail({ account, id }: { account: string; id: string }) {
  const { data: deposit, isPending, isFetching, isError, refetch } = useDeposit(account, id);
  const entry = usePendingEntry(account, "deposit", id);
  const v3 = useIsV3();
  const { data: position } = usePosition(account);
  const wallet = useBalances(account);
  const flows = useFlows(account);
  const router = useRouter();
  const shows = receiptShows({ record: deposit, entry, isPending, isFetching, isError });
  if (entry && (shows === "pending" || shows === "pending-error")) {
    return <PendingReceipt entry={entry} {...(shows === "pending-error" ? { onRetry: () => void refetch() } : {})} />;
  }
  if (shows === "error") return <LoadError what="this deposit" onRetry={() => void refetch()} />;
  if (shows === "loading") return <Loading label="Loading your deposit…" />;
  if (!deposit) return <NotFound what="deposit" />;

  const staked = deposit.status === "staked";
  const walletTao = wallet.data?.tao ?? 0n;
  const walletTaoBack = deposit.status === "cancelled" ? (walletTao < deposit.taoWei ? walletTao : deposit.taoWei) : 0n;
  const amount = deposit.amountUsd !== undefined ? formatUsdShort(deposit.amountUsd) : `${formatTao(deposit.taoAmount, 4)} TAO`;
  // a stake to carry on here: held, with its reason, while the contracts don't match
  const carriesOn = deposit.status === "needs_you" || (deposit.status === "failed" && !!deposit.retryable);
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
                ? position
                  ? formatUsd(deposit.taoAmount * position.taoPriceUsd)
                  : "–"
                : `${formatTao(deposit.taoAmount, 4)} TAO`}
            </dd>
          </div>
          {deposit.feesUsd !== undefined && (
            <div>
              {/* v3's figure is Cascade's fees and the pools' together */}
              <dt>{v3 ? "Fees" : "Swap fees"}</dt>
              <dd>{formatUsd(deposit.feesUsd)}</dd>
            </div>
          )}
        </dl>
        {/* still in its open batch: when it leaves, and Send it now */}
        <SendItNow account={account} what="deposit" waiting={deposit.cancellableWei !== undefined} href={`/activity?deposit=${id}`} />
        {(deposit.status === "needs_you" || deposit.retryable || deposit.restake || deposit.nothingSent || deposit.cancellableWei !== undefined || walletTaoBack > 0n) && (
          <Actions>
            {deposit.status === "needs_you" &&
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
            {deposit.status === "failed" && deposit.retryable && (
              <button type="button" className="pill pill-block" disabled={flows.locked} onClick={() => void flows.resumeStake(id).catch(() => undefined)}>
                {flows.busy === "stake" ? "Confirm in your wallet…" : "Try the deposit again"}
              </button>
            )}
            {deposit.status === "failed" && deposit.restake && (
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
            {deposit.cancellableWei !== undefined && (
              <button
                type="button"
                className="pill pill-ghost pill-block"
                disabled={flows.busy !== null}
                onClick={() => void flows.cancel("deposit", id, deposit.cancellableWei as bigint).catch(() => undefined)}
              >
                Cancel this deposit before its batch closes
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
  const { data: withdrawal, isPending, isFetching, isError, refetch } = useWithdrawal(account, id);
  const entry = usePendingEntry(account, "withdrawal", id);
  // the same query as the receipt's: one read serves both
  const all = useWithdrawals(account);
  const flows = useFlows(account);
  // a claim whose swap failed (with a batching wallet both roll back): offer the TAO without the swap
  const [claimFailed, setClaimFailed] = useState(false);
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
  // dollars first: what comes back in USDC, falling back to TAO when there is no estimate
  const got = paid ? withdrawal.received?.usdc : undefined;
  const title =
    got !== undefined
      ? `Your unstake of ${formatUsd(got)}`
      : withdrawal.usdcAmount !== undefined
        ? `Your unstake of about ${formatUsd(withdrawal.usdcAmount)}`
        : `Your unstake of ${formatTao(withdrawal.taoAmount, 4)} TAO`;
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
        {/* still in its open batch: when it leaves, and Send it now */}
        <SendItNow account={account} what="unstake" waiting={withdrawal.cancellableShares !== undefined} href={`/activity?withdrawal=${id}`} />
        {withdrawal.status === "needs_you" && withdrawal.steps[3]?.status === "action" && (
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
        {(offersClaim(withdrawal) || withdrawal.cancellableShares !== undefined) && (
          <Actions>
            {offersClaim(withdrawal) && (
              <>
                <button
                  type="button"
                  className="pill pill-block"
                  disabled={flows.busy !== null}
                  onClick={() => void flows.claim(claimIds, false).then(() => setClaimFailed(false), () => setClaimFailed(true))}
                >
                  {flows.busy === "claim" ? "Confirm in your wallet…" : "Claim as USDC"}
                </button>
                {(claimFailed || flows.saleHeld) && (
                  // the TAO itself is always there to claim: after a sale held by the price check (flows.error says
                  // why), or a claim whose swap failed
                  <button type="button" className="pill pill-ghost pill-block" disabled={flows.busy !== null} onClick={() => void flows.claim(claimIds, true).catch(() => undefined)}>
                    {flows.saleHeld ? "Claim as TAO instead" : "Claim now and swap to USDC separately"}
                  </button>
                )}
              </>
            )}
            {withdrawal.cancellableShares !== undefined && (
              <button
                type="button"
                className="pill pill-ghost pill-block"
                disabled={flows.busy !== null}
                onClick={() => void flows.cancel("withdrawal", id, withdrawal.cancellableShares as bigint).catch(() => undefined)}
              >
                Cancel this unstake (the 0.0001 ETH request fee isn&apos;t refunded)
              </button>
            )}
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
      <DepositList deposits={deposits.data ?? []} pending={sent} />
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
