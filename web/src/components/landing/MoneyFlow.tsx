import type { DepositQuote } from "@/lib/cascade/types";
import { formatTao, formatUsd, formatUsdc } from "@/lib/format";
import { formatApr } from "@/lib/stats";
import styles from "./MoneyFlow.module.css";

const ROUTE = "M44 92 H214 V206 H384 V320 H556";

function Check({ green = false }: { green?: boolean }) {
  return (
    <span className={`${styles.tick} ${green ? styles.tickGreen : ""}`} aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 13 13">
        <path
          d="M2.5 6.8l2.6 2.6 5.4-6"
          fill="none"
          stroke="#fff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * The route a deposit takes, drawn as a descending cascade: wallet, swapped, staked.
 * Amounts come from a live quote for an example deposit, never from literals.
 */
export function MoneyFlow({ quote, aprPercent }: { quote?: DepositQuote; aprPercent?: number }) {
  const usdc = quote ? `${formatUsdc(quote.amountUsd)} USDC` : "–";
  const tao = quote ? `${formatTao(quote.estTao, 2)} TAO` : "–";
  const price = quote ? `Bought at ${formatUsd(quote.taoPriceUsd)} each` : "";
  const earning = aprPercent !== undefined ? `Earning ${formatApr(aprPercent)} a year in TAO` : "";

  return (
    <div className={styles.wrap}>
      <p className="sr-only">
        A deposit of {usdc} in your wallet on Base is swapped for {tao}, crosses to Bittensor over
        Chainlink CCIP and is staked. Rewards land in your balance every day.
      </p>
      <div className={styles.flow} aria-hidden="true">
        <svg className={styles.route} viewBox="0 0 600 430" fill="none">
          <path id="cascade-route" d={ROUTE} stroke="#CFE0E6" strokeWidth="3" strokeLinecap="round" />
          <path d={ROUTE} stroke="#2E8FA3" strokeWidth="3" strokeLinecap="round" strokeDasharray="6 10" opacity="0.55" />
          {[0, 2.3, 4.6].map((begin, i) => (
            <circle key={begin} className={styles.dot} r="6" fill="#2E8FA3" opacity={1 - i * 0.27}>
              <animateMotion dur="7s" repeatCount="indefinite" begin={`${begin}s`}>
                <mpath href="#cascade-route" />
              </animateMotion>
            </circle>
          ))}
        </svg>

        <div className={styles.tile} style={{ left: 44, top: 78 }}>
          <p className={styles.k}>Your wallet, on Base</p>
          <p className={styles.v}>
            <span className={`${styles.coin} ${styles.usdc}`}>$</span>
            {usdc}
          </p>
          <p className={styles.s}>Deposited just now</p>
        </div>

        <span className={styles.cap} style={{ left: 202, top: 134 }}>
          swapped for TAO
        </span>

        <div className={styles.tile} style={{ left: 230, top: 192 }}>
          <p className={styles.k}>Your TAO</p>
          <p className={styles.v}>
            <span className={`${styles.coin} ${styles.taoCoin}`}>τ</span>
            {tao}
          </p>
          <p className={styles.s}>{price}</p>
        </div>

        <span className={styles.cap} style={{ left: 372, top: 248 }}>
          crosses via Chainlink CCIP
        </span>

        <div className={styles.tile} style={{ left: 400, top: 306 }}>
          <p className={styles.k}>Staked on Bittensor</p>
          <p className={styles.v}>
            <Check />
            {tao}
          </p>
          <p className={styles.s}>{earning}</p>
        </div>

        <span className={styles.end} style={{ left: 286, top: 372 }}>
          <Check green />
          Rewards land in your balance every day
        </span>
      </div>
    </div>
  );
}
