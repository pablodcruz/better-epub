import type { AnnotationRecord, BookRecord } from "./types";
import { Locator } from "@readium/shared";
import { unzipSync, zipSync } from "fflate";

export type AnnotationExportFormat = "markdown" | "json";

export function createAnnotationExport(
  book: Pick<BookRecord, "title" | "author">,
  annotations: AnnotationRecord[],
  format: AnnotationExportFormat,
) {
  const safeName = book.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "book";
  if (format === "json") {
    return {
      name: `${safeName}-annotations.json`,
      content: JSON.stringify({ book: { title: book.title, author: book.author }, annotations }, null, 2),
      type: "application/json",
    };
  }
  const body = annotations.map((annotation) => {
    const heading = `## ${annotation.type[0].toUpperCase()}${annotation.type.slice(1)}`;
    const quote = annotation.quote ? `\n\n> ${annotation.quote.replaceAll("\n", "\n> ")}` : "";
    const note = annotation.note ? `\n\n${annotation.note}` : "";
    return `${heading}${quote}${note}\n\n_${new Date(annotation.createdAt).toLocaleString()}_`;
  }).join("\n\n---\n\n");
  return {
    name: `${safeName}-annotations.md`,
    content: `# ${book.title}\n\n${book.author}\n\n${body}`,
    type: "text/markdown",
  };
}

export function createAnnotationArchive(book: BookRecord, annotations: AnnotationRecord[]) {
  const items = annotations.map((annotation) => {
    const locator = Locator.deserialize(annotation.locator);
    const selectors: Array<Record<string, unknown>> = [];
    for (const fragment of locator?.locations.fragments ?? []) {
      selectors.push({ type: "FragmentSelector", value: fragment.startsWith("#") ? fragment : `#${fragment}` });
    }
    const exactQuote = locator?.text?.highlight ?? annotation.quote;
    if (exactQuote) {
      selectors.push({
        type: "TextQuoteSelector",
        exact: exactQuote,
        prefix: locator?.text?.before,
        suffix: locator?.text?.after,
      });
    }
    return {
      id: annotation.id.startsWith("urn:") ? annotation.id : `urn:uuid:${annotation.id}`,
      type: "Annotation",
      motivation: annotation.type === "bookmark" ? "bookmarking" : annotation.type === "note" ? "commenting" : "highlighting",
      created: new Date(annotation.createdAt).toISOString(),
      modified: new Date(annotation.updatedAt).toISOString(),
      target: {
        source: locator?.href ?? annotation.locator.href,
        selector: selectors,
        meta: locator?.locations.serialize(),
      },
      body: {
        type: "TextualBody",
        value: annotation.note ?? "",
        color: annotation.color ?? "yellow",
        highlight: "solid",
        tags: annotation.tags ?? [],
      },
    };
  });
  const set = {
    "@context": "https://www.w3.org/ns/epub-anno.jsonld",
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: "AnnotationSet",
    generator: "https://better-epub.rweb.site/",
    generated: new Date().toISOString(),
    about: {
      "dc:identifier": book.manifest.metadata.identifier ? [book.manifest.metadata.identifier] : [],
      "dc:format": "application/epub+zip",
      "dc:title": book.title,
      "dc:creator": [book.author],
    },
    items,
  };
  const json = new TextEncoder().encode(JSON.stringify(set, null, 2));
  const zipBytes = compatibleBytes(json);
  const archive = zipSync({ "annotations.json": zipBytes }, { level: 6 });
  return {
    name: `${safeBookName(book.title)}.annotations`,
    content: copyArrayBuffer(archive),
    type: "application/zip;profile=https://www.w3.org/TR/epub-anno-10/",
  };
}

export async function importAnnotations(file: File, book: BookRecord): Promise<AnnotationRecord[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error("Annotation imports are limited to 10 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: unknown;
  if (file.name.toLowerCase().endsWith(".annotations") || file.type.includes("zip")) {
    const archive = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.originalSize > 10 * 1024 * 1024) throw new Error("The annotation set is too large.");
        return entry.name === "annotations.json";
      },
    });
    const content = archive["annotations.json"];
    if (!content) throw new Error("The annotation archive is missing annotations.json.");
    parsed = parseJson(new TextDecoder().decode(content));
  } else {
    parsed = parseJson(new TextDecoder().decode(bytes));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The annotation file is invalid.");
  const value = parsed as Record<string, unknown>;
  if (value.type === "AnnotationSet") return importW3cSet(value, book);
  if (Array.isArray(value.annotations)) return importBetterEpubJson(value.annotations, book.id);
  throw new Error("This annotation format is not supported.");
}

