import { describe, it, expect } from 'vitest';
import { bucketIndex, newHist, addToHist } from './histogram.js';

describe('bucketIndex', () => {
  it('maps a duration to the bucket whose upper bound it falls under', () => {
    expect(bucketIndex(50)).toBe(0);      // [0, 100)
    expect(bucketIndex(99)).toBe(0);      // [0, 100)
    expect(bucketIndex(101)).toBe(1);     // [100, 250)
    expect(bucketIndex(249)).toBe(1);     // [100, 250)
    expect(bucketIndex(250)).toBe(2);     // [250, 500)
    expect(bucketIndex(999)).toBe(3);     // [500, 1000)
    expect(bucketIndex(1000)).toBe(4);    // [1000, 2500)
    expect(bucketIndex(9999)).toBe(6);    // [5000, 10000)
    expect(bucketIndex(10000)).toBe(7);   // [10000, ∞) overflow bucket
    expect(bucketIndex(600000)).toBe(7);  // [10000, ∞) overflow bucket
  });
});

describe('newHist / addToHist', () => {
  it('starts as eight zeroes', () => {
    expect(newHist()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('increments the right bucket', () => {
    const h = newHist();
    addToHist(h, 120);
    addToHist(h, 120);
    addToHist(h, 30000);
    expect(h).toEqual([0, 2, 0, 0, 0, 0, 0, 1]);
  });
});
