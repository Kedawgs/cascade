"use client";

import type { ReactNode } from "react";

/**
 * Link to an on-chain receipt. The mock adapter uses "#" because demo steps
 * have no real transaction; those links say so instead of going anywhere.
 */
export function ReceiptLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  if (href === "#") {
    return (
      <a
        href="#"
        className={className}
        title="Demo only: there's no real transaction to show"
        onClick={(e) => e.preventDefault()}
      >
        {children}
        <span className="sr-only"> (demo only, no real transaction)</span>
      </a>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
