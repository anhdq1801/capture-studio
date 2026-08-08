/**
 * Compose a screenshot onto a styled backdrop — padding, background, rounded corners and a
 * drop shadow — for pasting into slides, docs and social posts.
 *
 * Deliberately *adding* a background rather than removing one: a screenshot has no
 * subject/background separation to cut out, but a raw screenshot dropped into a slide looks
 * unfinished, and this is the step that fixes that. Pure canvas 2D, so it stays offline and
 * adds no dependency or bundle weight.
 */

export interface Background {
  id: string;
  label: string;
  /** CSS colors; one entry = solid fill, several = linear gradient. */
  colors: string[];
  /** Gradient direction in degrees, 0 = top-to-bottom, 90 = left-to-right. */
  angle?: number;
}

export const BACKGROUNDS: Background[] = [
  { id: "none", label: "None", colors: [] },
  { id: "white", label: "White", colors: ["#ffffff"] },
  { id: "slate", label: "Slate", colors: ["#1e2230"] },
  { id: "violet", label: "Violet", colors: ["#6d5efc", "#b16cff"], angle: 135 },
  { id: "sunset", label: "Sunset", colors: ["#ff8a3d", "#ff3b6b"], angle: 135 },
  { id: "ocean", label: "Ocean", colors: ["#2bb8ff", "#1160e0"], angle: 135 },
  { id: "mint", label: "Mint", colors: ["#3ddc97", "#0e9f6e"], angle: 135 },
  { id: "dusk", label: "Dusk", colors: ["#3b2f63", "#141726"], angle: 160 },
];

export type AspectId = "auto" | "16:9" | "4:3" | "1:1" | "4:5";

export const ASPECTS: { id: AspectId; label: string; ratio: number | null }[] = [
  { id: "auto", label: "Auto", ratio: null },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
];

export interface BeautifyOptions {
  background: Background;
  /** Padding as a fraction of the image's shorter side. */
  padding: number;
  /** Corner radius in source pixels. */
  radius: number;
  shadow: boolean;
  aspect: AspectId;
}

export const DEFAULTS: BeautifyOptions = {
  background: BACKGROUNDS[3],
  padding: 0.08,
  radius: 12,
  shadow: true,
  aspect: "auto",
};

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function paintBackground(
  ctx: CanvasRenderingContext2D,
  bg: Background,
  w: number,
  h: number
) {
  if (bg.colors.length === 0) return; // transparent
  if (bg.colors.length === 1) {
    ctx.fillStyle = bg.colors[0];
  } else {
    // Angle measured clockwise from "downward", matching how CSS gradients read.
    const rad = ((bg.angle ?? 135) * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    const len = (Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))) / 2;
    const dx = Math.sin(rad) * len;
    const dy = -Math.cos(rad) * len;
    const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    bg.colors.forEach((c, i) => g.addColorStop(i / (bg.colors.length - 1), c));
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, w, h);
}

/**
 * Render at full source resolution into `canvas`. The preview shows the same canvas scaled
 * down by CSS, so what the user sees is exactly what gets exported.
 */
export function renderBeautified(
  canvas: HTMLCanvasElement,
  img: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  opts: BeautifyOptions
): void {
  const iw = img.width;
  const ih = img.height;
  const pad = Math.round(Math.min(iw, ih) * opts.padding);

  let cw = iw + pad * 2;
  let ch = ih + pad * 2;

  // A fixed aspect grows the canvas on one axis only, so the image never gets cropped.
  const ratio = ASPECTS.find((a) => a.id === opts.aspect)?.ratio ?? null;
  if (ratio) {
    if (cw / ch < ratio) cw = Math.round(ch * ratio);
    else ch = Math.round(cw / ratio);
  }

  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, cw, ch);
  paintBackground(ctx, opts.background, cw, ch);

  const x = Math.round((cw - iw) / 2);
  const y = Math.round((ch - ih) / 2);

  ctx.save();
  if (opts.shadow) {
    // Scaled to the image so a 4K capture doesn't get a hairline shadow.
    const s = Math.min(iw, ih);
    ctx.shadowColor = "rgba(0,0,0,0.42)";
    ctx.shadowBlur = Math.round(s * 0.045);
    ctx.shadowOffsetY = Math.round(s * 0.018);
  }
  // Fill the rounded shape first so the shadow is cast by the silhouette, not by the
  // image's own pixels — drawing the image with a shadow set gives a muddy double edge.
  ctx.fillStyle = "#000";
  roundedRect(ctx, x, y, iw, ih, opts.radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRect(ctx, x, y, iw, ih, opts.radius);
  ctx.clip();
  ctx.drawImage(img, x, y, iw, ih);
  ctx.restore();
}
