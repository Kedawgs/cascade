"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Client-side redirect for routes that moved. Works on a static host with no rewrite rules. */
export function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return (
    <p className="col" style={{ padding: "48px 20px" }}>
      This page has moved.{" "}
      <Link href={to} className="link">
        Continue
      </Link>
    </p>
  );
}
