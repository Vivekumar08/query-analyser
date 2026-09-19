import { describe, it, expect } from 'vitest';
import { bucketIndex, newHist, addToHist } from './histogram.js';

describe('bucketIndex', () => {
  it('maps a duration to the bucket whose upper bound it falls under', () => {
    expect(bucketIndex(101)).toBe(0);     // (…,250)
    expect(bucketIndex(249)).toBe(0);
    expect(bucketIndex(250)).toBe(1);     // bound is exclusive-below
    expect(bucketIndex(999)).toBe(2);
    expect(bucketIndex(1000)).toBe(3);
    expect(bucketIndex(9999)).toBe(5);
    expect(bucketIndex(10000)).toBe(7);   // overflow bucket
    expect(bucketIndex(600000)).toBe(7);
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
    expect(h).toEqual([2, 0, 0, 0, 0, 0, 0, 1]);
  });
});
