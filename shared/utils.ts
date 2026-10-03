// Shared utility functions used by both server and client.
// Server uses these for authoritative logic; client uses flood fill for rendering.

import { CONFIG } from './config.js';

// ── String normalization for guess comparison ──
// Lowercase, trim, collapse spaces, strip accents and punctuation
export function normalizeGuess(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, '')     // strip punctuation
    .replace(/\s+/g, ' ');           // collapse spaces
}

// ── Edit distance (Levenshtein) ──
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use single array optimization
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = prevDiag;
      } else {
        prev[j] = 1 + Math.min(prevDiag, prev[j - 1], prev[j]);
      }
      prevDiag = temp;
    }
  }
  return prev[n];
}

// ── Near miss check ──
export function isNearMiss(guess: string, word: string): boolean {
  const normGuess = normalizeGuess(guess);
  const normWord = normalizeGuess(word);
  if (normGuess === normWord) return false; // exact match, not a near miss
  const threshold = normWord.length <= CONFIG.NEAR_MISS_WORD_LENGTH_BOUNDARY
    ? CONFIG.NEAR_MISS_SHORT_THRESHOLD
    : CONFIG.NEAR_MISS_LONG_THRESHOLD;
  return editDistance(normGuess, normWord) <= threshold;
}

// ── Word mask generation ──
// Shows underscores for letters, keeps spaces and punctuation visible
export function generateMask(word: string): string {
  return word
    .split('')
    .map(ch => {
      if (/[a-zA-Z0-9]/.test(ch)) return '_';
      return ch; // space, punctuation, etc
    })
    .join(' '); // space between each char position for readability
}

// ── Hint: reveal some letters in a mask ──
// revealCount: how many letters to reveal total (cumulative)
// Returns updated mask string
export function revealHint(word: string, currentMask: string, revealCount: number): string {
  // Parse current mask to find which positions are still hidden
  const chars = word.split('');
  const maskParts = currentMask.split(' ');
  const hiddenPositions: number[] = [];

  for (let i = 0; i < chars.length; i++) {
    if (maskParts[i] === '_') {
      hiddenPositions.push(i);
    }
  }

  // How many already revealed
  const alreadyRevealed = chars.length - hiddenPositions.length -
    chars.filter(ch => !/[a-zA-Z0-9]/.test(ch)).length;
  const toReveal = Math.max(0, revealCount - alreadyRevealed);

  if (toReveal <= 0 || hiddenPositions.length === 0) return currentMask;

  // Pick random positions to reveal (deterministic with a seed would be better,
  // but server controls this so it is fine)
  const shuffled = [...hiddenPositions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const newMaskParts = [...maskParts];
  for (let k = 0; k < Math.min(toReveal, shuffled.length); k++) {
    newMaskParts[shuffled[k]] = chars[shuffled[k]];
  }

  return newMaskParts.join(' ');
}

// ── Compute hint schedule ──
// Returns array of {fraction, revealCount} where revealCount is cumulative
export function computeHintSchedule(wordLength: number): Array<{ fraction: number; count: number }> {
  const letterCount = wordLength; // approximate; exact count handled by caller
  const maxReveal = Math.floor(letterCount / 2); // never more than ~half
  const hints = CONFIG.HINT_FRACTIONS;
  const result: Array<{ fraction: number; count: number }> = [];
  for (let i = 0; i < hints.length; i++) {
    const count = Math.min(i + 1, maxReveal);
    if (count > 0) {
      result.push({ fraction: hints[i], count });
    }
  }
  return result;
}

// ── Scoring ──
export function computeGuesserPoints(remainingMs: number, totalMs: number, guessOrder: number): number {
  const timeFraction = Math.max(0, remainingMs) / totalMs;
  let points = Math.round(CONFIG.MAX_GUESS_POINTS * timeFraction);
  points = Math.max(points, CONFIG.MIN_GUESS_POINTS);

  // Early bonus
  if (guessOrder < CONFIG.EARLY_BONUS.length) {
    points += CONFIG.EARLY_BONUS[guessOrder];
  }
  return points;
}

export function computeDrawerPoints(guesserPointsList: number[]): number {
  if (guesserPointsList.length === 0) return 0;
  const avg = guesserPointsList.reduce((a, b) => a + b, 0) / guesserPointsList.length;
  const points = Math.round(avg * CONFIG.DRAWER_POINTS_FRACTION * guesserPointsList.length);
  return Math.min(points, CONFIG.MAX_DRAWER_POINTS);
}

// ── Flood fill (scanline) ──
// Deterministic: exact color match (tolerance 0), same result from same op log.
// Works on an ImageData-like buffer: Uint8ClampedArray with RGBA, width, height.
export function floodFill(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  fillColor: { r: number; g: number; b: number; a: number }
): void {
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;

  const idx = (sy * width + sx) * 4;
  const targetR = imageData[idx];
  const targetG = imageData[idx + 1];
  const targetB = imageData[idx + 2];
  const targetA = imageData[idx + 3];

  // If target color is same as fill color, nothing to do
  if (
    targetR === fillColor.r &&
    targetG === fillColor.g &&
    targetB === fillColor.b &&
    targetA === fillColor.a
  ) return;

  const matchesTarget = (i: number): boolean =>
    imageData[i] === targetR &&
    imageData[i + 1] === targetG &&
    imageData[i + 2] === targetB &&
    imageData[i + 3] === targetA;

  const setPixel = (i: number): void => {
    imageData[i] = fillColor.r;
    imageData[i + 1] = fillColor.g;
    imageData[i + 2] = fillColor.b;
    imageData[i + 3] = fillColor.a;
  };

  // Scanline flood fill
  const stack: Array<[number, number]> = [[sx, sy]];
  while (stack.length > 0) {
    let [x, y] = stack.pop()!;
    let lx = x;

    // Move left to find the start of the scanline
    while (lx > 0 && matchesTarget(((y * width) + lx - 1) * 4)) {
      lx--;
    }

    let spanAbove = false;
    let spanBelow = false;

    while (lx < width) {
      const ci = (y * width + lx) * 4;
      if (!matchesTarget(ci)) break;

      setPixel(ci);

      // Check above
      if (y > 0) {
        const ai = ((y - 1) * width + lx) * 4;
        if (matchesTarget(ai)) {
          if (!spanAbove) {
            stack.push([lx, y - 1]);
            spanAbove = true;
          }
        } else {
          spanAbove = false;
        }
      }

      // Check below
      if (y < height - 1) {
        const bi = ((y + 1) * width + lx) * 4;
        if (matchesTarget(bi)) {
          if (!spanBelow) {
            stack.push([lx, y + 1]);
            spanBelow = true;
          }
        } else {
          spanBelow = false;
        }
      }

      lx++;
    }
  }
}

// ── Parse hex color to RGBA ──
export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b, a: 255 };
}
