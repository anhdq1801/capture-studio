import { ReactElement } from "react";

export type IconName =
  | "cursor"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "pen"
  | "marker"
  | "text"
  | "counter"
  | "blur"
  | "undo"
  | "trash"
  | "eraser"
  | "copy"
  | "save"
  | "cloud"
  | "close";

const P: Record<IconName, ReactElement> = {
  cursor: <path d="M5 3l6 15 2-6 6-2z" />,
  arrow: (
    <>
      <path d="M5 19L19 5" />
      <path d="M11 5h8v8" />
    </>
  ),
  line: <path d="M5 19L19 5" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="6" />,
  pen: (
    <>
      <path d="M4 20l4-1L19 8a2 2 0 0 0-3-3L5 16z" />
      <path d="M14 6l3 3" />
    </>
  ),
  marker: (
    <>
      <path d="M4 19h16" />
      <path d="M7 16l8-8 3 3-8 8H7z" />
    </>
  ),
  text: (
    <>
      <path d="M6 6h12" />
      <path d="M12 6v12" />
    </>
  ),
  counter: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M11 9l1.5-1v7" />
    </>
  ),
  blur: (
    <>
      <rect x="4" y="4" width="4" height="4" />
      <rect x="12" y="4" width="4" height="4" />
      <rect x="8" y="8" width="4" height="4" />
      <rect x="16" y="8" width="4" height="4" />
      <rect x="4" y="12" width="4" height="4" />
      <rect x="12" y="12" width="4" height="4" />
      <rect x="8" y="16" width="4" height="4" />
      <rect x="16" y="16" width="4" height="4" />
    </>
  ),
  undo: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
    </>
  ),
  eraser: (
    <>
      <path d="M4 20h9" />
      <path d="M15.5 4.5l4 4-8 8-4-4z" />
      <path d="M7.5 12.5l4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  save: (
    <>
      <path d="M12 4v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  cloud: (
    <>
      <path d="M7 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 16.2 8.06 4.5 4.5 0 0 1 16.5 17H7z" />
      <path d="M12 20v-6" />
      <path d="M9.5 16.5L12 14l2.5 2.5" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
};

export function EditIcon({ name }: { name: IconName }) {
  const filled = name === "cursor";
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {P[name]}
    </svg>
  );
}
