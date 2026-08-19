import { beforeEach, describe, expect, it } from "vitest";
import { Locator } from "@readium/shared";
import { unzipSync, zipSync } from "fflate";
import { db, saveImportedBook, updateBook } from "./db";
import { assertSecureImportSupport, importEpub } from "./epub";
import { resolveArchivePath } from "./paths";

function makeEpub(overrides: Record<string, string> = {}) {
  const ByteArray = zipSync({}).constructor as Uint8ArrayConstructor;
  const toBytes = (value: string) => new ByteArray(Buffer.from(value));
  const files: Record<string, Uint8Array> = {
    mimetype: toBytes("application/epub+zip"),
    "META-INF/container.xml": toBytes(`<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles>
      </container>`),
    "OPS/package.opf": toBytes(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:identifier>book-123</dc:identifier><dc:title>A Small Book</dc:title>
          <dc:creator>Example Author</dc:creator><dc:language>en</dc:language>
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
          <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" />
          <item id="cover" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image" />
        </manifest>
        <spine><itemref idref="chapter" /></spine>
      </package>`),
    "OPS/nav.xhtml": toBytes(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/chapter.xhtml#start">Opening</a></li></ol></nav></body></html>`),
    "OPS/text/chapter.xhtml": toBytes(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Opening</title></head><body><h1 id="start">Opening</h1><p>Hello reader.</p></body></html>`),
    "OPS/images/cover.svg": toBytes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150"><rect width="100" height="150" fill="green" /></svg>`),
  };
  for (const [path, content] of Object.entries(overrides)) files[path] = toBytes(content);
  const zipped = zipSync(files);
  const bytes = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
  return new File([bytes], "small-book.epub", { type: "application/epub+zip" });
}

