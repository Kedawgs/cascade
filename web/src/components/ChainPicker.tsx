import { SOURCE_CHAINS } from "@/lib/cascade/chains";
import type { SourceChain } from "@/lib/cascade/types";
import styles from "./Form.module.css";

export function ChainPicker({
  value,
  onChange,
}: {
  value: SourceChain;
  onChange: (chain: SourceChain) => void;
}) {
  return (
    <fieldset className={styles.chainSet}>
      <legend className="small">Deposit from</legend>
      <div className={styles.chains}>
        {SOURCE_CHAINS.map((c) => (
          <label key={c.id} className={styles.chain}>
            <input
              type="radio"
              name="chain"
              value={c.id}
              checked={value === c.id}
              onChange={() => onChange(c.id)}
              className={styles.radio}
            />
            <span className={styles.chainDot} style={{ background: c.color }} aria-hidden="true" />
            {c.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
