/** A quiet placeholder that keeps the page height while data loads. */
export function Loading() {
  return (
    <div className="loading" aria-busy="true">
      <span className="sr-only">Loading</span>
    </div>
  );
}
