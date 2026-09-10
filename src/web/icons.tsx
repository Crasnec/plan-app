export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    plus: "M12 5v14M5 12h14",
    check: "m5 12 4 4L19 6",
    left: "m14 6-6 6 6 6",
    right: "m10 6 6 6-6 6",
    close: "m6 6 12 12M18 6 6 18",
    calendar: "M5 5h14v15H5zM8 3v4m8-4v4M5 10h14",
    leaf: "M19 4C8 2 2 9 7 16s15-2 12-12ZM7 17l8-9",
    link: "m10 13 4-4M8 15l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 1 1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0",
    bell: "M6 16h12l-2-3V9a4 4 0 0 0-8 0v4l-2 3Zm4 3h4",
    trash: "M4 6h16M9 3h6M6 6l1 14h10l1-14M10 10v6m4-6v6",
    clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    repeat: "M4 8h13l-3-3m6 11H7l3 3M4 8v5m16 3v-5",
    lock: "M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3",
    logout: "M10 5H5v14h5m3-14 7 7-7 7m-4-7h11",
    list: "M8 6h12M8 12h12M8 18h12M3 6h1m-1 6h1m-1 6h1",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.calendar} />
    </svg>
  );
}
