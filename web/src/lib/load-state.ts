/** The three states a data-backed element can be in. Errors win over "still loading". */
export type LoadState = "loading" | "error" | "ready";

export function loadState(q: { isError: boolean; data: unknown }): LoadState {
  if (q.isError) return "error";
  if (q.data === undefined) return "loading";
  return "ready";
}
