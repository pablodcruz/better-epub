import { beforeEach, describe, expect, it } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createLibraryBackup, restoreLibraryBackup } from "./backup";
import { db, saveImportedBook, updateBook } from "./db";
import { importEpub } from "./epub";

function makeEpub() {
  const ByteArray = zipSync({}).constructor as Uint8ArrayConstructor;
  const toBytes = (value: string) => new ByteArray(Buffer.from(value));
  const files = {
    mimetype: toBytes("application/epub+zip"),
    "META-INF/container.xml": toBytes(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>`),
    "OPS/package.opf": toBytes(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>backup-book</dc:identifier><dc:title>Backup Book</dc:title><dc:creator>Reader</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>`),
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
    expect(await db.resources.get([imported.book.id, "__source__.epub"])).toBeDefined();
  });

  it("rejects files that are not Better ePub backups", async () => {
    const invalid = zipSync({ "other.json": strToU8("{}") });
    const file = new File([invalid.slice().buffer as ArrayBuffer], "invalid.zip");
    await expect(restoreLibraryBackup(file)).rejects.toThrow("not a Better ePub library backup");
  });
});
