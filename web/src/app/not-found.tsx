import Link from "next/link";
import { BackTopBar } from "@/components/TopBar";

export default function NotFound() {
  return (
    <>
      <BackTopBar title="Not found" />
      <p className="strong">There&apos;s nothing at this address.</p>
      <p className="small">
        <Link href="/" className="link">
          Go to your balance
        </Link>
      </p>
    </>
  );
}
