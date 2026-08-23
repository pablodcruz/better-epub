import { strFromU8, unzipSync, zipSync } from "fflate";
import { Locator } from "@readium/shared";
import { db, DEFAULT_PREFERENCES } from "./db";
import { importEpub } from "./epub";
import type { AnnotationRecord, BookRecord, ReaderPreferencesRecord } from "./types";

const BACKUP_FORMAT = "better-epub-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_BOOKS = 1_000;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_EPUB_BYTES = 250 * 1024 * 1024;

interface BackupBookState {
  source: string;
  book: BookRecord;
  annotations: AnnotationRecord[];
  preferences: ReaderPreferencesRecord;
}

interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  books: BackupBookState[];
}

export async function createLibraryBackup() {
  const books = await db.books.toArray();
  if (books.length === 0) throw new Error("Import at least one book before creating a backup.");
  const files: Record<string, Uint8Array> = {};
  const states: BackupBookState[] = [];

  for (const book of books) {
    const [source, annotations, storedPreferences] = await Promise.all([
      db.resources.get([book.id, "__source__.epub"]),
      db.annotations.where("bookId").equals(book.id).toArray(),
      db.preferences.get(book.id),
    ]);
    if (!source) throw new Error(`The original EPUB for “${book.title}” is missing.`);
    const sourcePath = `books/${book.id}.epub`;
    files[sourcePath] = new Uint8Array(await readBlob(source.blob));
    states.push({
      source: sourcePath,
      book,
      annotations,
      preferences: storedPreferences ?? { bookId: book.id, ...DEFAULT_PREFERENCES },
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    books: states,
  };
  const encodedManifest = new TextEncoder().encode(JSON.stringify(manifest));
  files["backup.json"] = new Uint8Array(encodedManifest.buffer, encodedManifest.byteOffset, encodedManifest.byteLength);
  const archive = zipSync(files, { level: 0 });
  const bytes = copyArrayBuffer(archive);
  const date = new Date().toISOString().slice(0, 10);
  return {
    blob: new Blob([bytes.slice(0)], { type: "application/zip" }),
    bytes,
    name: `better-epub-library-${date}.betterepub-backup`,
    bookCount: books.length,
  };
}

export async function restoreLibraryBackup(file: File) {
  if (file.size > MAX_BACKUP_BYTES) throw new Error("This backup is larger than the 1 GB restore limit.");
  let expandedBytes = 0;
  let entryCount = 0;
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      entryCount += 1;
      if (entryCount > MAX_BOOKS + 1) throw new Error("This backup contains too many files.");
      const limit = entry.name === "backup.json" ? MAX_MANIFEST_BYTES : MAX_EPUB_BYTES;
      if (entry.originalSize > limit) throw new Error(`The backup entry “${entry.name}” is too large.`);
      expandedBytes += entry.originalSize;
      if (expandedBytes > MAX_BACKUP_BYTES) throw new Error("The expanded backup exceeds the 1 GB restore limit.");
      return true;
    },
  });
  const manifestBytes = archive["backup.json"];
  if (!manifestBytes) throw new Error("This is not a Better ePub library backup.");
  const manifest = parseManifest(strFromU8(manifestBytes));

  let restored = 0;
  for (const state of manifest.books) {
    const source = archive[state.source];
    if (!source) throw new Error(`The EPUB for “${state.book.title}” is missing from the backup.`);
    const imported = await importEpub(new File([copyArrayBuffer(source)], `${state.book.id}.epub`, { type: "application/epub+zip" }));
    const bookId = state.book.id;
    const lastLocator = state.book.lastLocator && Locator.deserialize(state.book.lastLocator)
      ? state.book.lastLocator
      : undefined;
    const restoredBook: BookRecord = {
      ...imported.book,
      id: bookId,
      importedAt: finiteNumber(state.book.importedAt, imported.book.importedAt),
      lastOpenedAt: finiteNumber(state.book.lastOpenedAt, imported.book.lastOpenedAt),
      progress: clamp(finiteNumber(state.book.progress, 0), 0, 1),
      lastLocator,
    };
    const resources = imported.resources.map((resource) => ({ ...resource, bookId }));
    const annotations = normalizeAnnotations(state.annotations, bookId);
    const preferences = normalizePreferences(state.preferences, bookId);

    await db.transaction("rw", db.books, db.resources, db.annotations, db.preferences, async () => {
      await Promise.all([
        db.resources.where("bookId").equals(bookId).delete(),
        db.annotations.where("bookId").equals(bookId).delete(),
      ]);
      await db.books.put(restoredBook);
      await db.resources.bulkPut(resources);
      if (annotations.length) await db.annotations.bulkPut(annotations);
      await db.preferences.put(preferences);
    });
    restored += 1;
  }
  return restored;
}

