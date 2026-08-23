import { describe, expect, it } from "vitest";
import { findResourceMatches } from "./search";

describe("book search", () => {
  it("returns every occurrence with a precise text locator", () => {
    const results = findResourceMatches({
      href: "chapter.xhtml",
      type: "application/xhtml+xml",
      title: "Opening",
      text: "Before useful phrase after. Another USEFUL\n phrase appears.",
      spineIndex: 1,
      spineLength: 4,
    }, "useful phrase");

    expect(results).toHaveLength(2);
    expect(results[0].locator).toMatchObject({
      href: "chapter.xhtml",
      title: "Opening",
      text: { highlight: "useful phrase" },
    });
    expect(results[1].locator.text.highlight).toBe("USEFUL\n phrase");
    expect(results[0].locator.locations.totalProgression).toBeGreaterThanOrEqual(0.25);
  });

  it("enforces the result limit and ignores short queries", () => {
    const resource = {
      href: "chapter.xhtml",
      type: "application/xhtml+xml",
      title: "Chapter",
      text: "word word word",
      spineIndex: 0,
      spineLength: 1,
    };
    expect(findResourceMatches(resource, "w")).toEqual([]);
    expect(findResourceMatches(resource, "word", 2)).toHaveLength(2);
  });
});
