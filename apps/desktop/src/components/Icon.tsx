const paths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  server: 'M4 3h16v7H4z M4 14h16v7H4z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  services:
    'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M5.6 5.6l2.8 2.8 M15.6 15.6l2.8 2.8 M5.6 18.4l2.8-2.8 M15.6 8.4l2.8-2.8 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  containers: 'M12 3l9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7.5 5.5l9 5',
  network: 'M9 3h6v6H9z M2 16h6v6H2z M16 16h6v6h-6z M12 9v4 M5 16v-3h14v3',
  security: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6',
  logs: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',
  files: 'M3 6V4h7l2 3h9v13H3z',
  terminal: 'M3 4h18v16H3z M6 9l3 3-3 3 M12 15h5',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M19 11a7 7 0 0 0-12-5L4 9 M5 13a7 7 0 0 0 12 5l3-3',
  key: 'M14 10a5 5 0 1 1-4-5 M10 10l11 11 M16 16l3-3 M19 19l3-3',
  shield: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M12 8v5 M12 17h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.8-3.8',
  command:
    'M7 4a3 3 0 0 0-3 3c0 1.7 1.3 3 3 3h10a3 3 0 1 0-3-3v10a3 3 0 1 0 3-3H7a3 3 0 1 0 3 3V7a3 3 0 0 0-3-3z',
  collapse: 'M4 4h16v16H4z M9 4v16 M16 9l-3 3 3 3',
  expand: 'M4 4h16v16H4z M9 4v16 M13 9l3 3-3 3',
  maximize: 'M8 3H4v4 M16 3h4v4 M4 16v4h4 M20 16v4h-4',
  minimize: 'M4 8h4V4 M20 8h-4V4 M4 16h4v4 M20 16h-4v4',
  close: 'M6 6l12 12 M18 6l-12 12',
  cpu: 'M7 7h10v10H7z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  memory: 'M3 8h18v8H3z M7 16v3 M12 16v3 M17 16v3 M7 11h2 M12 11h2 M17 11h2',
  disk: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M7 15h.01 M10 15h7 M12 9a2 2 0 1 0 0 .01',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
