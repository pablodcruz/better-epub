import { beforeEach, describe, expect, it } from "vitest";
import { db, removeBook } from "./db";
import type { BookRecord } from "./types";

const book: BookRecord = {
  id: "continuity-book",
  title: "Continuity Book",
  author: "Reader",
  importedAt: 1,
  lastOpenedAt: 1,
  progress: 0.25,
  size: 100,
  manifest: {
    metadata: { title: "Continuity Book", conformsTo: [], layout: "reflowable", readingProgression: "ltr" },
    readingOrder: [],
    resources: [],
    toc: [],
  },
};

describe("reading continuity storage", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("stores reading sessions and removes them with their book", async () => {
    await db.books.put(book);
    await db.sessions.put({
      id: "session-1",
      bookId: book.id,
      startedAt: 100,
      endedAt: 1_000,
      startProgress: 0.2,
      endProgress: 0.25,
    });

    expect(await db.sessions.where("bookId").equals(book.id).count()).toBe(1);
    await removeBook(book.id);
    expect(await db.sessions.where("bookId").equals(book.id).count()).toBe(0);
  });
});
