import type { ReactNode } from "react";

export type BoardIconName = "check" | "accept" | "snooze" | "edit" | "source" | "dismiss" | "not-action" | "restore";

const PATHS: Record<BoardIconName, ReactNode> = {
  check: <path d="M3.5 8.5 6.8 11.8 12.5 4.8" />,
  accept: <path d="M3.5 8.5 6.8 11.8 12.5 4.8" />,
  snooze: (
    <>
      <circle cx="8" cy="8.5" r="5" />
      <path d="M8 6v2.7l1.8 1.1" />
    </>
  ),
  edit: <path d="m10.6 3.4 2 2L6 12l-2.8.8L4 10zM9.4 4.6l2 2" />,
  source: <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7.5 8.5" />,
  dismiss: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M5.6 8h4.8" />
    </>
  ),
  "not-action": <path d="m4.5 4.5 7 7m0-7-7 7" />,
  restore: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3.2v2.6h2.6" />,
};

/** Small stroke icons. The buttons that hold them carry the accessible names. */
export function BoardIcon({ name }: { name: BoardIconName }) {
  return (
    <svg
      className="board-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
