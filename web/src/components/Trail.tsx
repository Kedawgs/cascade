import { formatDateTime } from "@/lib/format";
import type { TrailStep } from "@/lib/cascade/types";
import { ReceiptLink } from "./ReceiptLink";
import styles from "./Trail.module.css";

const STATUS_WORD = { done: "done", active: "in progress", pending: "not started yet", action: "waiting for you", failed: "failed" } as const;

function stepNote(step: TrailStep): string | undefined {
  if (step.detail) return step.detail;
  if (step.at) return formatDateTime(step.at);
  if (step.status === "active") return "In progress";
  return step.status === "action" ? "Waiting for you" : undefined;
}

/** The step-by-step trail from mockup B. The last step turns green once it's done. */
export function Trail({ steps, label }: { steps: TrailStep[]; label: string }) {
  const last = steps.length - 1;
  const active = steps.findIndex((s) => s.status === "active" || s.status === "action" || s.status === "failed");
  const announcement =
    active === -1
      ? `${steps[last]?.title ?? ""}.`
      : `Step ${active + 1} of ${steps.length}: ${steps[active].title}.`;

  return (
    <>
      <ol className={styles.trail} aria-label={label}>
        {steps.map((step, i) => {
          const finished = step.status === "done" && i === last;
          const note = stepNote(step);
          return (
            <li
              key={step.key}
              className={`${styles.step} ${styles[step.status]} ${finished ? styles.finished : ""}`}
              aria-current={step.status === "active" ? "step" : undefined}
            >
              <span className={styles.dot} aria-hidden="true">
                {finished ? "✓" : i + 1}
              </span>
              <p className={styles.title}>
                <span className="sr-only">{`Step ${i + 1}, ${STATUS_WORD[step.status]}: `}</span>
                {step.title}
              </p>
              {note && <p className="small">{note}</p>}
              {step.txUrl && (
                <ReceiptLink href={step.txUrl} className={styles.tx}>
                  {step.txLabel ?? "View transaction"}
                </ReceiptLink>
              )}
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
