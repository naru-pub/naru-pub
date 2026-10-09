import { useId } from "react";

// The water at the ferry landing (나루): a strip of pixel waves between big
// sections. One per page at most.
export function PixelWave({ className }: { className?: string }) {
  const id = useId();
  // Column heights of one 24px wave, in 3px pixels.
  const heights = [2, 3, 4, 4, 3, 2, 1, 1];
  return (
    <svg
      aria-hidden="true"
      width="100%"
      height="12"
      className={`block text-primary ${className ?? ""}`}
    >
      <defs>
        <pattern id={id} width="24" height="12" patternUnits="userSpaceOnUse">
          {heights.map((h, i) => (
            <rect
              key={i}
              x={i * 3}
              y={12 - h * 3}
              width="3"
              height={h * 3}
              fill="currentColor"
            />
          ))}
        </pattern>
      </defs>
      <rect width="100%" height="12" fill={`url(#${id})`} />
    </svg>
  );
}
