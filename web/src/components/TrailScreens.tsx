"use client";

import Link from "next/link";
import { useDeposit, usePosition, useWithdrawal } from "@/lib/cascade/hooks";
import { formatDay, formatTao, formatUsd, formatUsdc, formatUsdShort } from "@/lib/format";
import { Loading, RequireAccount } from "./RequireAccount";
import { BackTopBar } from "./TopBar";
import { Trail } from "./Trail";
import styles from "./Form.module.css";

function NotFound({ what }: { what: string }) {
  return (
    <>
      <p className="strong">We couldn&apos;t find this {what}.</p>
      <p className="small">
        It may belong to a different wallet. <Link href="/" className="link">Go to your balance</Link>
      </p>
    </>
  );
}

/** `/deposits/[id]`: trail B for one deposit. */
export function DepositTrailScreen({ id }: { id: string }) {
  return <RequireAccount>{(account) => <DepositTrail account={account} id={id} />}</RequireAccount>;
}

function DepositTrail({ account, id }: { account: string; id: string }) {
  const { data: deposit, isPending } = useDeposit(account, id);
  const { data: position } = usePosition(account);

  if (isPending) return <><BackTopBar title="Deposit" /><Loading /></>;
  if (!deposit) return <><BackTopBar title="Deposit" /><NotFound what="deposit" /></>;

  const inProgress = deposit.status === "in_progress";
  const amount = formatUsdShort(deposit.amountUsd);
  return (
    <>
      <BackTopBar title={`${formatDay(deposit.createdAt)} deposit`} />
      <h1 className="small">{inProgress ? `Where your ${amount} is going` : `Where your ${amount} went`}</h1>
      <Trail steps={deposit.steps} label="Deposit steps" />
      <div className={`box ${styles.rows}`}>
        {inProgress ? (
          <div>
            <span>You&apos;ll get about</span>
            <b>{formatTao(deposit.taoAmount)} TAO staked</b>
          </div>
        ) : (
          <div>
            <span>Worth now</span>
            <b>
              {position
                ? formatUsd((deposit.taoAmount + deposit.rewardsTao) * position.taoPriceUsd)
                : "–"}
            </b>
          </div>
        )}
      </div>
    </>
  );
}

/** `/withdrawals/[id]`: the same kind of trail for a withdrawal. */
export function WithdrawalTrailScreen({ id }: { id: string }) {
  return (
    <RequireAccount>{(account) => <WithdrawalTrail account={account} id={id} />}</RequireAccount>
  );
}

function WithdrawalTrail({ account, id }: { account: string; id: string }) {
  const { data: withdrawal, isPending } = useWithdrawal(account, id);

  if (isPending) return <><BackTopBar title="Withdrawal" /><Loading /></>;
  if (!withdrawal) return <><BackTopBar title="Withdrawal" /><NotFound what="withdrawal" /></>;

  const paid = withdrawal.status === "paid";
  const tao = formatTao(withdrawal.taoAmount);
  return (
    <>
      <BackTopBar title={`${formatDay(withdrawal.createdAt)} withdrawal`} />
      <h1 className="small">{paid ? `Where your ${tao} TAO went` : `Where your ${tao} TAO is going`}</h1>
      <Trail steps={withdrawal.steps} label="Withdrawal steps" />
      <div className={`box ${styles.rows}`}>
        <div>
          <span>{paid ? "You got" : "You'll get about"}</span>
          <b>{formatUsdc(withdrawal.usdcAmount)} USDC on Base</b>
        </div>
      </div>
    </>
  );
}