describe("EPUB import", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("explains that EPUB import needs HTTPS when Web Crypto is unavailable", () => {
    expect(() => assertSecureImportSupport(undefined)).toThrow(
      "A secure HTTPS connection is required to import EPUB files",
    );
  });

  it("extracts package metadata, reading order, navigation, and cover", async () => {
    const file = makeEpub();
    expect(Object.keys(unzipSync(new Uint8Array(await file.arrayBuffer())))).toContain("META-INF/container.xml");
    const imported = await importEpub(file);
    expect(imported.book.title).toBe("A Small Book");
    expect(imported.book.author).toBe("Example Author");
    expect(imported.book.coverPath).toBe("OPS/images/cover.svg");
    expect(imported.book.manifest.readingOrder[0]?.href).toBe("OPS/text/chapter.xhtml");
    expect(imported.book.manifest.toc[0]).toMatchObject({
      href: "OPS/text/chapter.xhtml#start",
      title: "Opening",
    });
  });

  it("stores the complete book in the local database", async () => {
    const imported = await importEpub(makeEpub());
    await saveImportedBook(imported.book, imported.resources);
    expect(await db.books.get(imported.book.id)).toMatchObject({ title: "A Small Book" });
    expect(await db.resources.get([imported.book.id, "OPS/text/chapter.xhtml"])).toBeDefined();
  });

  it("restores the exact locator, highlight, and preferences after closing the database", async () => {
    const imported = await importEpub(makeEpub());
    await saveImportedBook(imported.book, imported.resources);
    const locator = Locator.deserialize({
      href: "OPS/text/chapter.xhtml",
      type: "application/xhtml+xml",
      locations: {
        fragments: ["start"],
        progression: 0.673421,
        totalProgression: 0.314159,
        position: 42,
      },
      text: {
        before: "A few words before",
        highlight: "Hello reader.",
        after: "A few words after",
      },
    });
    expect(locator).toBeDefined();
    const serialized = locator!.serialize();
    await updateBook(imported.book.id, { lastLocator: serialized, progress: 0.314159 });
    await db.annotations.put({
      id: "highlight-1",
      bookId: imported.book.id,
      type: "highlight",
      locator: serialized,
      quote: "Hello reader.",
      color: "yellow",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await db.preferences.put({
      bookId: imported.book.id,
      flow: "scrolled",
      theme: "night",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 125,
      lineHeight: 1.8,
      letterSpacing: 0.04,
      wordSpacing: 0.1,
      pageGutter: 32,
      columnCount: 2,
      textAlign: "justify",
    });

    db.close();
    await db.open();

    const restoredBook = await db.books.get(imported.book.id);
    const restoredHighlight = await db.annotations.get("highlight-1");
    const restoredPreferences = await db.preferences.get(imported.book.id);
    expect(restoredBook?.lastLocator).toEqual(serialized);
    expect(restoredBook?.progress).toBe(0.314159);
    expect(restoredHighlight).toMatchObject({ quote: "Hello reader.", locator: serialized });
    expect(restoredPreferences).toMatchObject({ flow: "scrolled", theme: "night", columnCount: 2 });
  });

  it("keeps reading state, annotations, and preferences when the same EPUB is refreshed", async () => {
    const firstImport = await importEpub(makeEpub());
    await saveImportedBook(firstImport.book, firstImport.resources);
    const locator = Locator.deserialize({
      href: "OPS/text/chapter.xhtml",
      type: "application/xhtml+xml",
      locations: { progression: 0.75, totalProgression: 0.6, position: 7 },
    })!;
    await updateBook(firstImport.book.id, { lastLocator: locator.serialize(), progress: 0.6 });
    await db.annotations.put({
      id: "note-1",
      bookId: firstImport.book.id,
      type: "note",
      locator: locator.serialize(),
      quote: "Hello reader.",
      note: "Keep this thought.",
      createdAt: 1,
      updatedAt: 1,
    });
    const preferences = await db.preferences.get(firstImport.book.id);
    await db.preferences.put({ ...preferences!, theme: "sepia", fontSize: 135 });

    const refreshedImport = await importEpub(makeEpub());
    await saveImportedBook(refreshedImport.book, refreshedImport.resources);

    expect(await db.books.get(firstImport.book.id)).toMatchObject({
      progress: 0.6,
      lastLocator: locator.serialize(),
    });
    expect(await db.annotations.get("note-1")).toMatchObject({ note: "Keep this thought." });
    expect(await db.preferences.get(firstImport.book.id)).toMatchObject({ theme: "sepia", fontSize: 135 });
  });

  it("parses an EPUB 2 NCX table of contents", async () => {
    const epub2 = makeEpub({
      "OPS/package.opf": `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:identifier>legacy-123</dc:identifier><dc:title>A Legacy Book</dc:title>
          </metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
            <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" />
          </manifest>
          <spine toc="ncx"><itemref idref="chapter" /></spine>
        </package>`,
      "OPS/toc.ncx": `<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap><navPoint id="one"><navLabel><text>Legacy opening</text></navLabel>
          <content src="text/chapter.xhtml#start" /></navPoint></navMap>
        </ncx>`,
    });
    const imported = await importEpub(epub2);
    expect(imported.book.manifest.toc[0]).toMatchObject({
      href: "OPS/text/chapter.xhtml#start",
      title: "Legacy opening",
    });
  });

  it("rejects XML entities", async () => {
    const unsafe = makeEpub({
      "META-INF/container.xml": `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY example "unsafe">]><container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>`,
    });
    await expect(importEpub(unsafe)).rejects.toThrow("Unsafe XML entities");
  });

  it("rejects remote publication resources", async () => {
    const unsafe = makeEpub({
      "OPS/package.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Remote Book</dc:title></metadata><manifest><item id="chapter" href="https://example.com/chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>`,
    });
    await expect(importEpub(unsafe)).rejects.toThrow("Remote EPUB resources are disabled");
  });

  it("rejects protocol-relative and absolute publication paths", () => {
    expect(() => resolveArchivePath("OPS/package.opf", "//example.com/chapter.xhtml"))
      .toThrow("Remote EPUB resources are disabled");
    expect(() => resolveArchivePath("OPS/package.opf", "/chapter.xhtml"))
      .toThrow("Absolute EPUB resource paths are disabled");
  });

  it("rejects colliding normalized archive paths before parsing", async () => {
    const unsafe = makeEpub({
      "OPS/chapters/../duplicate.xhtml": "<html />",
      "OPS/duplicate.xhtml": "<html />",
    });
    await expect(importEpub(unsafe)).rejects.toThrow("duplicate resource path");
  });

  it("stores sanitized reading markup while preserving the original EPUB backup", async () => {
    const activeMarkup = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Unsafe</title><script>parent.document.body.textContent = "owned"</script></head><body onload="steal()"><p>Readable text.</p><iframe srcdoc="&lt;script&gt;steal()&lt;/script&gt;"></iframe></body></html>`;
    const imported = await importEpub(makeEpub({ "OPS/text/chapter.xhtml": activeMarkup }));
    const chapter = imported.resources.find((resource) => resource.path === "OPS/text/chapter.xhtml");
    const source = imported.resources.find((resource) => resource.path === "__source__.epub");

    expect(await chapter?.blob.text()).toContain("Readable text.");
    expect(await chapter?.blob.text()).not.toMatch(/<script|<iframe|\sonload=/i);
    const original = unzipSync(new Uint8Array(await source!.blob.arrayBuffer()));
    expect(new TextDecoder().decode(original["OPS/text/chapter.xhtml"])).toContain("parent.document");
  });
});
