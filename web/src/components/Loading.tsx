/** A visible placeholder while chain data loads: a small spinner and what is being checked. */
export function Loading({ label = "Checking Base and Bittensor…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-busy="true">
      <span className="loading-spinner" aria-hidden="true" />
      <span className="loading-label">{label}</span>
    </div>
  );
}
