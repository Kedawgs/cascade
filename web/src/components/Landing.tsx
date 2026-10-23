import { ConnectWallet } from "./ConnectWallet";
import { Logo } from "./Logo";
import styles from "./Landing.module.css";
import topBar from "./TopBar.module.css";

const POINTS = [
  {
    title: "Check it any time.",
    body: "A live on-chain check shows that your TAO is staked.",
  },
  {
    title: "Follow every deposit.",
    body: "See each step it takes, with a receipt anyone can look up.",
  },
  {
    title: "Rewards on their own line.",
    body: "What staking earns you is shown apart from TAO's price moves.",
  },
];

export function Landing({ onTryDemo }: { onTryDemo: () => void }) {
  return (
    <>
      <header className={topBar.bar}>
        <Logo />
      </header>
      <h1 className={styles.title}>Stake TAO from the wallet you already have</h1>
      <p className={styles.lead}>
        Deposit USDC from Base, Ethereum, BNB Chain or Polygon. Cascade swaps it for TAO and
        stakes it on Bittensor for you. You don&apos;t need a Bittensor wallet.
      </p>
      <ul className={styles.points}>
        {POINTS.map((p) => (
          <li key={p.title}>
            <span className={styles.tick} aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>{p.title}</strong> {p.body}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <ConnectWallet />
        <button type="button" className="btn btn-ghost btn-block" onClick={onTryDemo}>
          Try the demo
        </button>
      </div>
      <p className={`small ${styles.footnote}`}>
        The demo uses a sample account with made-up numbers. Nothing leaves your wallet.
      </p>
    </>
  );
}
