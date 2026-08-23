import { describe, expect, it } from "vitest";
import { adjacentResourceLocator, splitSentences } from "./read-aloud";
import type { BookRecord } from "./types";

describe("read aloud helpers", () => {
  it("splits prose into sentence-sized speech segments", () => {
    expect(splitSentences("First sentence. Second question? Last one!", "en").map((segment) => segment.text))
      .toEqual(["First sentence.", "Second question?", "Last one!"]);
  });

  it("moves between publication resources", () => {
    const book = { manifest: { readingOrder: [
      { href: "one.xhtml", type: "application/xhtml+xml" },
      { href: "two.xhtml", type: "application/xhtml+xml" },
    ] } } as BookRecord;
    expect(adjacentResourceLocator(book, "one.xhtml", 1)?.href).toBe("two.xhtml");
    expect(adjacentResourceLocator(book, "two.xhtml", 1)).toBeUndefined();
  });
});
