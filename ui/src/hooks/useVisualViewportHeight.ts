import { useEffect, useState } from "react";
import { getVisualViewportHeight } from "@kw/lib/viewportKeyboard";

/**
 * Tracks `window.visualViewport.height`, which shrinks when an on-screen
 * keyboard opens (unlike `window.innerHeight`, which doesn't). Falls back
 * to `innerHeight` on browsers without `visualViewport` support and during
 * SSR.
 */
export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState(() =>
    typeof window === "undefined" ? 0 : getVisualViewportHeight(window),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setHeight(getVisualViewportHeight(window));
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return height;
}
