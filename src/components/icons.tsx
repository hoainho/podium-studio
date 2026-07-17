import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(children: ReactNode, { size = 15, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  refresh: (p: IconProps = {}) =>
    base(
      <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </>,
      p,
    ),
  play: (p: IconProps = {}) => base(<path d="M6 4l14 8-14 8V4z" />, p),
  power: (p: IconProps = {}) =>
    base(
      <>
        <path d="M12 2v8" />
        <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
      </>,
      p,
    ),
  rocket: (p: IconProps = {}) =>
    base(
      <>
        <path d="M5 15s-1-5 4-9c4-4 9-4 9-4s0 5-4 9c-4 4-9 4-9 4Z" />
        <path d="M9 15l-4 4" />
        <path d="M14 5c1.5 1.5 3 3.5 3 5.5" />
      </>,
      p,
    ),
  plus: (p: IconProps = {}) =>
    base(
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>,
      p,
    ),
  trash: (p: IconProps = {}) =>
    base(
      <>
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="M6 7l1 13h10l1-13" />
      </>,
      p,
    ),
  copy: (p: IconProps = {}) =>
    base(
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </>,
      p,
    ),
  up: (p: IconProps = {}) => base(<path d="M18 15l-6-6-6 6" />, p),
  down: (p: IconProps = {}) => base(<path d="M6 9l6 6 6-6" />, p),
  eye: (p: IconProps = {}) =>
    base(
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>,
      p,
    ),
  eyeOff: (p: IconProps = {}) =>
    base(
      <>
        <path d="M3 3l18 18" />
        <path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a17.9 17.9 0 0 1-3.4 4.2M6.6 6.6A17.6 17.6 0 0 0 2 12s4 7 10 7c1.3 0 2.5-.2 3.6-.6" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      </>,
      p,
    ),
  save: (p: IconProps = {}) =>
    base(
      <>
        <path d="M5 3h11l3 3v15H5z" />
        <path d="M8 3v6h8V3" />
        <path d="M8 21v-7h8v7" />
      </>,
      p,
    ),
  export: (p: IconProps = {}) =>
    base(
      <>
        <path d="M12 3v12" />
        <path d="M7 8l5-5 5 5" />
        <path d="M5 21h14" />
      </>,
      p,
    ),
  check: (p: IconProps = {}) => base(<path d="M4 12l6 6 10-12" />, p),
  x: (p: IconProps = {}) =>
    base(
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </>,
      p,
    ),
  device: (p: IconProps = {}) =>
    base(
      <>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M11 18h2" />
      </>,
      p,
    ),
  folder: (p: IconProps = {}) =>
    base(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />, p),
  target: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </>,
      p,
    ),
  cursor: (p: IconProps = {}) =>
    base(<path d="M5 3l14 8-6 2-2 6-6-16Z" />, p),
  keyboard: (p: IconProps = {}) =>
    base(
      <>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
      </>,
      p,
    ),
  hand: (p: IconProps = {}) =>
    base(
      <>
        <path d="M8 13V6a1.5 1.5 0 0 1 3 0v6" />
        <path d="M11 12V4a1.5 1.5 0 0 1 3 0v8" />
        <path d="M14 12.5V6a1.5 1.5 0 0 1 3 0v9" />
        <path d="M8 13l-1.5-1.5a1.5 1.5 0 0 0-2.3 1.9L7 18a6 6 0 0 0 6 3h1a6 6 0 0 0 6-6v-2" />
      </>,
      p,
    ),
  clock: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </>,
      p,
    ),
  camera: (p: IconProps = {}) =>
    base(
      <>
        <path d="M4 8h3l2-2h6l2 2h3v11H4Z" />
        <circle cx="12" cy="13.5" r="3.2" />
      </>,
      p,
    ),
  key: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
      </>,
      p,
    ),
  alert: (p: IconProps = {}) =>
    base(
      <>
        <path d="M12 3l10 18H2Z" />
        <path d="M12 10v4M12 17h.01" />
      </>,
      p,
    ),
  info: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8h.01M11 12h1v5h1" />
      </>,
      p,
    ),
  doubleTap: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" opacity="0.5" />
        <path d="M5.6 5.6l2 2M16.4 5.6l-2 2M5.6 18.4l2-2M16.4 18.4l-2-2" />
      </>,
      p,
    ),
  longPress: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22" opacity="0.4" />
        <path d="M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" opacity="0.4" />
      </>,
      p,
    ),
  tapIfVisible: (p: IconProps = {}) =>
    base(
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <path d="M9 12l2 2 4-4.5" />
      </>,
      p,
    ),
  clearText: (p: IconProps = {}) =>
    base(
      <>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M9 10l6 4M15 10l-6 4" />
      </>,
      p,
    ),
  deleteText: (p: IconProps = {}) =>
    base(
      <>
        <path d="M8 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8l-6-8 6-8Z" />
        <path d="M12 10l5 4M17 10l-5 4" />
      </>,
      p,
    ),
  hideKeyboard: (p: IconProps = {}) =>
    base(
      <>
        <rect x="2" y="5" width="20" height="12" rx="2" />
        <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h10" />
        <path d="M9 20l3 2 3-2" />
      </>,
      p,
    ),
  scroll: (p: IconProps = {}) =>
    base(
      <>
        <path d="M8 8l4-4 4 4" />
        <path d="M8 16l4 4 4-4" />
        <path d="M12 5v14" opacity="0.5" />
      </>,
      p,
    ),
  scrollTo: (p: IconProps = {}) =>
    base(
      <>
        <path d="M12 3v11" />
        <path d="M8 10l4 4 4-4" />
        <path d="M4 21h16" />
      </>,
      p,
    ),
  back: (p: IconProps = {}) =>
    base(
      <>
        <path d="M19 12H5" />
        <path d="M11 6l-6 6 6 6" />
      </>,
      p,
    ),
  assertNot: (p: IconProps = {}) =>
    base(
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" opacity="0.5" />
        <path d="M3 3l18 18" />
      </>,
      p,
    ),
  waitGone: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="10" cy="10" r="7" opacity="0.5" />
        <path d="M10 6v4l2.5 2.5" opacity="0.5" />
        <path d="M16 16l6 6M22 16l-6 6" />
      </>,
      p,
    ),
  link: (p: IconProps = {}) =>
    base(
      <>
        <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
        <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
      </>,
      p,
    ),
  stop: (p: IconProps = {}) => base(<rect x="6" y="6" width="12" height="12" rx="1.5" />, p),
  paste: (p: IconProps = {}) =>
    base(
      <>
        <rect x="6" y="4" width="12" height="18" rx="2" />
        <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
        <path d="M9 11h6M9 15h6" />
      </>,
      p,
    ),
  code: (p: IconProps = {}) =>
    base(
      <>
        <path d="M8 7l-5 5 5 5" />
        <path d="M16 7l5 5-5 5" />
      </>,
      p,
    ),
  branch: (p: IconProps = {}) =>
    base(
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M6 8.5V15.5" />
        <path d="M8.2 7l7.6 3.8" />
      </>,
      p,
    ),
  repeatLoop: (p: IconProps = {}) =>
    base(
      <>
        <path d="M4 12a8 8 0 0 1 14-5.3L20 8" />
        <path d="M20 4v4h-4" />
        <path d="M20 12a8 8 0 0 1-14 5.3L4 16" />
        <path d="M4 20v-4h4" />
      </>,
      p,
    ),
  variable: (p: IconProps = {}) =>
    base(
      <>
        <path d="M6 4c-2 3-2 13 0 16" />
        <path d="M18 4c2 3 2 13 0 16" />
        <path d="M9 12h6" opacity="0.5" />
      </>,
      p,
    ),
  wand: (p: IconProps = {}) =>
    base(
      <>
        <path d="M4 20l10-10" />
        <path d="M14 4v3M19 9h-3M19.5 4.5l-2 2" opacity="0.6" />
        <path d="M17 14l1.5 1.5L17 17l-1.5-1.5Z" />
      </>,
      p,
    ),
};
