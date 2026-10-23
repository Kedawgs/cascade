"use client";

import { useNow } from "@/lib/client-state";
import { formatRelative, formatTao, shortAddress } from "@/lib/format";
import type { StakeProof } from "@/lib/cascade/types";
import { ReceiptLink } from "./ReceiptLink";
import styles from "./ProofBox.module.css";

/** The green "it's all staked" check from proof option A. */
export function ProofBox({ proof, pendingTao }: { proof: StakeProof; pendingTao: number }) {
  const now = useNow();

  if (proof.owedTao <= 0) {
    return (
      <section className={`box ${styles.box}`} aria-label="Staking check">
        <p className="strong">
          {pendingTao > 0 ? "Your first deposit is on its way" : "Nothing staked yet"}
        </p>
        <p className="small">Once your TAO is staked, a live on-chain check will show it here.</p>
      </section>
    );
  }

  const headline = proof.allStaked
    ? `All ${formatTao(proof.stakedTao)} TAO is staked on Bittensor right now`
    : `${formatTao(proof.stakedTao)} of ${formatTao(proof.owedTao)} TAO is staked on Bittensor right now`;

  return (
    <section className={`box ${styles.box}`} aria-label="Staking check">
      <div className={styles.check}>
        <span className={proof.allStaked ? styles.tick : styles.warn} aria-hidden="true">
          {proof.allStaked ? "✓" : "!"}
        </span>
        <div>
          <p className="strong">{headline}</p>
          <p className="small">
            Checked on-chain {formatRelative(proof.checkedAt, now)}. Validator{" "}
            <span title={proof.validatorHotkey}>{shortAddress(proof.validatorHotkey)}</span>.
          </p>
          <ReceiptLink href={proof.explorerUrl} className={`link ${styles.link}`}>
            See it on Bittensor
          </ReceiptLink>
        </div>
      </div>
    </section>
  );
}
