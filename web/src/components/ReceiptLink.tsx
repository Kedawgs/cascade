"use client";

import type { ReactNode } from "react";

/** Link to an on-chain receipt (Basescan, Taostats or the CCIP explorer), opening in a new tab. */
export function ReceiptLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
