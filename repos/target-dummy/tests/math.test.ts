import { describe, it, expect } from "vitest";
import { add, multiply, clamp, range, sum } from "../src/math.ts";

describe("add", () => {
  it("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("handles negative numbers", () => {
    expect(add(-1, 1)).toBe(0);
  });
});

describe("multiply", () => {
  it("multiplies two numbers", () => {
    expect(multiply(3, 4)).toBe(12);
  });

  it("handles zero", () => {
    expect(multiply(5, 0)).toBe(0);
  });
});

describe("clamp", () => {
  it("clamps value below min", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamps value above max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("returns value within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe("range", () => {
  it("generates a range of numbers", () => {
    expect(range(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns empty for equal start and end", () => {
    expect(range(3, 3)).toEqual([]);
  });
});

describe("sum", () => {
  it("sums an array of numbers", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  it("returns 0 for empty array", () => {
    expect(sum([])).toBe(0);
  });
});
