import { useMemo } from "react";
import { Ecc, qrMatrix, qrPath } from "../lib/qr";

/**
 * A QR code as inline SVG.
 *
 * It is drawn on its own white plate rather than inheriting the panel's dark background:
 * phone cameras expect dark modules on light, and an inverted code is a coin flip on older
 * ones. The quiet zone matters as much as the modules do, so four modules of margin are part
 * of the viewBox and cannot be styled away.
 *
 * Size is a scanning decision, not only a layout one. A ~50-character URL needs roughly
 * 4 device pixels per module to survive being photographed off a screen; below about 180px
 * for a link that length, a non-Retina display stops decoding. Shorten the value before
 * shrinking the code.
 */
export function QrCode({
  value,
  size = 128,
  ecc = "M",
  title,
}: {
  value: string;
  size?: number;
  /** Higher levels survive more damage but grow the code; "M" is the usual choice for a URL. */
  ecc?: Ecc;
  title?: string;
}) {
  // Encoding is pure and the value never changes in practice, so it runs once per mount.
  const qr = useMemo(() => {
    try {
      const matrix = qrMatrix(value, ecc);
      return { count: matrix.length, path: qrPath(matrix) };
    } catch {
      return null;
    }
  }, [value, ecc]);

  if (!qr) return null;
  const quiet = 4;
  const span = qr.count + quiet * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? value}
      style={{ borderRadius: 8, display: "block" }}
    >
      <title>{title ?? value}</title>
      <rect width={span} height={span} fill="#ffffff" />
      <g transform={`translate(${quiet} ${quiet})`}>
        <path d={qr.path} fill="#000000" />
      </g>
    </svg>
  );
}
