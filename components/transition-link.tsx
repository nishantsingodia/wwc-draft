"use client";

import { useRouter } from "next/navigation";
import { useCallback, type ReactNode, type MouseEvent } from "react";

/**
 * Link that plays the "slide choreography" before navigating: the current
 * screen lifts up and dims (.vt-lift), then we navigate. The destination
 * (e.g. the draft board) rises from below on mount via .vt-rise.
 *
 * Falls back to an instant push when reduced-motion is on or for
 * modifier/middle clicks (so open-in-new-tab still works).
 */
export default function TransitionLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const router = useRouter();

  const onClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();

      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        router.push(href);
        return;
      }

      const main = document.querySelector("main");
      if (main) main.classList.add("vt-lift");
      window.setTimeout(() => router.push(href), 230);
    },
    [href, router]
  );

  return (
    <a href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
