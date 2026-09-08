import type { ReactNode, SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base(size: number | undefined, children: ReactNode, props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    p,
  );
}

export function UserIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5" />
    </>,
    p,
  );
}

export function ThinkIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <ellipse cx="12" cy="12" rx="11.2" ry="4.4" transform="rotate(45 12 12)" />
      <ellipse cx="12" cy="12" rx="11.2" ry="4.4" transform="rotate(-45 12 12)" />
      <circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none" />
    </>,
    { ...p, strokeWidth: 1.7 },
  );
}

export function WrenchIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <path d="M14.7 6.3a4.5 4.5 0 0 0 6 6l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4a4.5 4.5 0 0 0-6-6l3.2 3.2-2.3 2.3-3.2-3.2a4.5 4.5 0 0 0 6 6" />,
    p,
  );
}

export function CheckIcon({ size, ...p }: IconProps) {
  return base(size, <path d="M20 6L9 17l-5-5" />, p);
}

export function ChevronDownIcon({ size, ...p }: IconProps) {
  return base(size, <path d="M6 9l6 6 6-6" />, p);
}

export function SunIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
    p,
  );
}

export function MoonIcon({ size, ...p }: IconProps) {
  return base(size, <path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5z" />, p);
}

export function MonitorIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>,
    p,
  );
}

export function ChevronRightIcon({ size, ...p }: IconProps) {
  return base(size, <path d="M9 6l6 6-6 6" />, p);
}

export function ArrowUpIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>,
    p,
  );
}

export function PencilIcon({ size, ...p }: IconProps) {
  return base(size, <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />, p);
}

export function SlidersIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M21 4h-7" />
      <path d="M10 4H3" />
      <path d="M21 12h-9" />
      <path d="M8 12H3" />
      <path d="M21 20h-5" />
      <path d="M12 20H3" />
      <path d="M14 2v4" />
      <path d="M8 10v4" />
      <path d="M16 18v4" />
    </>,
    p,
  );
}

export function FileIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>,
    p,
  );
}

export function ChartIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M12 20V10" />
      <path d="M18 20V4" />
      <path d="M6 20v-4" />
    </>,
    p,
  );
}

export function DatabaseIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </>,
    p,
  );
}

export function TerminalIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </>,
    p,
  );
}

export function ScissorsIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88" />
      <path d="M14.47 14.48L20 20" />
      <path d="M8.12 8.12L12 12" />
    </>,
    p,
  );
}

export function AlertIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>,
    p,
  );
}

// ===== Missing icons added for product UI =====

export function StopIcon({ size, ...p }: IconProps) {
  return base(size, <rect x="6" y="6" width="12" height="12" rx="2" />, p);
}

// SettingsIcon 别名（对应 gear）
export function SettingsIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    p,
  );
}

export function SearchIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>,
    p,
  );
}

export function FolderIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    </>,
    p,
  );
}

export function TrashIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>,
    p,
  );
}

export function ArchiveIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <path d="M2 7h20" />
      <path d="M12 3v18" />
    </>,
    p,
  );
}

export function PanelLeftIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </>,
    p,
  );
}

export function MoreIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>,
    p,
  );
}

export function CopyIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    p,
  );
}

// Simple list icon used for "运行摘要" shell-bar button.
export function ListIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </>,
    p,
  );
}

export function CloseIcon({ size, ...p }: IconProps) {
  return base(
    size,
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    p,
  );
}