function parseManifest(source: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("The backup manifest is not valid JSON.");
  }
  if (!value || typeof value !== "object") throw new Error("The backup manifest is invalid.");
  const candidate = value as Partial<BackupManifest>;
  if (candidate.format !== BACKUP_FORMAT || candidate.version !== BACKUP_VERSION || !Array.isArray(candidate.books)) {
    throw new Error("This backup format is not supported.");
  }
  if (candidate.books.length > MAX_BOOKS) throw new Error("This backup contains too many books.");
  for (const state of candidate.books) {
    if (!state || typeof state !== "object" || !isSafeBookId(state.book?.id) || state.source !== `books/${state.book.id}.epub`) {
      throw new Error("The backup contains an invalid book entry.");
    }
  }
  return candidate as BackupManifest;
}

function normalizeAnnotations(value: unknown, bookId: string): AnnotationRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AnnotationRecord[] => {
    if (!item || typeof item !== "object") return [];
    const annotation = item as Partial<AnnotationRecord>;
    if (!annotation.locator || !Locator.deserialize(annotation.locator)) return [];
    if (!annotation.id || !["highlight", "note", "bookmark"].includes(annotation.type ?? "")) return [];
    return [{
      id: String(annotation.id),
      bookId,
      type: annotation.type as AnnotationRecord["type"],
      locator: annotation.locator,
      quote: typeof annotation.quote === "string" ? annotation.quote : undefined,
      note: typeof annotation.note === "string" ? annotation.note : undefined,
      color: ["yellow", "green", "blue", "pink"].includes(annotation.color ?? "") ? annotation.color : undefined,
      createdAt: finiteNumber(annotation.createdAt, Date.now()),
      updatedAt: finiteNumber(annotation.updatedAt, Date.now()),
    }];
  });
}

function normalizePreferences(value: Partial<ReaderPreferencesRecord> | undefined, bookId: string): ReaderPreferencesRecord {
  const preferences = value ?? {};
  return {
    bookId,
    flow: preferences.flow === "scrolled" ? "scrolled" : "paginated",
    theme: ["paper", "sepia", "night"].includes(preferences.theme ?? "") ? preferences.theme! : DEFAULT_PREFERENCES.theme,
    fontFamily: typeof preferences.fontFamily === "string" ? preferences.fontFamily.slice(0, 200) : DEFAULT_PREFERENCES.fontFamily,
    fontSize: clamp(finiteNumber(preferences.fontSize, DEFAULT_PREFERENCES.fontSize), 75, 200),
    lineHeight: clamp(finiteNumber(preferences.lineHeight, DEFAULT_PREFERENCES.lineHeight), 1.1, 2.2),
    letterSpacing: clamp(finiteNumber(preferences.letterSpacing, DEFAULT_PREFERENCES.letterSpacing), 0, 0.2),
    wordSpacing: clamp(finiteNumber(preferences.wordSpacing, DEFAULT_PREFERENCES.wordSpacing), 0, 0.5),
    pageGutter: clamp(finiteNumber(preferences.pageGutter, DEFAULT_PREFERENCES.pageGutter), 0, 64),
    columnCount: preferences.columnCount === 2 ? 2 : 1,
    textAlign: ["start", "left", "right", "justify"].includes(preferences.textAlign ?? "") ? preferences.textAlign! : DEFAULT_PREFERENCES.textAlign,
  };
}

function isSafeBookId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function copyArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readBlob(blob: Blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("The stored EPUB could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}
