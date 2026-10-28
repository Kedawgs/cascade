/** Which list the Activity tab shows. */
export type ActivityTab = "deposits" | "unstakes";

/** What the Activity tab shows, read from the query string so it works on a static host. */
export type ActivityView =
  | { kind: "list"; tab: ActivityTab }
  | { kind: "deposit"; id: string }
  | { kind: "withdrawal"; id: string };

export function parseActivityParams(params: URLSearchParams): ActivityView {
  const deposit = params.get("deposit");
  if (deposit) return { kind: "deposit", id: deposit };
  const withdrawal = params.get("withdrawal");
  if (withdrawal) return { kind: "withdrawal", id: withdrawal };
  return { kind: "list", tab: params.get("tab") === "unstakes" ? "unstakes" : "deposits" };
}
