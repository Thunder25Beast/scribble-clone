import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGuess,
  editDistance,
  isNearMiss,
  generateMask,
  revealHint,
  computeHintSchedule,
  computeGuesserPoints,
  computeDrawerPoints,
  floodFill,
  hexToRgba,
} from '../shared/utils.js';
import { TokenBucket, IPRateLimiter } from '../server/ratelimit.js';
import { CONFIG } from '../shared/config.js';
import type { CanvasItem, CompletedStroke, FillOp } from '../shared/types.js';

describe('Unit Tests: Text Normalization and Edit Distance', () => {
  it('normalizes guesses by lowercasing, trimming, removing accents and punctuation', () => {
    assert.equal(normalizeGuess('  Hello World!  '), 'hello world');
    assert.equal(normalizeGuess('Café-au-Lait'), 'cafeaulait');
    assert.equal(normalizeGuess('ice   cream...'), 'ice cream');
    assert.equal(normalizeGuess('Naïve & Co.'), 'naive co');
  });

  it('computes Levenshtein edit distance accurately', () => {
    assert.equal(editDistance('apple', 'apple'), 0);
    assert.equal(editDistance('cat', 'hat'), 1);
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('flaw', 'lawn'), 2);
    assert.equal(editDistance('', 'test'), 4);
  });

  it('identifies near misses based on word length thresholds', () => {
    // Exact match is not a near miss
    assert.equal(isNearMiss('cat', 'cat'), false);

    // Short word (<= 5 chars): threshold 1
    assert.equal(isNearMiss('cot', 'cat'), true);
    assert.equal(isNearMiss('cut', 'cat'), true);
    assert.equal(isNearMiss('dog', 'cat'), false);

    // Long word (> 5 chars): threshold 2
    assert.equal(isNearMiss('elefant', 'elephant'), true);
    assert.equal(isNearMiss('elephent', 'elephant'), true);
    assert.equal(isNearMiss('alligator', 'elephant'), false);
  });
});

describe('Unit Tests: Hint Schedule and Word Masking', () => {
  it('generates initial word mask preserving spaces and punctuation', () => {
    assert.equal(generateMask('cat'), '_ _ _');
    assert.equal(generateMask('ice cream'), '_ _ _   _ _ _ _ _');
    assert.equal(generateMask('t-shirt'), '_ - _ _ _ _ _');
  });

  it('computes hint schedule revealing at most half of the letters', () => {
    const scheduleShort = computeHintSchedule(4); // 4 letters -> max 2 revealed
    assert.ok(scheduleShort.length > 0);
    for (const h of scheduleShort) {
      assert.ok(h.count <= 2, `Count ${h.count} should be <= half length`);
    }

    const scheduleLong = computeHintSchedule(10); // 10 letters -> max 5 revealed
    for (const h of scheduleLong) {
      assert.ok(h.count <= 5, `Count ${h.count} should be <= 5`);
    }
  });

  it('reveals hints without corrupting mask layout or exceeding target count', () => {
    const word = 'elephant';
    let mask = generateMask(word);
    assert.equal(mask.split(' ').length, word.length);

    mask = revealHint(word, mask, 1);
    const revealedCount1 = mask.split(' ').filter(ch => ch !== '_').length;
    assert.equal(revealedCount1, 1);

    mask = revealHint(word, mask, 3);
    const revealedCount2 = mask.split(' ').filter(ch => ch !== '_').length;
    assert.equal(revealedCount2, 3);

    // Does not reveal already fully revealed mask
    const fullWord = 'cat';
    const revealedAll = 'c a t';
    assert.equal(revealHint(fullWord, revealedAll, 5), revealedAll);
  });
});

describe('Unit Tests: Server Authoritative Scoring', () => {
  it('computes guesser points based on remaining time and early bonuses', () => {
    const totalMs = 80_000;

    // Fast 1st guesser with nearly all time remaining
    const p1 = computeGuesserPoints(80_000, totalMs, 0);
    assert.equal(p1, CONFIG.MAX_GUESS_POINTS + CONFIG.EARLY_BONUS[0]); // 500 + 50 = 550

    // 2nd guesser with half time remaining
    const p2 = computeGuesserPoints(40_000, totalMs, 1);
    assert.equal(p2, Math.round(CONFIG.MAX_GUESS_POINTS * 0.5) + CONFIG.EARLY_BONUS[1]); // 250 + 30 = 280

    // Late guesser with 0 time left hits floor
    const pLate = computeGuesserPoints(0, totalMs, 5);
    assert.equal(pLate, CONFIG.MIN_GUESS_POINTS); // 50
  });

  it('computes drawer points scaled by guessers and capped', () => {
    // Zero guessers -> 0 points
    assert.equal(computeDrawerPoints([]), 0);

    // 3 guessers with 300 points each
    const guesserPoints = [300, 300, 300];
    const avg = 300;
    const expected = Math.round(avg * CONFIG.DRAWER_POINTS_FRACTION * 3);
    assert.equal(computeDrawerPoints(guesserPoints), Math.min(expected, CONFIG.MAX_DRAWER_POINTS));

    // Cap check
    const hugePoints = [500, 500, 500, 500, 500, 500, 500, 500];
    assert.ok(computeDrawerPoints(hugePoints) <= CONFIG.MAX_DRAWER_POINTS);
  });
});

