import Link from "next/link";
import { DEPLOYMENT, deploymentStage, type Stage } from "@/lib/cascade/config";
import { RETIRED_NOT_FOUND_LINK } from "@/lib/cascade/flows";

/** The page not found: a way back to the Stake page. On a retired deployment (`stage`, the build's unless a test gives
 * one) it is named by that page's retired title, withdraw and claim, never as a stake page (Task 60 review, Minor 1). */
export function NotFoundBody({ stage = deploymentStage(DEPLOYMENT) }: { stage?: Stage }) {
  return (
    <div className="col" style={{ padding: "64px 20px" }}>
      <p className="strong">There&apos;s nothing at this address.</p>
      <p className="small">
        <Link href="/stake" className="link">
          {stage === "retired" ? RETIRED_NOT_FOUND_LINK : "Go to the stake page"}
        </Link>
      </p>
    </div>
  );
}
