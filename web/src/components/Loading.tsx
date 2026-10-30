/** A visible placeholder while chain data loads: a small spinner and what is being checked. `inline`: one
 * line, under content already shown, rather than the screen's whole placeholder. */
export function Loading({ label = "Checking Base and Bittensor…", inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? "loading loading-inline" : "loading"} role="status" aria-busy="true">
      <span className="loading-spinner" aria-hidden="true" />
      <span className="loading-label">{label}</span>
    </div>
  );
}