function importBetterEpubJson(items: unknown[], bookId: string) {
  return items.flatMap((item): AnnotationRecord[] => {
    if (!item || typeof item !== "object") return [];
    const annotation = item as Partial<AnnotationRecord>;
    if (!annotation.locator || !Locator.deserialize(annotation.locator)) return [];
    if (!["highlight", "note", "bookmark"].includes(annotation.type ?? "")) return [];
    const now = Date.now();
    return [{
      id: crypto.randomUUID(),
      bookId,
      type: annotation.type as AnnotationRecord["type"],
      locator: annotation.locator,
      quote: cleanString(annotation.quote, 20_000),
      note: cleanString(annotation.note, 20_000),
      color: annotationColor(annotation.color),
      tags: cleanTags(annotation.tags),
      createdAt: finiteTimestamp(annotation.createdAt, now),
      updatedAt: finiteTimestamp(annotation.updatedAt, now),
    }];
  });
}

function importW3cSet(value: Record<string, unknown>, book: BookRecord) {
  const about = value.about && typeof value.about === "object" ? value.about as Record<string, unknown> : {};
  const identifiers = Array.isArray(about["dc:identifier"]) ? about["dc:identifier"] : [];
  const bookIdentifier = book.manifest.metadata.identifier;
  if (bookIdentifier && identifiers.length && !identifiers.includes(bookIdentifier)) {
    throw new Error("This annotation set belongs to a different EPUB.");
  }
  const items = Array.isArray(value.items) ? value.items : [];
  return items.flatMap((item): AnnotationRecord[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const target = record.target && typeof record.target === "object" ? record.target as Record<string, unknown> : {};
    const source = cleanString(target.source, 2_000);
    if (!source) return [];
    const selectors = Array.isArray(target.selector) ? target.selector : [];
    const quoteSelector = selectors.find((selector) => selector && typeof selector === "object" && (selector as Record<string, unknown>).type === "TextQuoteSelector") as Record<string, unknown> | undefined;
    const fragmentSelector = selectors.find((selector) => selector && typeof selector === "object" && (selector as Record<string, unknown>).type === "FragmentSelector") as Record<string, unknown> | undefined;
    const exact = cleanString(quoteSelector?.exact, 20_000);
    const fragment = cleanString(fragmentSelector?.value, 1_000)?.replace(/^#/, "");
    const meta = target.meta && typeof target.meta === "object" ? target.meta as Record<string, unknown> : {};
    const locator = Locator.deserialize({
      href: source,
      type: book.manifest.readingOrder.find((link) => link.href.split("#", 1)[0] === source.split("#", 1)[0])?.type || "application/xhtml+xml",
      locations: { ...meta, fragments: fragment ? [fragment] : undefined },
      text: exact ? {
        highlight: exact,
        before: cleanString(quoteSelector?.prefix, 2_000),
        after: cleanString(quoteSelector?.suffix, 2_000),
      } : undefined,
    });
    if (!locator) return [];
    const body = record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : {};
    const motivation = record.motivation;
    const type: AnnotationRecord["type"] = motivation === "bookmarking" ? "bookmark" : motivation === "commenting" ? "note" : "highlight";
    const now = Date.now();
    return [{
      id: crypto.randomUUID(),
      bookId: book.id,
      type,
      locator: locator.serialize(),
      quote: exact,
      note: cleanString(body.value, 20_000),
      color: annotationColor(body.color),
      tags: cleanTags(body.tags),
      createdAt: parseDate(record.created, now),
      updatedAt: parseDate(record.modified, now),
    }];
  });
}

function parseJson(source: string) {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("The annotation file is not valid JSON.");
  }
}

function cleanString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function cleanTags(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const tags = [...new Set(value.flatMap((tag) => typeof tag === "string" && tag.trim() ? [tag.trim().slice(0, 80)] : []))].slice(0, 50);
  return tags.length ? tags : undefined;
}

function annotationColor(value: unknown): AnnotationRecord["color"] {
  return ["yellow", "green", "blue", "pink"].includes(String(value)) ? value as AnnotationRecord["color"] : "yellow";
}

function finiteTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDate(value: unknown, fallback: number) {
  if (typeof value !== "string") return fallback;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : fallback;
}

function safeBookName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "book";
}

function compatibleBytes(bytes: Uint8Array) {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function copyArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
