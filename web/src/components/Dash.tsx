/** "–" in a figure's place while it loads or when it can't be shown, read out as what it means. */
export function Dash({ loading }: { loading: boolean }) {
  return (
    <>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{loading ? "Loading" : "Not available"}</span>
    </>
  );
}
