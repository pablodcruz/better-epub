import Dexie, { type EntityTable, type Table } from "dexie";
import { Locator } from "@readium/shared";
import type {
  AnnotationRecord,
  BookRecord,
  ReaderPreferencesRecord,
  ReadingSessionRecord,
  ResourceRecord,
} from "./types";

export const DEFAULT_PREFERENCES: Omit<ReaderPreferencesRecord, "bookId"> = {
  flow: "paginated",
  theme: "paper",
  fontFamily: "Charter, 'Iowan Old Style', Georgia, serif",
  fontSize: 100,
  lineHeight: 1.5,
  letterSpacing: 0,
  wordSpacing: 0,
  pageGutter: 24,
  columnCount: 1,
  textAlign: "start",
  reduceMotion: false,
  screenReaderMode: false,
  readingRuler: false,
};

class BetterEpubDatabase extends Dexie {
  books!: EntityTable<BookRecord, "id">;
  resources!: Table<ResourceRecord, [string, string]>;
  annotations!: EntityTable<AnnotationRecord, "id">;
  preferences!: EntityTable<ReaderPreferencesRecord, "bookId">;
  sessions!: EntityTable<ReadingSessionRecord, "id">;

  constructor() {
    super("better-epub");
    this.version(1).stores({
      books: "id, title, importedAt, lastOpenedAt",
      resources: "[bookId+path], bookId, path",
      annotations: "id, bookId, [bookId+createdAt]",
      preferences: "bookId",
    });
    this.version(2).stores({
      sessions: "id, bookId, [bookId+startedAt], startedAt",
    });
  }
}

export const db = new BetterEpubDatabase();

export async function saveImportedBook(book: BookRecord, resources: ResourceRecord[]) {
  await db.transaction("rw", db.books, db.resources, db.preferences, async () => {
    const existing = await db.books.get(book.id);
    const existingPreferences = await db.preferences.get(book.id);
    if (existing) {
      await db.resources.where("bookId").equals(book.id).delete();
    }
    await db.books.put(existing ? {
      ...book,
      importedAt: existing.importedAt,
      restoreRevision: existing.restoreRevision,
      lastLocator: existing.lastLocator,
      progress: existing.progress,
    } : book);
    await db.resources.bulkPut(resources);
    if (!existingPreferences) {
      await db.preferences.put({ bookId: book.id, ...DEFAULT_PREFERENCES });
    }
  });
  notifyLibraryChange(book.id);
}

export async function removeBook(bookId: string) {
  await db.transaction(
    "rw",
    [db.books, db.resources, db.annotations, db.preferences, db.sessions],
    async () => {
      await Promise.all([
        db.books.delete(bookId),
        db.resources.where("bookId").equals(bookId).delete(),
        db.annotations.where("bookId").equals(bookId).delete(),
        db.preferences.delete(bookId),
        db.sessions.where("bookId").equals(bookId).delete(),
      ]);
    },
  );
  notifyLibraryChange(bookId);
}

export async function updateBook(bookId: string, patch: Partial<Omit<BookRecord, "manifest">>) {
  const updated = await db.books.where("id").equals(bookId).modify((current) => { Object.assign(current, patch); });
  if (updated) notifyLibraryChange(bookId);
}

// The reader can finish an edit after a restore. Compare revisions under the
// same write lock as the mutation, even for an async annotation import.
export async function saveReaderChange(
  book: BookRecord,
  store: "books" | "sessions" | "annotations" | "preferences",
  write: (current: BookRecord) => Promise<unknown>,
) {
  const saved = await db.transaction("rw", [db.books, db[store]], async () => {
    const current = await db.books.get(book.id);
    if (!current || current.restoreRevision !== book.restoreRevision) return false;
    // A callback can return false when there is no change to publish.
    return (await write(current)) !== false;
  });
  if (saved && (store === "books" || store === "sessions")) notifyLibraryChange(book.id);
  return saved;
}

export function saveReadingPosition(book: BookRecord, locator: Locator, progress: number) {
  const next = locator.serialize();
  return saveReaderChange(book, "books", async (current) => {
    // Readium can report the existing locator as soon as its frame is ready.
    // That is not a page turn, and should not make a restored book look newly opened.
    const previous = current.lastLocator && Locator.deserialize(current.lastLocator)?.serialize();
    if (current.progress === progress && previous && JSON.stringify(previous) === JSON.stringify(next)) return false;
    await db.books.put({ ...current, lastLocator: next, progress, lastOpenedAt: Date.now() });
    return true;
  });
}

export function subscribeLibraryChanges(listener: (bookId?: string) => void) {
  if (!("BroadcastChannel" in globalThis)) return () => undefined;
  const channel = new BroadcastChannel("better-epub-library");
  channel.addEventListener("message", (event) => listener(typeof event.data?.bookId === "string" ? event.data.bookId : undefined));
  return () => channel.close();
}

export function notifyLibraryChange(bookId?: string) {
  if (!("BroadcastChannel" in globalThis)) return;
  const channel = new BroadcastChannel("better-epub-library");
  channel.postMessage({ bookId, at: Date.now() });
  channel.close();
}

export async function getPreferences(bookId: string) {
  const stored = await db.preferences.get(bookId);
  return { bookId, ...DEFAULT_PREFERENCES, ...stored };
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function getStorageStatus() {
  const [estimate, persisted] = await Promise.all([
    navigator.storage?.estimate?.() ?? Promise.resolve({}),
    navigator.storage?.persisted?.() ?? Promise.resolve(false),
  ]);
  return {
    persisted,
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
  };
}
