import { beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createLibraryBackup, restoreLibraryBackup } from "./backup";
import Dexie from "dexie";
import { Locator } from "@readium/shared";
import * as storage from "./db";
import { db, saveImportedBook, saveReaderChange, saveReadingPosition, updateBook } from "./db";
import { importEpub } from "./epub";

function makeEpub(identifier = "backup-book", title = "Backup Book") {
  const ByteArray = zipSync({}).constructor as Uint8ArrayConstructor;
  const toBytes = (value: string) => new ByteArray(Buffer.from(value));
  const files = {
    mimetype: toBytes("application/epub+zip"),
    "META-INF/container.xml": toBytes(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>`),
    "OPS/package.opf": toBytes(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>${identifier}</dc:identifier><dc:title>${title}</dc:title><dc:creator>Reader</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>`),
    "OPS/chapter.xhtml": toBytes(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Keep every word.</p></body></html>`),
  };
  const archive = zipSync(files);
  const bytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return new File([bytes], "backup-book.epub", { type: "application/epub+zip" });
}

describe("library backup", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("round-trips source books, reading state, notes, and preferences", async () => {
    const sourceFile = makeEpub();
    const sourceBytes = await sourceFile.arrayBuffer();
    const imported = await importEpub(sourceFile);
    await saveImportedBook(imported.book, imported.resources);
    await db.resources.put({
      bookId: imported.book.id,
      path: "__source__.epub",
      mediaType: "application/epub+zip",
      blob: new NodeBlob([sourceBytes], { type: "application/epub+zip" }) as unknown as Blob,
    });
    await updateBook(imported.book.id, { progress: 0.42 });
    await db.annotations.put({
      id: "note-1",
      bookId: imported.book.id,
      type: "note",
      locator: { href: "OPS/chapter.xhtml", type: "application/xhtml+xml", locations: { progression: 0.5 } },
      quote: "Keep every word.",
      note: "Important",
      createdAt: 10,
      updatedAt: 10,
    });
    await db.preferences.update(imported.book.id, { theme: "night", fontSize: 130 });
    await db.sessions.put({ id: "session-1", bookId: imported.book.id, startedAt: 100, endedAt: 1_000, startProgress: 0.1, endProgress: 0.42 });

    const backup = await createLibraryBackup();
    expect(backup.bookCount).toBe(1);
    expect(Object.keys(unzipSync(new Uint8Array(backup.bytes))).slice(0, 5)).toEqual([
      `books/${imported.book.id}.epub`,
      "backup.json",
    ]);
    await db.delete();
    await db.open();

    const restored = await restoreLibraryBackup(new File([backup.bytes], backup.name, { type: backup.blob.type }));
    expect(restored).toBe(1);
    expect(await db.books.get(imported.book.id)).toMatchObject({ title: "Backup Book", progress: 0.42 });
    expect(await db.annotations.get("note-1")).toMatchObject({ note: "Important", bookId: imported.book.id });
    expect(await db.preferences.get(imported.book.id)).toMatchObject({ theme: "night", fontSize: 130 });
    expect(await db.sessions.get("session-1")).toMatchObject({ bookId: imported.book.id, endProgress: 0.42 });
    expect(await db.resources.get([imported.book.id, "__source__.epub"])).toBeDefined();
  });

  // Two books in a fixed manifest order; writes to the first must not survive a
  // failure on the second. The local copy deliberately differs from the backup.
  async function pair() {
    const epub = makeEpub();
    const ByteArray = zipSync({}).constructor as Uint8ArrayConstructor;
    const source = new ByteArray(await epub.arrayBuffer());
    const otherSource = new ByteArray(await makeEpub("second-book", "Second Book").arrayBuffer());
    const { book, resources } = await importEpub(epub);
    const local = { ...book, id: "first", progress: 0.73 };
    await saveImportedBook(local, resources.map(row => ({ ...row, bookId: local.id })));
    const note = {
      id: "local-note", bookId: local.id, type: "note" as const,
      locator: { href: "OPS/chapter.xhtml", type: "application/xhtml+xml", locations: { progression: 0.73 } },
      note: "Keep my newer notes", createdAt: 1, updatedAt: 2,
    };
    await db.annotations.put(note);
    await db.preferences.update(local.id, { theme: "night" });
    await db.sessions.put({ id: "local-session", bookId: local.id, startedAt: 1, endedAt: 2, startProgress: 0, endProgress: 0.73 });
    const extra = { bookId: local.id, path: "local-only", mediaType: "text/plain", blob: new NodeBlob(["local"]) as unknown as Blob };
    await db.resources.put(extra);
    const states = ["first", "second"].map(id => ({
      source: `books/${id}.epub`, book: { ...book, id, progress: 0.11 },
      annotations: [], preferences: { theme: "paper" }, sessions: [],
    }));
    const archive = (badSecond = false) => {
      const files = {
        "backup.json": new ByteArray(Buffer.from(JSON.stringify({ format: "better-epub-backup", version: 1, books: states }))),
        "books/first.epub": source, "books/second.epub": badSecond ? zipSync({}) : otherSource,
      };
      return new File([zipSync(files).slice().buffer as ArrayBuffer], "pair.zip");
    };
    const expectLocalIntact = async () => {
      expect(await db.books.get(local.id)).toEqual(local);
      expect(await db.annotations.get(note.id)).toEqual(note);
      expect(await db.preferences.get(local.id)).toMatchObject({ theme: "night" });
      expect(await db.sessions.get("local-session")).toMatchObject({ bookId: local.id, endProgress: 0.73 });
      const saved = await db.resources.get([local.id, extra.path]);
      expect(await saved?.blob.text()).toBe("local");
      expect(await db.books.get("second")).toBeUndefined();
    };
    return { archive, expectLocalIntact };
  }

  it("keeps the current library when the second EPUB cannot be imported", async () => {
    const { archive, expectLocalIntact } = await pair();
    using changed = vi.spyOn(storage, "notifyLibraryChange");
    await expect(restoreLibraryBackup(archive(true))).rejects.toThrow(/missing.*container.xml/i);
    expect(changed).not.toHaveBeenCalled();
    await expectLocalIntact();
  });

  it("rolls back earlier books if an IndexedDB write fails on the second", async () => {
    const { archive, expectLocalIntact } = await pair();
    using changed = vi.spyOn(storage, "notifyLibraryChange");
    const failSecond = (key: unknown) => { if (key === "second") throw new Error("simulated write failure"); };
    db.books.hook("creating", failSecond);
    try {
      await expect(restoreLibraryBackup(archive())).rejects.toThrow("simulated write failure");
    } finally {
      db.books.hook("creating").unsubscribe(failSecond);
    }
    expect(changed).not.toHaveBeenCalled();
    await expectLocalIntact();
  });

  it("restores both books on success and replaces the backed-up book's local state", async () => {
    const { archive } = await pair();
    using changed = vi.spyOn(storage, "notifyLibraryChange").mockImplementation(() => {
      expect(Dexie.currentTransaction).toBeNull();
    });
    expect(await restoreLibraryBackup(archive())).toBe(2);
    expect(changed.mock.calls).toEqual([[]]);
    expect(await db.books.get("first")).toMatchObject({ progress: 0.11 });
    expect(await db.books.get("second")).toMatchObject({ title: "Second Book", progress: 0.11 });
    expect(await db.annotations.count()).toBe(0);
    expect(await db.preferences.get("first")).toMatchObject({ theme: "paper" });
    expect(await db.sessions.count()).toBe(0);
    expect(await db.resources.get(["first", "local-only"])).toBeUndefined();
    expect(await db.resources.get(["second", "__source__.epub"])).toBeDefined();
  });

  it("discards queued reader writes for a replaced book", async () => {
    const { archive } = await pair();
    const oldBook = (await db.books.get("first"))!;
    const oldNote = (await db.annotations.get("local-note"))!;
    const oldSettings = (await db.preferences.get("first"))!;
    const oldSession = (await db.sessions.get("local-session"))!;
    await restoreLibraryBackup(archive());

    await saveReaderChange(oldBook, "sessions", () => db.sessions.put(oldSession));
    await saveReaderChange(oldBook, "books", (book) => db.books.put({ ...book, progress: 0.73 }));
    expect(await db.sessions.get(oldSession.id)).toBeUndefined();
    const restored = (await db.books.get("first"))!;
    expect(restored.progress).toBe(0.11);
    const newNote = { ...oldNote, note: "Restored reader's note" };
    await saveReaderChange(restored, "annotations", () => db.annotations.put(newNote));
    await saveReaderChange(oldBook, "preferences", () => db.preferences.put(oldSettings));
    await saveReaderChange(oldBook, "annotations", () => db.annotations.bulkPut([oldNote]));
    await saveReaderChange(oldBook, "annotations", () => db.annotations.delete(oldNote.id));
    expect(await db.preferences.get("first")).toMatchObject({ theme: "paper" });
    expect(await db.annotations.get(oldNote.id)).toEqual(newNote);

    await saveReaderChange(restored, "books", (book) => db.books.put({ ...book, progress: 0.15 }));
    expect((await db.books.get("first"))?.progress).toBe(0.15);
  });

  it("does not mark a restored book as newly opened when Readium reports its existing position", async () => {
    const { archive } = await pair();
    await restoreLibraryBackup(archive());
    const locator = Locator.deserialize({
      href: "OPS/chapter.xhtml",
      type: "application/xhtml+xml",
      locations: { position: 1, progression: 0.25, totalProgression: 0.11 },
    })!;
    const lastOpenedAt = 1234567890000;
    const book = { ...(await db.books.get("first"))!, lastOpenedAt, lastLocator: locator.serialize() };
    await db.books.put(book);
    const changed = vi.fn();
    vi.stubGlobal("BroadcastChannel", class {
      postMessage = changed;
      close() {}
    });
    const puts = vi.spyOn(db.books, "put");

    try {
      expect(await saveReadingPosition(book, locator, 0.11)).toBe(false);
      expect(puts).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(await db.books.get("first")).toEqual(book);

      const next = locator.copyWithLocations({ progression: 0.5 });
      expect(await saveReadingPosition(book, next, 0.11)).toBe(true);
      expect(await db.books.get("first")).toMatchObject({ lastLocator: next.serialize() });
      expect((await db.books.get("first"))?.lastOpenedAt).toBeGreaterThan(lastOpenedAt);
      expect(puts).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledExactlyOnceWith({ bookId: "first", at: expect.any(Number) });
    } finally {
      puts.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("stays silent if the enclosing transaction rolls back after restore", async () => {
    const { archive, expectLocalIntact } = await pair();
    using changed = vi.spyOn(storage, "notifyLibraryChange");
    await expect(db.transaction("rw", db.tables, async () => {
      await restoreLibraryBackup(archive());
      throw new Error("cancel outer transaction");
    })).rejects.toThrow("cancel outer transaction");
    expect(changed).not.toHaveBeenCalled();
    await expectLocalIntact();
  });

  it("returns zero without sending a change for an empty archive", async () => {
    const manifest = JSON.stringify({ format: "better-epub-backup", version: 1, books: [] });
    const ByteArray = zipSync({}).constructor as Uint8ArrayConstructor;
    const bytes = zipSync({ "backup.json": new ByteArray(Buffer.from(manifest)) });
    using changed = vi.spyOn(storage, "notifyLibraryChange");
    expect(await restoreLibraryBackup(new File([bytes.slice().buffer as ArrayBuffer], "empty.zip"))).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects files that are not Better ePub backups", async () => {
    const invalid = zipSync({ "other.json": strToU8("{}") });
    const file = new File([invalid.slice().buffer as ArrayBuffer], "invalid.zip");
    await expect(restoreLibraryBackup(file)).rejects.toThrow("not a Better ePub library backup");
  });
});
