"use client";

import { useEffect, useRef, useState } from "react";

// "226 100% 58%" → "#2B5BFF"
function hslToHex(value: string): string | null {
  const match = value
    .trim()
    .match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!match) return null;
  const h = Number(match[1]);
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

// The token's value as the browser resolves it where this is rendered, so
// the page can never disagree with globals.css.
export function TokenValue({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const raw = getComputedStyle(element).getPropertyValue(`--${name}`);
    // Reading the DOM is the point here; there is no render-time source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(hslToHex(raw) ?? raw.trim());
  }, [name]);

  return (
    <span ref={ref} className="tabular-nums">
      {value ?? "…"}
    </span>
  );
}
