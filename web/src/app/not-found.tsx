import Link from "next/link";

export default function NotFound() {
  return (
    <div className="col" style={{ padding: "64px 20px" }}>
      <p className="strong">There&apos;s nothing at this address.</p>
      <p className="small">
        <Link href="/stake" className="link">
          Go to the stake page
        </Link>
      </p>
    </div>
  );
}
