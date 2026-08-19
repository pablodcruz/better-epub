import { describe, expect, it } from "vitest";
import { createAnnotationExport } from "./annotations";
import type { AnnotationRecord } from "./types";

const annotations: AnnotationRecord[] = [{
  id: "highlight-1",
  bookId: "book-1",
  type: "note",
  locator: {
    href: "chapter.xhtml",
    type: "application/xhtml+xml",
    locations: { progression: 0.5, totalProgression: 0.25 },
  },
  quote: "A useful passage",
  note: "Remember this idea.",
  color: "yellow",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}];

describe("annotation exports", () => {
  it("creates a parseable JSON backup with the full locator", () => {
    const exported = createAnnotationExport({ title: "A Better Book", author: "Ada Reader" }, annotations, "json");
    const parsed = JSON.parse(exported.content);
    expect(exported).toMatchObject({ name: "a-better-book-annotations.json", type: "application/json" });
    expect(parsed.annotations[0]).toMatchObject({
      quote: "A useful passage",
      note: "Remember this idea.",
      locator: { locations: { progression: 0.5, totalProgression: 0.25 } },
    });
  });

  it("creates a readable Markdown notebook", () => {
    const exported = createAnnotationExport({ title: "A Better Book", author: "Ada Reader" }, annotations, "markdown");
    expect(exported).toMatchObject({ name: "a-better-book-annotations.md", type: "text/markdown" });
    expect(exported.content).toContain("# A Better Book\n\nAda Reader");
    expect(exported.content).toContain("> A useful passage");
    expect(exported.content).toContain("Remember this idea.");
  });
});
