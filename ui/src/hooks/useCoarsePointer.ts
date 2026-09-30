import { useEffect, useState } from "react";
import { isCoarsePointer } from "@kw/lib/viewportKeyboard";

/** Whether the primary pointer is coarse (touch) rather than fine (mouse/trackpad). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window === "undefined" ? false : isCoarsePointer(window),
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
