import type { ReactNode } from "react";

export function OptionalContent({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? children : null;
}
