import type { OcrLine } from "./api";

/**
 * Group recognised lines back into paragraphs.
 *
 * Vision returns one observation per visual line and nothing about how they belonged together,
 * so joining them with `\n` turns an article into a wall of text where every line break looks
 * the same as every paragraph break. Reading that back is the difference between text you can
 * skim and text you have to re-parse by eye.
 *
 * What separates a paragraph from a wrapped line is vertical distance: consecutive lines of one
 * paragraph sit a leading apart, and a paragraph break adds most of a blank line on top. So the
 * gaps are measured against the *median* line height rather than a fixed number of pixels —
 * the region might be a 10pt footnote or a 40pt heading, and only the ratio holds across both.
 */

/** A gap wider than this many line-heights reads as a new paragraph rather than a wrap. */
const PARAGRAPH_GAP = 0.75;

/** Mirrors `LOW_CONFIDENCE` in `src-tauri/src/ocr.rs`, which is the authority — the count in
 *  `OcrResult.lowConfidence` is computed there against this same number, and a copy that drifts
 *  would mark a different set of lines than the one the toast is counting. */
const LOW_CONFIDENCE = 0.5;

export interface Paragraph {
  text: string;
  /** True if any line in it came back with low confidence — worth marking in the UI. */
  uncertain: boolean;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function toParagraphs(lines: OcrLine[]): Paragraph[] {
  if (lines.length === 0) return [];

  // Vision's origin is bottom-left, so a *larger* y is higher on the page. Sorting descending
  // puts them in reading order; the order results arrive in is not guaranteed to be.
  const ordered = [...lines].sort((a, b) => b.y - a.y);
  const typical = median(ordered.map((l) => l.height)) || 0.02;

  const out: Paragraph[] = [];
  let current: OcrLine[] = [];

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      text: current.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
      uncertain: current.some((l) => l.confidence < LOW_CONFIDENCE),
    });
    current = [];
  };

  for (const line of ordered) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      // Distance from the bottom of the previous line to the top of this one.
      const gap = prev.y - (line.y + line.height);
      if (gap > typical * PARAGRAPH_GAP) flush();
    }
    current.push(line);
  }
  flush();
  return out;
}

/** The paragraphs as one string, with a blank line between them — what goes on the clipboard. */
export function paragraphText(paras: Paragraph[]): string {
  return paras.map((p) => p.text).join("\n\n");
}
