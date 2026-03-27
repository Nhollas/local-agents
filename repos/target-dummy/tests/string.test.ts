import { describe, it, expect } from "vitest";
import { capitalize, slugify, truncate, camelToKebab } from "../src/string.ts";

describe("capitalize", () => {
  it("capitalizes first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("handles empty string", () => {
    expect(capitalize("")).toBe("");
  });
});

describe("slugify", () => {
  it("converts to slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(slugify("What's up?")).toBe("what-s-up");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify(" hello ")).toBe("hello");
  });
});

describe("truncate", () => {
  it("truncates long strings", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("returns short strings unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
});

describe("camelToKebab", () => {
  it("converts camelCase to kebab-case", () => {
    expect(camelToKebab("backgroundColor")).toBe("background-color");
  });

  it("handles single word", () => {
    expect(camelToKebab("color")).toBe("color");
  });
});