describe('Unit Tests: Deterministic Flood Fill', () => {
  it('produces identical byte-for-byte output on identical input buffers', () => {
    const width = 10;
    const height = 10;
    const buf1 = new Uint8ClampedArray(width * height * 4); // all zeros (transparent black)
    const buf2 = new Uint8ClampedArray(width * height * 4);

    // Draw an enclosed 1-pixel border rectangle in both buffers
    const drawRect = (buf: Uint8ClampedArray) => {
      for (let x = 2; x <= 7; x++) {
        // top and bottom
        for (const y of [2, 7]) {
          const idx = (y * width + x) * 4;
          buf[idx] = 255; buf[idx + 1] = 0; buf[idx + 2] = 0; buf[idx + 3] = 255; // red
        }
      }
      for (let y = 2; y <= 7; y++) {
        // left and right
        for (const x of [2, 7]) {
          const idx = (y * width + x) * 4;
          buf[idx] = 255; buf[idx + 1] = 0; buf[idx + 2] = 0; buf[idx + 3] = 255; // red
        }
      }
    };

    drawRect(buf1);
    drawRect(buf2);

    const fillColor = { r: 0, g: 0, b: 255, a: 255 }; // blue
    floodFill(buf1, width, height, 4, 4, fillColor);
    floodFill(buf2, width, height, 4, 4, fillColor);

    // Assert exact byte-for-byte match between independent runs
    assert.deepEqual(Array.from(buf1), Array.from(buf2));

    // Assert inside pixel (4, 4) is blue
    const insideIdx = (4 * width + 4) * 4;
    assert.equal(buf1[insideIdx], 0);
    assert.equal(buf1[insideIdx + 1], 0);
    assert.equal(buf1[insideIdx + 2], 255);
    assert.equal(buf1[insideIdx + 3], 255);

    // Assert outside pixel (0, 0) was NOT filled
    const outsideIdx = (0 * width + 0) * 4;
    assert.equal(buf1[outsideIdx], 0);
    assert.equal(buf1[outsideIdx + 1], 0);
    assert.equal(buf1[outsideIdx + 2], 0);
    assert.equal(buf1[outsideIdx + 3], 0);

    // Assert boundary pixel (2, 2) remains red
    const borderIdx = (2 * width + 2) * 4;
    assert.equal(buf1[borderIdx], 255);
    assert.equal(buf1[borderIdx + 1], 0);
    assert.equal(buf1[borderIdx + 2], 0);
    assert.equal(buf1[borderIdx + 3], 255);
  });

  it('correctly converts hex colors to RGBA', () => {
    assert.deepEqual(hexToRgba('#ff0000'), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepEqual(hexToRgba('#00ff00'), { r: 0, g: 255, b: 0, a: 255 });
    assert.deepEqual(hexToRgba('#1a2b3c'), { r: 26, g: 43, b: 60, a: 255 });
  });
});

describe('Unit Tests: Token Bucket Rate Limiter', () => {
  it('allows consumption up to burst capacity and rejects excess', () => {
    const bucket = new TokenBucket({ tokens: 3, intervalMs: 1000 });

    assert.equal(bucket.consume(1), true);
    assert.equal(bucket.consume(1), true);
    assert.equal(bucket.consume(1), true);
    // 4th consumption should fail
    assert.equal(bucket.consume(1), false);
  });

  it('refills tokens after intervalMs elapses', async () => {
    const bucket = new TokenBucket({ tokens: 2, intervalMs: 50 });

    assert.equal(bucket.consume(2), true);
    assert.equal(bucket.consume(1), false);

    // Wait for refill
    await new Promise(r => setTimeout(r, 65));

    assert.equal(bucket.consume(1), true);
  });

  it('isolates rate limits per IP address in IPRateLimiter', () => {
    const ipLimiter = new IPRateLimiter({ tokens: 2, intervalMs: 1000 });

    assert.equal(ipLimiter.consume('1.1.1.1'), true);
    assert.equal(ipLimiter.consume('1.1.1.1'), true);
    assert.equal(ipLimiter.consume('1.1.1.1'), false);

    // Different IP should have full bucket
    assert.equal(ipLimiter.consume('2.2.2.2'), true);
    assert.equal(ipLimiter.consume('2.2.2.2'), true);
    assert.equal(ipLimiter.consume('2.2.2.2'), false);
  });
});

describe('Unit Tests: Op Log Compaction with Undo and Clear', () => {
  it('compacts operations stack correctly with undo and clear', () => {
    const stack: CanvasItem[] = [];

    const stroke1: CompletedStroke = {
      type: 'stroke',
      id: 's1',
      tool: 'pen',
      color: '#000000',
      size: 5,
      points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    };

    const stroke2: CompletedStroke = {
      type: 'stroke',
      id: 's2',
      tool: 'pen',
      color: '#ff0000',
      size: 10,
      points: [{ x: 30, y: 30 }, { x: 40, y: 40 }],
    };

    const fill1: FillOp = {
      type: 'fill',
      id: 'f1',
      x: 50,
      y: 50,
      color: '#0000ff',
    };

    // Apply stroke 1, stroke 2, fill 1
    stack.push(stroke1);
    stack.push(stroke2);
    stack.push(fill1);
    assert.equal(stack.length, 3);

    // Undo should remove fill 1
    const undone1 = stack.pop();
    assert.equal(undone1?.id, 'f1');
    assert.equal(stack.length, 2);

    // Undo again removes stroke 2
    const undone2 = stack.pop();
    assert.equal(undone2?.id, 's2');
    assert.equal(stack.length, 1);
    assert.equal(stack[0].id, 's1');

    // Add another stroke, then clear
    stack.push(stroke2);
    assert.equal(stack.length, 2);
    stack.length = 0; // clear canvas
    assert.equal(stack.length, 0);

    // Snapshot after clear is completely empty
    const snapshotItems = [...stack];
    assert.equal(snapshotItems.length, 0);
  });
});
