"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useCascadeAccount } from "@/lib/account";

export function Loading() {
  return (
    <div className="loading" aria-busy="true">
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Renders its children with the active account, or sends the visitor home to connect. */
export function RequireAccount({ children }: { children: (account: string) => ReactNode }) {
  const { state } = useCascadeAccount();
  const router = useRouter();

  useEffect(() => {
    if (state.status === "none") router.replace("/");
  }, [state.status, router]);

  if (state.status === "wallet" || state.status === "demo") return children(state.account);
  return <Loading />;
}
