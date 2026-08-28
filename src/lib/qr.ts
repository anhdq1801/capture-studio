/**
 * A QR encoder, in one file.
 *
 * The app draws exactly one QR code — the donate link in Settings — and pulling a dependency
 * in for that would add a package to the supply chain for the sake of ~200 lines. Byte mode
 * only, which is all a URL needs; every version and error-correction level is supported
 * because the tables cost nothing once they are typed out.
 *
 * Structure follows the reference implementation everyone's does (Nayuki's): pick the
 * smallest version that fits, Reed–Solomon per block, interleave, draw, then try all eight
 * masks and keep the one the penalty rules like best.
 */

export type Ecc = "L" | "M" | "Q" | "H";

/** Index into the tables below, and the two bits that go into the format information. */
const ECC_ORDER: Ecc[] = ["L", "M", "Q", "H"];
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Both tables are indexed [eccLevel][version]; slot 0 is padding so `version` indexes directly.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ECC_BLOCKS: number[][] = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Total modules a version has available for data + ECC, before the format areas take theirs. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecc: Ecc): number {
  const e = ECC_ORDER.indexOf(ecc);
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ECC_BLOCKS[e][version]
  );
}

// ---- GF(256) arithmetic, for Reed–Solomon -------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// ---- Encoding -----------------------------------------------------------------------------

/** Data codewords: mode, length, payload, terminator, then the alternating pad bytes. */
function encodeBytes(bytes: Uint8Array, version: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }
  return words;
}

/** Split into blocks, append each block's ECC, then interleave the lot. */
function addEcc(data: number[], version: number, ecc: Ecc): number[] {
  const e = ECC_ORDER.indexOf(ecc);
  const numBlocks = NUM_ECC_BLOCKS[e][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const parity = rsRemainder(dat, divisor);
    // Short blocks get a placeholder so every block is the same length while interleaving;
    // the loop below skips it.
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(parity));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) result.push(blocks[j][i]);
    }
  }
  return result;
}

// ---- Drawing ------------------------------------------------------------------------------

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const num = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < num; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The four penalty rules from the spec; the mask with the lowest total wins. */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;

  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  };
  for (let i = 0; i < size; i++) {
    line((j) => m[i][j]);
    line((j) => m[j][i]);
  }

  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }

  // 1011101 with four light modules on either side, in both directions.
  const FINDER = [true, false, true, true, true, false, true];
  const runsAt = (get: (i: number) => boolean, i: number) =>
    FINDER.every((v, k) => get(i + k) === v) &&
    ([-4, -3, -2, -1].every((d) => i + d < 0 || !get(i + d)) ||
      [7, 8, 9, 10].every((d) => i + d >= size || !get(i + d)));
  for (let i = 0; i < size; i++)
    for (let j = 0; j + 7 <= size; j++) {
      if (runsAt((k) => m[i][k], j)) score += 40;
      if (runsAt((k) => m[k][i], j)) score += 40;
    }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return score;
}

/**
 * Encode `text` and return the module grid, indexed `[y][x]`, `true` meaning a dark module.
 * The quiet zone is not included — whoever draws it adds the margin.
 */
export function qrMatrix(text: string, ecc: Ecc = "M"): boolean[][] {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(v, ecc) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error("Text is too long to fit in a QR code");

  const codewords = addEcc(encodeBytes(bytes, version, ecc), version, ecc);
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Timing patterns, then the three finders, then alignment.
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      // The three corners already hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0))
        continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  /** Writes the 15 format bits into `target`, marking them reserved only on the first pass. */
  const drawFormat = (mask: number, target: boolean[][], reserve: boolean) => {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const put = (x: number, y: number, dark: boolean) => {
      target[y][x] = dark;
      if (reserve) reserved[y][x] = true;
    };
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6));
    put(8, 8, bit(7));
    put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, true); // The dark module, always set.
  };
  drawFormat(0, modules, true); // Reserves the area; rewritten once the mask is chosen.

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Data, snaking upward and downward through pairs of columns, right to left.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!reserved[y][x] && MASKS[mask](x, y)) candidate[y][x] = !candidate[y][x];
    // The format bits change with the mask and count towards the penalty, so they go in
    // before the candidate is scored.
    drawFormat(mask, candidate, false);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best!;
}

/**
 * One SVG path covering every dark module, as `M x y h1 v1 h-1 z` squares. A single path
 * beats one `<rect>` per module: the browser has a few hundred fewer nodes to lay out, and
 * the string is small enough to inline.
 */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++)
    for (let x = 0; x < matrix.length; x++)
      if (matrix[y][x]) parts.push(`M${x} ${y}h1v1h-1z`);
  return parts.join("");
}
