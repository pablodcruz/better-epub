import { describe, expect, it } from "vitest";
import { createAnnotationArchive, createAnnotationExport, importAnnotations } from "./annotations";
import type { AnnotationRecord, BookRecord } from "./types";

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
  tags: ["research", "chapter-one"],
}];

const book = {
  id: "book-1",
  title: "A Better Book",
  author: "Ada Reader",
  manifest: {
    metadata: { identifier: "urn:isbn:123" },
    readingOrder: [{ href: "chapter.xhtml", type: "application/xhtml+xml" }],
  },
} as BookRecord;

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

  it("round-trips interoperable EPUB annotation archives", async () => {
    const exported = createAnnotationArchive(book, annotations);
    expect(exported.name).toBe("a-better-book.annotations");
    const imported = await importAnnotations(new File([exported.content], exported.name, { type: exported.type }), book);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      bookId: "book-1",
      type: "note",
      quote: "A useful passage",
      note: "Remember this idea.",
      color: "yellow",
      tags: ["research", "chapter-one"],
    });
    expect(imported[0].locator).toMatchObject({ href: "chapter.xhtml", text: { highlight: "A useful passage" } });
  });

  it("rejects annotation sets for another publication", async () => {
    const otherBook = { ...book, manifest: { ...book.manifest, metadata: { identifier: "different-book" } } } as BookRecord;
    const exported = createAnnotationArchive(book, annotations);
    await expect(importAnnotations(new File([exported.content], exported.name, { type: exported.type }), otherBook))
      .rejects.toThrow("different EPUB");
  });
});
