"use client";
import Link from "next/link";
import { useState } from "react";

// Prefetch on intent: nothing is fetched until the pointer rests on the link (or it gets keyboard
// focus / a touch starts), then the whole page — data included — is fetched in the background, so
// it is usually ready by the time the click lands. Avoids prefetching every menu item on load.
export function NavLink({ href, children, ...rest }: React.ComponentProps<typeof Link> & { href: string }) {
  const [intent, setIntent] = useState(false);
  const arm = () => setIntent(true);
  return (
    <Link href={href} prefetch={intent ? true : false} onMouseEnter={arm} onFocus={arm} onTouchStart={arm} {...rest}>
      {children}
    </Link>
  );
}
