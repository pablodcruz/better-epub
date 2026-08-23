import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EpubNavigator,
  EpubPreferences,
  TextAlignment as ReadiumTextAlignment,
  type EpubNavigatorListeners,
} from "@readium/navigator";
import { DecorationStyleType, type BasicTextSelection } from "@readium/navigator-html-injectables";
import { Link, Locator, type Publication } from "@readium/shared";
import {
  db,
  getPreferences,
  getStorageStatus,
  removeBook,
  requestPersistentStorage,
  saveImportedBook,
  subscribeLibraryChanges,
  notifyLibraryChange,
  updateBook,
} from "./lib/db";
import { importEpub } from "./lib/epub";
import { createPositions, createPublication, flattenToc } from "./lib/readium";
import { virtualResourceUrl } from "./lib/paths";
import {
  createAnnotationArchive,
  createAnnotationExport,
  importAnnotations,
  type AnnotationExportFormat,
} from "./lib/annotations";
import { createLibraryBackup, restoreLibraryBackup } from "./lib/backup";
import { extractFootnote, footnoteTarget, type FootnoteTarget } from "./lib/footnotes";
import { pageTurnForKey, pageTurnForSwipe, type PageTurn } from "./lib/navigation";
import { adjacentResourceLocator, loadSpeechSegments, type SpeechSegment } from "./lib/read-aloud";
import { findResourceMatches, type BookSearchResult } from "./lib/search";
import type {
  AnnotationRecord,
  BookRecord,
  ManifestLinkJson,
  ReaderPreferencesRecord,
  ReadingSessionRecord,
} from "./lib/types";

type AppRoute = { screen: "library" } | { screen: "reader"; bookId: string };
type StorageStatus = Awaited<ReturnType<typeof getStorageStatus>>;
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type ReadAloudStatus = "idle" | "loading" | "playing" | "paused";
type LibraryFilter = "all" | "unread" | "reading" | "finished";
type LibrarySort = "recent" | "title" | "author" | "progress";
interface CatalogBook {
  id: string;
  title: string;
  author: string;
  description: string;
  category: string;
  fileName: string;
  downloadUrl: string;
  pageUrl: string;
}

const FREE_BOOKS: CatalogBook[] = [
  { id: "dracula", title: "Dracula", author: "Bram Stoker", category: "Gothic horror", description: "Letters, journals, and newspaper clippings assemble a foundational vampire story.", fileName: "bram-stoker_dracula.epub", downloadUrl: "https://standardebooks.org/ebooks/bram-stoker/dracula/downloads/bram-stoker_dracula.epub?source=download", pageUrl: "https://standardebooks.org/ebooks/bram-stoker/dracula" },
  { id: "pride", title: "Pride and Prejudice", author: "Jane Austen", category: "Classic fiction", description: "A sharp comedy of manners about family, judgment, and unexpected affection.", fileName: "jane-austen_pride-and-prejudice.epub", downloadUrl: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download", pageUrl: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice" },
  { id: "dorian", title: "The Picture of Dorian Gray", author: "Oscar Wilde", category: "Gothic fiction", description: "A beautiful portrait bears the cost of its subject’s pursuit of eternal youth.", fileName: "oscar-wilde_the-picture-of-dorian-gray.epub", downloadUrl: "https://standardebooks.org/ebooks/oscar-wilde/the-picture-of-dorian-gray/downloads/oscar-wilde_the-picture-of-dorian-gray.epub?source=download", pageUrl: "https://standardebooks.org/ebooks/oscar-wilde/the-picture-of-dorian-gray" },
  { id: "sherlock", title: "The Adventures of Sherlock Holmes", author: "Arthur Conan Doyle", category: "Mystery", description: "Twelve cases showcase Holmes and Watson at their most observant and inventive.", fileName: "arthur-conan-doyle_the-adventures-of-sherlock-holmes.epub", downloadUrl: "https://standardebooks.org/ebooks/arthur-conan-doyle/the-adventures-of-sherlock-holmes/downloads/arthur-conan-doyle_the-adventures-of-sherlock-holmes.epub?source=download", pageUrl: "https://standardebooks.org/ebooks/arthur-conan-doyle/the-adventures-of-sherlock-holmes" },
  { id: "frankenstein", title: "Frankenstein", author: "Mary Shelley", category: "Science fiction", description: "An ambitious experiment gives life to a being its creator immediately rejects.", fileName: "mary-shelley_frankenstein.epub", downloadUrl: "https://standardebooks.org/ebooks/mary-shelley/frankenstein/downloads/mary-shelley_frankenstein.epub?source=download", pageUrl: "https://standardebooks.org/ebooks/mary-shelley/frankenstein" },
];

export default function App() {
  const [route, setRoute] = useState<AppRoute>({ screen: "library" });
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [sessions, setSessions] = useState<ReadingSessionRecord[]>([]);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [managingLibrary, setManagingLibrary] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>({ persisted: false, usage: 0, quota: 0 });
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const refresh = useCallback(async () => {
    const [nextBooks, nextStorage, nextSessions] = await Promise.all([
      db.books.orderBy("lastOpenedAt").reverse().toArray(),
      getStorageStatus(),
      db.sessions.orderBy("startedAt").reverse().limit(500).toArray(),
    ]);
    setBooks(nextBooks);
    setStorageStatus(nextStorage);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeLibraryChanges(() => void refresh()), [refresh]);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const handleImport = useCallback(async (files: FileList | File[]) => {
    const candidates = [...files].filter((file) => file.name.toLowerCase().endsWith(".epub"));
    if (candidates.length === 0) {
      setMessage("Choose an EPUB file to import.");
      return;
    }
    setImporting(true);
    setMessage("");
    try {
      const importedTitles: string[] = [];
      for (const file of candidates) {
        const imported = await importEpub(file);
        await saveImportedBook(imported.book, imported.resources);
        importedTitles.push(imported.book.title);
      }
      await requestPersistentStorage();
      await refresh();
      setMessage(`${candidates.length === 1 ? `“${importedTitles[0]}”` : `${candidates.length} books`} imported locally.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The EPUB could not be imported.");
    } finally {
      setImporting(false);
    }
  }, [refresh]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("shared") !== "1") return;
    window.history.replaceState({}, "", `${url.pathname}${url.hash}`);
    void consumeSharedEpubs().then((files) => {
      if (files.length) return handleImport(files);
      setMessage("No shared EPUB was found. Choose the file again to import it.");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "The shared EPUB could not be opened."));
  }, [handleImport]);

  const handleBackup = useCallback(async () => {
    setManagingLibrary(true);
    setMessage("");
    try {
      const backup = await createLibraryBackup();
      downloadBlob(backup.blob, backup.name);
      setMessage(`${backup.bookCount} ${backup.bookCount === 1 ? "book" : "books"} backed up with reading progress, history, preferences, and notes.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The library backup could not be created.");
    } finally {
      setManagingLibrary(false);
    }
  }, []);

  const handleRestore = useCallback(async (file: File) => {
    setManagingLibrary(true);
    setMessage("");
    try {
      const count = await restoreLibraryBackup(file);
      await requestPersistentStorage();
      await refresh();
      setMessage(`${count} ${count === 1 ? "book" : "books"} restored with reading progress, history, preferences, and notes.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The library backup could not be restored.");
    } finally {
      setManagingLibrary(false);
    }
  }, [refresh]);

  const openBook = useCallback(async (bookId: string) => {
    await updateBook(bookId, { lastOpenedAt: Date.now() });
    setRoute({ screen: "reader", bookId });
  }, []);

  const handleDelete = useCallback(async (book: BookRecord) => {
    if (!window.confirm(`Remove “${book.title}” and its local notes?`)) return;
    await removeBook(book.id);
    await refresh();
  }, [refresh]);

  if (route.screen === "reader") {
    const book = books.find((candidate) => candidate.id === route.bookId);
    if (!book) {
      return <LoadingScreen label="Opening book…" />;
    }
    return (
      <ReaderView
        book={book}
        onBack={() => {
          setRoute({ screen: "library" });
          void refresh();
        }}
      />
    );
  }

  return (
    <LibraryView
      books={books}
      sessions={sessions}
      importing={importing}
      message={message}
      storageStatus={storageStatus}
      onImport={handleImport}
      onOpen={openBook}
      onDelete={handleDelete}
      canInstall={installPrompt !== null}
      onInstall={async () => {
        if (!installPrompt) return;
        await installPrompt.prompt();
        await installPrompt.userChoice;
        setInstallPrompt(null);
      }}
      onPersist={async () => {
        await requestPersistentStorage();
        await refresh();
      }}
      managingLibrary={managingLibrary}
      onBackup={handleBackup}
      onRestore={handleRestore}
    />
  );
}

function LibraryView({
  books,
  sessions,
  importing,
  message,
  storageStatus,
  onImport,
  onOpen,
  onDelete,
  canInstall,
  onInstall,
  onPersist,
  managingLibrary,
  onBackup,
  onRestore,
}: {
  books: BookRecord[];
  sessions: ReadingSessionRecord[];
  importing: boolean;
  message: string;
  storageStatus: StorageStatus;
  onImport: (files: FileList | File[]) => void | Promise<void>;
  onOpen: (bookId: string) => void;
  onDelete: (book: BookRecord) => void;
  canInstall: boolean;
  onInstall: () => void;
  onPersist: () => void;
  managingLibrary: boolean;
  onBackup: () => void;
  onRestore: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("recent");
  const [discovering, setDiscovering] = useState(false);
  const [catalogImporting, setCatalogImporting] = useState("");
  const [catalogMessage, setCatalogMessage] = useState("");
  const visibleBooks = useMemo(() => {
    const needle = libraryQuery.trim().toLocaleLowerCase();
    const filtered = books.filter((book) => {
      if (needle && !`${book.title} ${book.author}`.toLocaleLowerCase().includes(needle)) return false;
      if (libraryFilter === "unread") return book.progress <= 0;
      if (libraryFilter === "reading") return book.progress > 0 && book.progress < 0.98;
      if (libraryFilter === "finished") return book.progress >= 0.98;
      return true;
    });
    return [...filtered].sort((left, right) => {
      if (librarySort === "title") return left.title.localeCompare(right.title);
      if (librarySort === "author") return left.author.localeCompare(right.author);
      if (librarySort === "progress") return right.progress - left.progress;
      return right.lastOpenedAt - left.lastOpenedAt;
    });
  }, [books, libraryFilter, libraryQuery, librarySort]);
  const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const readingMinutes = Math.round(sessions.filter((session) => session.endedAt >= weekStart).reduce((total, session) => total + Math.min(6 * 60 * 60 * 1_000, Math.max(0, session.endedAt - session.startedAt)), 0) / 60_000);
  const inProgress = books.filter((book) => book.progress > 0 && book.progress < 0.98).length;
  const finished = books.filter((book) => book.progress >= 0.98).length;

  const importCatalogBook = async (catalogBook: CatalogBook) => {
    setCatalogImporting(catalogBook.id);
    setCatalogMessage(`Downloading “${catalogBook.title}”…`);
    try {
      const response = await fetch(catalogBook.downloadUrl);
      if (!response.ok) throw new Error(`The provider returned ${response.status}.`);
      const blob = await response.blob();
      if (blob.size > 250 * 1024 * 1024) throw new Error("This EPUB exceeds the 250 MB import limit.");
      await onImport([new File([blob], catalogBook.fileName, { type: "application/epub+zip" })]);
      setCatalogMessage(`“${catalogBook.title}” is now in your local library.`);
    } catch (reason) {
      setCatalogMessage(reason instanceof Error ? reason.message : "The free book could not be imported.");
    } finally {
      setCatalogImporting("");
    }
  };

  return (
    <div className="app-shell library-shell">
      <header className="library-header">
        <Brand />
        <div className="library-actions">
          <button className="secondary-button" type="button" onClick={() => setDiscovering(true)}>
            <Icon name="compass" /> Discover
          </button>
          {canInstall && (
            <button className="secondary-button" type="button" onClick={onInstall}>
              <Icon name="download" /> Install app
            </button>
          )}
          {books.length > 0 && (
            <button className="secondary-button" type="button" onClick={onBackup} disabled={managingLibrary || importing}>
              <Icon name="download" /> Backup
            </button>
          )}
          <button className="secondary-button" type="button" onClick={() => restoreInputRef.current?.click()} disabled={managingLibrary || importing}>
            <Icon name="upload" /> {managingLibrary ? "Working…" : "Restore"}
          </button>
          <button className="primary-button" type="button" onClick={() => inputRef.current?.click()} disabled={importing || managingLibrary}>
            <Icon name="plus" /> {importing ? "Importing…" : "Import EPUB"}
          </button>
        </div>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          aria-label="Choose EPUB files"
          accept=".epub,application/epub+zip"
          multiple
          onChange={(event) => event.target.files && onImport(event.target.files)}
        />
        <input
          ref={restoreInputRef}
          className="visually-hidden"
          type="file"
          aria-label="Restore Better ePub library backup"
          accept=".betterepub-backup,application/zip"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onRestore(file);
          }}
        />
      </header>

      <main className="library-main">
        <section className="library-intro" aria-labelledby="library-heading">
          <div>
            <p className="eyebrow">YOUR PRIVATE READING SPACE</p>
            <h1 id="library-heading">Your library</h1>
            <p>Books stay in this browser. Nothing is uploaded.</p>
          </div>
          <StorageBadge status={storageStatus} onPersist={onPersist} />
        </section>

        {message && <p className="status-message" role="status">{message}</p>}

        {books.length > 0 && <section className="reading-overview" aria-label="Reading overview">
          <div><span>{inProgress}</span><small>In progress</small></div>
          <div><span>{readingMinutes}</span><small>Minutes this week</small></div>
          <div><span>{finished}</span><small>Finished</small></div>
        </section>}

        {books.length === 0 ? (
          <section
            className={`drop-zone ${dragging ? "is-dragging" : ""}`}
            aria-label="Import an EPUB"
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              onImport(event.dataTransfer.files);
            }}
          >
            <span className="drop-icon"><Icon name="book" /></span>
            <h2>Bring your own books</h2>
            <p>Drop DRM-free EPUB 2 or EPUB 3 files here.</p>
            <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
              Choose files
            </button>
            <button className="text-button" type="button" onClick={() => setDiscovering(true)}>Or discover a free classic</button>
          </section>
        ) : (
          <section aria-label="Imported books">
            <div className="section-heading">
              <h2>Continue reading</h2>
              <span>{books.length} {books.length === 1 ? "book" : "books"}</span>
            </div>
            <div className="library-controls">
              <label className="library-search"><Icon name="search" /><span className="visually-hidden">Search your library</span><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search title or author" /></label>
              <div className="library-filter" role="group" aria-label="Filter library">{(["all", "unread", "reading", "finished"] as const).map((filter) => <button key={filter} type="button" aria-pressed={libraryFilter === filter} onClick={() => setLibraryFilter(filter)}>{filter}</button>)}</div>
              <label className="library-sort"><span className="visually-hidden">Sort library</span><select value={librarySort} onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}><option value="recent">Recently opened</option><option value="title">Title</option><option value="author">Author</option><option value="progress">Progress</option></select></label>
            </div>
            {visibleBooks.length === 0 ? <div className="empty-library-filter"><h3>No books found</h3><p>Try a different search or reading status.</p><button className="secondary-button" type="button" onClick={() => { setLibraryQuery(""); setLibraryFilter("all"); }}>Clear filters</button></div> :
            <div className="book-grid">
              {visibleBooks.map((book) => (
                <BookCard key={book.id} book={book} onOpen={() => onOpen(book.id)} onDelete={() => onDelete(book)} />
              ))}
              <button className="add-book-card" type="button" onClick={() => inputRef.current?.click()}>
                <Icon name="plus" />
                <span>Add another book</span>
              </button>
            </div>}
          </section>
        )}
      </main>
      {discovering && <div className="modal-backdrop discovery-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !catalogImporting) setDiscovering(false); }}>
        <section className="discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="discovery-title">
          <div className="discovery-heading"><div><p className="eyebrow">PUBLIC-DOMAIN STARTER SHELF</p><h2 id="discovery-title">Discover a classic</h2><p>Import a carefully produced EPUB directly into this browser.</p></div><button autoFocus className="icon-button" type="button" disabled={!!catalogImporting} onClick={() => setDiscovering(false)} aria-label="Close discovery"><Icon name="close" /></button></div>
          {catalogMessage && <p className="status-message" role="status">{catalogMessage}</p>}
          <div className="discovery-grid">{FREE_BOOKS.map((catalogBook, index) => <article key={catalogBook.id} className={`discovery-card discovery-tone-${index + 1}`}>
            <div className="discovery-cover"><span>{catalogBook.title}</span></div>
            <div><small>{catalogBook.category}</small><h3>{catalogBook.title}</h3><p className="discovery-author">{catalogBook.author}</p><p>{catalogBook.description}</p><div className="discovery-actions"><button className="primary-button" type="button" disabled={!!catalogImporting} onClick={() => void importCatalogBook(catalogBook)}>{catalogImporting === catalogBook.id ? "Importing…" : "Import free EPUB"}</button><a href={catalogBook.pageUrl} target="_blank" rel="noreferrer">Details</a></div></div>
          </article>)}</div>
          <p className="catalog-credit">Books are provided by <a href="https://standardebooks.org/" target="_blank" rel="noreferrer">Standard Ebooks</a>, which publishes free, carefully formatted public-domain editions. Copyright status can differ by country; check your local law before downloading.</p>
        </section>
      </div>}
    </div>
  );
}

function BookCard({ book, onOpen, onDelete }: { book: BookRecord; onOpen: () => void; onDelete: () => void }) {
  const coverUrl = useCoverUrl(book);
  const sourceUrl = useSourceUrl(book);
  return (
    <article className="book-card">
      <button className="book-open" type="button" onClick={onOpen} aria-label={`Open ${book.title}`}>
        <div className="book-cover">
          {coverUrl ? <img src={coverUrl} alt="" /> : <div className="generated-cover"><span>{book.title}</span></div>}
        </div>
        <div className="book-copy">
          <strong>{book.title}</strong>
          <span>{book.author}</span>
          <div className="progress-track" aria-label={`${Math.round(book.progress * 100)}% complete`}>
            <span style={{ width: `${Math.round(book.progress * 100)}%` }} />
          </div>
          <small>{book.progress ? `${Math.round(book.progress * 100)}% complete` : "Ready to read"} · {relativeTime(book.lastOpenedAt)}</small>
        </div>
      </button>
      <div className="card-actions">
        {sourceUrl && (
          <a className="icon-button" href={sourceUrl} download={`${safeFileName(book.title)}.epub`} aria-label={`Download original ${book.title}`}>
            <Icon name="download" />
          </a>
        )}
        <button className="icon-button" type="button" onClick={onDelete} aria-label={`Remove ${book.title}`}><Icon name="trash" /></button>
      </div>
    </article>
  );
}

function ReaderView({ book, onBack }: { book: BookRecord; onBack: () => void }) {
  const navigatorContainer = useRef<HTMLDivElement>(null);
  const navigatorRef = useRef<EpubNavigator | null>(null);
  const publicationRef = useRef<Publication | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const readerInputHandlers = useRef<{
    keyDown: (event: KeyboardEvent) => void;
    pointerDown: (event: Pick<PointerEvent, "clientX" | "clientY">) => void;
    pointerUp: (event: Pick<PointerEvent, "clientX" | "clientY">) => void;
    linkClick: (anchor: HTMLAnchorElement, currentPath: string) => boolean;
  }>({
    keyDown: () => undefined,
    pointerDown: () => undefined,
    pointerUp: () => undefined,
    linkClick: () => false,
  });
  const speechSessionRef = useRef(0);
  const speechQueueRef = useRef<SpeechSegment[]>([]);
  const speechIndexRef = useRef(0);
  const progressRef = useRef(book.progress);
  const [preferences, setPreferences] = useState<ReaderPreferencesRecord | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [selection, setSelection] = useState<BasicTextSelection | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [selectionColor, setSelectionColor] = useState<NonNullable<AnnotationRecord["color"]>>("yellow");
  const [selectionTags, setSelectionTags] = useState("");
  const [panel, setPanel] = useState<"toc" | "notes" | "appearance" | "search" | null>("toc");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BookSearchResult[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [currentLocator, setCurrentLocator] = useState<Locator | null>(null);
  const [navigationHistory, setNavigationHistory] = useState<ReturnType<Locator["serialize"]>[]>([]);
  const [immersive, setImmersive] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [footnote, setFootnote] = useState<{ title: string; text: string } | null>(null);
  const [rulerY, setRulerY] = useState(0);
  const [readAloudStatus, setReadAloudStatus] = useState<ReadAloudStatus>("idle");
  const [speechSegment, setSpeechSegment] = useState<SpeechSegment | null>(null);
  const [speechRate, setSpeechRate] = useState(1);
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechVoiceUri, setSpeechVoiceUri] = useState("");

  useEffect(() => {
    const session: ReadingSessionRecord = {
      id: crypto.randomUUID(),
      bookId: book.id,
      startedAt: Date.now(),
      endedAt: Date.now(),
      startProgress: book.progress,
      endProgress: book.progress,
    };
    const persist = () => {
      session.endedAt = Date.now();
      session.endProgress = progressRef.current;
      if (session.endedAt - session.startedAt < 5_000) return;
      void db.sessions.put({ ...session }).then(() => notifyLibraryChange(book.id));
    };
    const handleVisibility = () => { if (document.visibilityState === "hidden") persist(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, [book.id]);

  useEffect(() => {
    void Promise.all([
      getPreferences(book.id),
      db.annotations.where("bookId").equals(book.id).sortBy("createdAt"),
    ]).then(([storedPreferences, storedAnnotations]) => {
      setPreferences(storedPreferences);
      setAnnotations(storedAnnotations);
    });
  }, [book.id]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const refreshVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setSpeechVoices(voices);
      setSpeechVoiceUri((current) => current || voices.find((voice) => voice.default)?.voiceURI || voices[0]?.voiceURI || "");
    };
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
  }, []);

  useEffect(() => () => {
    speechSessionRef.current += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [book.id]);

  useEffect(() => {
    let disposed = false;
    void countBookWords(book).then((count) => {
      if (!disposed) setWordCount(count);
    });
    return () => { disposed = true; };
  }, [book.id]);

  useEffect(() => {
    if (!preferences || !navigatorContainer.current) return;
    let disposed = false;
    let saveTimer = 0;

    const mount = async () => {
      try {
        await ensureServiceWorkerControl();
        const publication = createPublication(book);
        publicationRef.current = publication;
        const positions = createPositions(book);
        const initialPosition = book.lastLocator ? Locator.deserialize(book.lastLocator) : positions[0];
        const wiredDocuments = new WeakSet<Document>();
        const labelFrames = () => {
          navigatorContainer.current?.querySelectorAll("iframe").forEach((frame, index) => {
            frame.title = `${book.title} — reading frame ${index + 1}`;
            const document = frame.contentDocument;
            if (!document || wiredDocuments.has(document)) return;
            wiredDocuments.add(document);
            document.addEventListener("keydown", (event) => readerInputHandlers.current.keyDown(event), true);
            document.addEventListener("pointerdown", (event) => readerInputHandlers.current.pointerDown(event), true);
            document.addEventListener("pointerup", (event) => readerInputHandlers.current.pointerUp(event), true);
            document.addEventListener("click", (event) => {
              const target = event.target instanceof Element ? event.target.closest("a") : null;
              if (!target || target.tagName.toLowerCase() !== "a") return;
              const currentPath = framePublicationPath(frame.src, book.id);
              if (!currentPath || !readerInputHandlers.current.linkClick(target as HTMLAnchorElement, currentPath)) return;
              event.preventDefault();
              event.stopImmediatePropagation();
            }, true);
          });
        };
        const listeners: EpubNavigatorListeners = {
          frameLoaded: labelFrames,
          positionChanged: (locator) => {
            if (disposed) return;
            setCurrentLocator(locator);
            window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(() => {
              const progress = locator.locations.totalProgression
                ?? Math.max(0, (locator.locations.position ?? 1) - 1) / Math.max(positions.length, 1);
              progressRef.current = Math.min(1, Math.max(0, progress));
              void updateBook(book.id, {
                lastLocator: locator.serialize(),
                progress: Math.min(1, Math.max(0, progress)),
                lastOpenedAt: Date.now(),
              });
            }, 250);
          },
          timelineItemChanged: () => undefined,
          tap: () => false,
          click: () => false,
          zoom: () => undefined,
          miscPointer: () => setImmersive((current) => {
            const next = !current;
            if (next) setPanel(null);
            return next;
          }),
          scroll: () => undefined,
          customEvent: () => undefined,
          handleLocator: () => false,
          textSelected: (nextSelection) => {
            setSelection(nextSelection.text.trim() ? nextSelection : null);
            setNoteDraft("");
            setSelectionTags("");
            setSelectionColor("yellow");
          },
          contentProtection: () => undefined,
          contextMenu: () => undefined,
          peripheral: () => undefined,
        };
        const navigator = new EpubNavigator(
          navigatorContainer.current!,
          publication,
          listeners,
          positions,
          initialPosition,
          {
            preferences: toReadiumPreferences(preferences),
            defaults: {
              optimalLineLength: 68,
              minimalLineLength: 42,
              maximalLineLength: 82,
              selectionBackgroundColor: "#f1d76a",
              selectionTextColor: "#1f2923",
            },
            contentProtection: { monitorSelection: true },
          },
        );
        navigatorRef.current = navigator;
        await navigator.load();
        labelFrames();
        if (!disposed) {
          setCurrentLocator(navigator.currentLocator);
          setLoading(false);
        }
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "The book could not be opened.");
          setLoading(false);
        }
      }
    };

    void mount();
    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      const navigator = navigatorRef.current;
      navigatorRef.current = null;
      publicationRef.current = null;
      if (navigator) void navigator.destroy();
    };
  }, [book.id, preferences?.bookId]);

  useEffect(() => {
    const navigator = navigatorRef.current;
    if (!navigator || !preferences) return;
    void navigator.submitPreferences(new EpubPreferences(toReadiumPreferences(preferences)));
  }, [preferences]);

  useEffect(() => {
    const navigator = navigatorRef.current;
    if (!navigator) return;
    const decorations = annotations
      .filter((annotation) => annotation.type === "highlight" || annotation.type === "note")
      .map((annotation) => {
        const locator = Locator.deserialize(annotation.locator);
        return locator ? {
          id: annotation.id,
          locator,
          style: {
            type: DecorationStyleType.Highlight,
            tint: annotationColor(annotation.color),
            enforceContrast: true,
          },
        } : null;
      })
      .filter((decoration) => decoration !== null);
    navigator.applyDecorations(decorations, "annotations");
  }, [annotations, loading]);

  useEffect(() => {
    const navigator = navigatorRef.current;
    if (!navigator) return;
    const decorations = searchResults.flatMap((result) => {
      const locator = Locator.deserialize(result.locator);
      return locator ? [{
        id: result.id,
        locator,
        style: {
          type: DecorationStyleType.HighlightUnderline,
          tint: "#7bbf96",
          enforceContrast: true,
        },
      }] : [];
    });
    navigator.applyDecorations(decorations, "search-results");
  }, [searchResults, loading]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button, [contenteditable='true']")) return;
      const pageTurn = pageTurnForKey(event.key, book.manifest.metadata.readingProgression === "rtl");
      if (pageTurn) {
        event.preventDefault();
        turnPage(pageTurn);
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        void addBookmark();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setImmersive(false);
        setPanel("search");
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        void startReadAloud();
      } else if (event.key === "Escape") {
        setImmersive(false);
        setFootnote(null);
        setSelection(null);
      }
    };
    readerInputHandlers.current.keyDown = handleKeyDown;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const updatePreferences = async (patch: Partial<ReaderPreferencesRecord>) => {
    if (!preferences) return;
    const accessibilityPatch = patch.screenReaderMode
      ? { flow: "scrolled" as const, columnCount: 1 as const }
      : {};
    const next = { ...preferences, ...patch, ...accessibilityPatch };
    setPreferences(next);
    await db.preferences.put(next);
  };

  const addSelectionAnnotation = async (type: "highlight" | "note") => {
    if (!selection?.locator) return;
    const now = Date.now();
    const annotation: AnnotationRecord = {
      id: crypto.randomUUID(),
      bookId: book.id,
      type,
      locator: selection.locator.serialize(),
      quote: selection.text,
      note: noteDraft.trim() || undefined,
      color: selectionColor,
      tags: parseTags(selectionTags),
      createdAt: now,
      updatedAt: now,
    };
    await db.annotations.put(annotation);
    setAnnotations((current) => [...current, annotation]);
    setSelection(null);
    setNoteDraft("");
    setSelectionTags("");
    setPanel("notes");
  };

  const addBookmark = async () => {
    const locator = navigatorRef.current?.currentLocator ?? currentLocator;
    if (!locator) return;
    const now = Date.now();
    const annotation: AnnotationRecord = {
      id: crypto.randomUUID(),
      bookId: book.id,
      type: "bookmark",
      locator: locator.serialize(),
      createdAt: now,
      updatedAt: now,
    };
    await db.annotations.put(annotation);
    setAnnotations((current) => [...current, annotation]);
  };

  const deleteAnnotation = async (id: string) => {
    await db.annotations.delete(id);
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  };

  const editAnnotation = async (id: string, patch: Pick<AnnotationRecord, "note" | "color" | "tags">) => {
    const annotation = annotations.find((candidate) => candidate.id === id);
    if (!annotation) return;
    const next = { ...annotation, ...patch, updatedAt: Date.now() };
    await db.annotations.put(next);
    setAnnotations((current) => current.map((candidate) => candidate.id === id ? next : candidate));
  };

  const handleAnnotationImport = async (file: File) => {
    try {
      const imported = await importAnnotations(file, book);
      await db.annotations.bulkPut(imported);
      setAnnotations((current) => [...current, ...imported]);
      setNotice(`${imported.length} ${imported.length === 1 ? "annotation" : "annotations"} imported.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "The annotations could not be imported.");
    }
  };

  const openFootnote = async (target: FootnoteTarget) => {
    const resource = await db.resources.get([book.id, target.path]);
    if (!resource) return;
    const extracted = await extractFootnote(resource.blob, resource.mediaType, target.fragment);
    if (extracted) setFootnote(extracted);
  };

  readerInputHandlers.current.linkClick = (anchor, currentPath) => {
    const target = footnoteTarget(anchor, currentPath);
    if (!target) return false;
    void openFootnote(target);
    return true;
  };

  const clearSpeechHighlight = () => navigatorRef.current?.applyDecorations([], "read-aloud");

  const stopReadAloud = () => {
    speechSessionRef.current += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    speechIndexRef.current = 0;
    setReadAloudStatus("idle");
    setSpeechSegment(null);
    clearSpeechHighlight();
  };

  const speakAt = async (index: number, session: number): Promise<void> => {
    if (session !== speechSessionRef.current || !("speechSynthesis" in window)) return;
    let queue = speechQueueRef.current;
    if (index >= queue.length) {
      const currentHref = queue.at(-1)?.locator.href ?? navigatorRef.current?.currentLocator?.href;
      const publication = publicationRef.current;
      const nextLocator = currentHref ? adjacentResourceLocator(book, currentHref, 1) : undefined;
      if (!publication || !nextLocator) {
        stopReadAloud();
        return;
      }
      setReadAloudStatus("loading");
      queue = await loadSpeechSegments(publication, book, nextLocator);
      if (session !== speechSessionRef.current || !queue.length) {
        stopReadAloud();
        return;
      }
      speechQueueRef.current = queue;
      index = 0;
    }
    const segment = queue[Math.max(0, index)];
    if (!segment) return;
    speechIndexRef.current = Math.max(0, index);
    setSpeechSegment(segment);
    setReadAloudStatus("playing");
    navigatorRef.current?.go(segment.locator, !preferences?.reduceMotion, () => undefined);
    navigatorRef.current?.applyDecorations([{
      id: segment.id,
      locator: segment.locator,
      style: { type: DecorationStyleType.HighlightUnderline, tint: "#e28c3a", enforceContrast: true },
    }], "read-aloud");
    const utterance = new SpeechSynthesisUtterance(segment.text);
    utterance.rate = speechRate;
    utterance.lang = segment.language || book.language || "";
    utterance.voice = speechVoices.find((voice) => voice.voiceURI === speechVoiceUri) ?? null;
    utterance.onend = () => {
      if (session === speechSessionRef.current) void speakAt(speechIndexRef.current + 1, session);
    };
    utterance.onerror = (event) => {
      if (session === speechSessionRef.current && event.error !== "canceled" && event.error !== "interrupted") {
        setNotice("Read aloud stopped because the system voice could not continue.");
        stopReadAloud();
      }
    };
    window.speechSynthesis.speak(utterance);
  };

  const startReadAloud = async () => {
    if (!("speechSynthesis" in window)) {
      setNotice("Read aloud is not supported by this browser.");
      return;
    }
    if (readAloudStatus === "playing") {
      window.speechSynthesis.pause();
      setReadAloudStatus("paused");
      return;
    }
    if (readAloudStatus === "paused") {
      window.speechSynthesis.resume();
      setReadAloudStatus("playing");
      return;
    }
    const publication = publicationRef.current;
    const locator = navigatorRef.current?.currentLocator ?? currentLocator;
    if (!publication || !locator) return;
    const session = speechSessionRef.current + 1;
    speechSessionRef.current = session;
    window.speechSynthesis.cancel();
    setReadAloudStatus("loading");
    const queue = await loadSpeechSegments(publication, book, locator);
    if (session !== speechSessionRef.current) return;
    if (!queue.length) {
      setNotice("No readable text was found in this section.");
      stopReadAloud();
      return;
    }
    speechQueueRef.current = queue;
    await speakAt(0, session);
  };

  const skipSpeech = (delta: -1 | 1) => {
    if (!speechQueueRef.current.length) return;
    const session = speechSessionRef.current + 1;
    speechSessionRef.current = session;
    window.speechSynthesis.cancel();
    void speakAt(Math.max(0, speechIndexRef.current + delta), session);
  };

  const navigateToLocator = (locator: Locator, remember = true) => {
    const navigator = navigatorRef.current;
    if (!navigator) return;
    if (remember) {
      const previous = navigator.currentLocator ?? currentLocator;
      if (previous) setNavigationHistory((history) => [...history.slice(-18), previous.serialize()]);
    }
    navigator.go(locator, !preferences?.reduceMotion, () => undefined);
  };

  const returnToPreviousLocation = () => {
    const previous = navigationHistory.at(-1);
    const locator = previous ? Locator.deserialize(previous) : undefined;
    if (!locator) return;
    setNavigationHistory((history) => history.slice(0, -1));
    navigateToLocator(locator, false);
  };

  const goToHref = (href: string, title?: string) => {
    const publication = publicationRef.current;
    if (!publication) return;
    const source = flattenToc(book.manifest.toc).find((item) => item.href === href)
      ?? book.manifest.readingOrder.find((item) => item.href === href || href.startsWith(`${item.href}#`));
    const link = Link.deserialize({ href, type: source?.type || "application/xhtml+xml", title: title || source?.title });
    if (link) navigateToLocator(link.locator);
  };

  const runSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const results: BookSearchResult[] = [];
    for (const [index, item] of book.manifest.readingOrder.entries()) {
      const path = item.href.split("#", 1)[0];
      const record = await db.resources.get([book.id, path]);
      if (!record || !record.mediaType.includes("html")) continue;
      const document = new DOMParser().parseFromString(await record.blob.text(), record.mediaType as DOMParserSupportedType);
      document.querySelectorAll("script, style, nav").forEach((element) => element.remove());
      const text = document.body?.textContent || "";
      results.push(...findResourceMatches({
        href: item.href.split("#", 1)[0],
        type: item.type || "application/xhtml+xml",
        title: item.title || chapterTitle(book, item.href, index),
        text,
        spineIndex: index,
        spineLength: book.manifest.readingOrder.length,
      }, needle, 50 - results.length));
      if (results.length >= 50) break;
    }
    setSearchResults(results);
    setActiveSearchIndex(results.length ? 0 : -1);
    setSearching(false);
  };

  const navigateSearchResult = (index: number) => {
    if (!searchResults.length) return;
    const boundedIndex = (index + searchResults.length) % searchResults.length;
    const locator = Locator.deserialize(searchResults[boundedIndex].locator);
    if (!locator) return;
    setActiveSearchIndex(boundedIndex);
    navigateToLocator(locator);
  };

  const progress = currentLocator?.locations.totalProgression
    ?? Math.max(0, (currentLocator?.locations.position ?? 1) - 1) / Math.max(book.manifest.readingOrder.length, 1);
  const rightToLeft = book.manifest.metadata.readingProgression === "rtl";
  const remainingMinutes = wordCount > 0 ? Math.max(1, Math.ceil((wordCount * (1 - progress)) / 225)) : 0;
  const seekToProgress = (nextProgress: number) => {
    const items = book.manifest.readingOrder;
    if (!items.length) return;
    const bounded = Math.min(0.999999, Math.max(0, nextProgress));
    const exactIndex = bounded * items.length;
    const index = Math.min(items.length - 1, Math.floor(exactIndex));
    const item = items[index];
    const locator = Locator.deserialize({
      href: item.href.split("#", 1)[0],
      type: item.type || "application/xhtml+xml",
      title: item.title || chapterTitle(book, item.href, index),
      locations: { progression: exactIndex - index, totalProgression: bounded, position: index + 1 },
    });
    if (locator) navigateToLocator(locator);
  };
  const turnPage = (direction: PageTurn) => {
    if (direction === "forward") navigatorRef.current?.goForward(!preferences?.reduceMotion, () => undefined);
    else navigatorRef.current?.goBackward(!preferences?.reduceMotion, () => undefined);
  };
  const handlePointerDown = (event: Pick<PointerEvent, "clientX" | "clientY">) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };
  const handlePointerUp = (event: Pick<PointerEvent, "clientX" | "clientY">) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    const turn = pageTurnForSwipe(event.clientX - start.x, event.clientY - start.y, rightToLeft);
    if (turn) turnPage(turn);
  };
  readerInputHandlers.current.pointerDown = handlePointerDown;
  readerInputHandlers.current.pointerUp = handlePointerUp;

  return (
    <div className={`reader-app theme-${preferences?.theme ?? "paper"} ${immersive ? "is-immersive" : ""} ${preferences?.reduceMotion ? "reduce-motion" : ""} ${preferences?.screenReaderMode ? "screen-reader-mode" : ""}`}>
      <header className="reader-header">
        <button className="icon-button" type="button" onClick={onBack} aria-label="Back to library"><Icon name="back" /></button>
        <div className="reader-title"><strong>{book.title}</strong><span>{book.author}</span></div>
        <div className="reader-tools" role="toolbar" aria-label="Reading tools">
          <ToolButton icon="list" label="Contents" active={panel === "toc"} onClick={() => setPanel(panel === "toc" ? null : "toc")} />
          <ToolButton icon="search" label="Search" active={panel === "search"} onClick={() => setPanel(panel === "search" ? null : "search")} />
          <ToolButton icon="note" label="Notes" active={panel === "notes"} onClick={() => setPanel(panel === "notes" ? null : "notes")} />
          <ToolButton icon="speaker" label="Listen" active={readAloudStatus !== "idle"} onClick={() => void startReadAloud()} />
          <ToolButton icon="text" label="Appearance" active={panel === "appearance"} onClick={() => setPanel(panel === "appearance" ? null : "appearance")} />
          <ToolButton icon="bookmark" label="Bookmark" active={false} onClick={() => void addBookmark()} />
        </div>
      </header>

      <div className={`reader-layout ${panel ? "has-panel" : ""}`}>
        {panel && (
          <aside className="reader-panel" aria-label={panelLabel(panel)}>
            <div className="panel-heading"><h2>{panelLabel(panel)}</h2><button className="icon-button" type="button" onClick={() => setPanel(null)} aria-label="Close panel"><Icon name="close" /></button></div>
            {panel === "toc" && <TocPanel items={book.manifest.toc} readingOrder={book.manifest.readingOrder} onNavigate={goToHref} />}
            {panel === "notes" && <NotesPanel annotations={annotations} notice={notice} onNavigate={(annotation) => {
              const locator = Locator.deserialize(annotation.locator);
              if (locator) navigateToLocator(locator);
            }} onDelete={deleteAnnotation} onEdit={editAnnotation} onImport={handleAnnotationImport} book={book} />}
            {panel === "appearance" && preferences && <AppearancePanel preferences={preferences} onChange={updatePreferences} />}
            {panel === "search" && <SearchPanel query={query} results={searchResults} activeIndex={activeSearchIndex} searching={searching} onQuery={setQuery} onSubmit={runSearch} onNavigate={(index) => navigateSearchResult(index)} />}
          </aside>
        )}

        <main
          className="reader-stage"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerMove={(event) => preferences?.readingRuler && setRulerY(event.clientY - event.currentTarget.getBoundingClientRect().top)}
        >
          {loading && <LoadingScreen label="Preparing your book…" compact />}
          {error && <div className="reader-error" role="alert"><h2>This book could not be opened</h2><p>{error}</p><button className="secondary-button" type="button" onClick={onBack}>Return to library</button></div>}
          <div ref={navigatorContainer} className="readium-container" role="region" aria-label={`Reading ${book.title}`} />
          {preferences?.readingRuler && rulerY > 0 && <div className="reading-ruler" style={{ top: rulerY }} aria-hidden="true" />}
          {!loading && !error && (
            <>
              <button className="page-control page-previous" type="button" onClick={() => turnPage(rightToLeft ? "forward" : "backward")} aria-label={rightToLeft ? "Next page" : "Previous page"}><Icon name="chevron-left" /></button>
              <button className="page-control page-next" type="button" onClick={() => turnPage(rightToLeft ? "backward" : "forward")} aria-label={rightToLeft ? "Previous page" : "Next page"}><Icon name="chevron-right" /></button>
            </>
          )}
        </main>
      </div>

      <footer className="reader-footer">
        <span>{currentLocator?.title || chapterTitle(book, currentLocator?.href)}</span>
        <ProgressScrubber progress={progress} onSeek={seekToProgress} />
        <div className="reader-footer-actions">
          {navigationHistory.length > 0 && <button type="button" className="flow-toggle" onClick={returnToPreviousLocation}><Icon name="return" /> Return</button>}
          {remainingMinutes > 0 && <span className="remaining-time">{remainingMinutes} min left</span>}
          <button type="button" className="flow-toggle" onClick={() => preferences && void updatePreferences({ flow: preferences.flow === "paginated" ? "scrolled" : "paginated" })}>
            <Icon name={preferences?.flow === "scrolled" ? "scroll" : "pages"} /> {preferences?.flow === "scrolled" ? "Continuous" : "Pages"}
          </button>
        </div>
      </footer>

      {readAloudStatus !== "idle" && (
        <div className="read-aloud-bar" role="region" aria-label="Read aloud controls">
          <button className="icon-button" type="button" onClick={() => skipSpeech(-1)} aria-label="Previous sentence"><Icon name="previous" /></button>
          <button className="read-aloud-play" type="button" onClick={() => void startReadAloud()} disabled={readAloudStatus === "loading"}>
            <Icon name={readAloudStatus === "playing" ? "pause" : "play"} /> {readAloudStatus === "loading" ? "Preparing…" : readAloudStatus === "playing" ? "Pause" : "Resume"}
          </button>
          <button className="icon-button" type="button" onClick={() => skipSpeech(1)} aria-label="Next sentence"><Icon name="next" /></button>
          <span className="speech-preview">{speechSegment?.text}</span>
          <label>Speed<select value={speechRate} onChange={(event) => setSpeechRate(Number(event.target.value))}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
          <label>Voice<select value={speechVoiceUri} onChange={(event) => setSpeechVoiceUri(event.target.value)}>{speechVoices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}</select></label>
          <button className="icon-button" type="button" onClick={stopReadAloud} aria-label="Stop read aloud"><Icon name="stop" /></button>
        </div>
      )}

      {selection?.locator && (
        <div className="selection-bar" role="dialog" aria-label="Save selected text">
          <blockquote>{selection.text}</blockquote>
          <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add an optional note" aria-label="Annotation note" />
          <div className="selection-options">
            <ColorPicker value={selectionColor} onChange={setSelectionColor} />
            <label><span className="visually-hidden">Tags, separated by commas</span><input value={selectionTags} onChange={(event) => setSelectionTags(event.target.value)} placeholder="Tags: research, quote" /></label>
          </div>
          <div className="selection-actions">
            <button className="secondary-button" type="button" onClick={() => void addSelectionAnnotation("highlight")}>Highlight</button>
            <button className="primary-button" type="button" onClick={() => void addSelectionAnnotation("note")}>Save note</button>
            <button className="icon-button" type="button" onClick={() => setSelection(null)} aria-label="Cancel annotation"><Icon name="close" /></button>
          </div>
        </div>
      )}
      {footnote && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFootnote(null); }}>
          <section className="footnote-dialog" role="dialog" aria-modal="true" aria-labelledby="footnote-title">
            <div className="panel-heading"><h2 id="footnote-title">{footnote.title}</h2><button autoFocus className="icon-button" type="button" onClick={() => setFootnote(null)} aria-label="Close footnote"><Icon name="close" /></button></div>
            <p>{footnote.text}</p>
          </section>
        </div>
      )}
    </div>
  );
}

function TocPanel({ items, readingOrder, onNavigate }: { items: ManifestLinkJson[]; readingOrder: ManifestLinkJson[]; onNavigate: (href: string, title?: string) => void }) {
  const available = items.length ? items : readingOrder.map((item, index) => ({ ...item, title: item.title || `Chapter ${index + 1}` }));
  return <nav className="toc-list" aria-label="Book contents"><TocItems items={available} onNavigate={onNavigate} /></nav>;
}

function TocItems({ items, onNavigate }: { items: ManifestLinkJson[]; onNavigate: (href: string, title?: string) => void }) {
  return (
    <ol>
      {items.map((item, index) => (
        <li key={`${item.href}-${index}`}>
          <button type="button" onClick={() => onNavigate(item.href, item.title)}>{item.title || `Section ${index + 1}`}</button>
          {item.children?.length ? <TocItems items={item.children} onNavigate={onNavigate} /> : null}
        </li>
      ))}
    </ol>
  );
}

function NotesPanel({ book, annotations, notice, onNavigate, onDelete, onEdit, onImport }: {
  book: BookRecord;
  annotations: AnnotationRecord[];
  notice: string;
  onNavigate: (annotation: AnnotationRecord) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, patch: Pick<AnnotationRecord, "note" | "color" | "tags">) => void;
  onImport: (file: File) => void;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | AnnotationRecord["type"]>("all");
  const needle = filter.trim().toLocaleLowerCase();
  const filtered = annotations.filter((annotation) => {
    if (kind !== "all" && annotation.type !== kind) return false;
    if (!needle) return true;
    return [annotation.quote, annotation.note, ...(annotation.tags ?? [])].some((value) => value?.toLocaleLowerCase().includes(needle));
  });
  return (
    <div className="notes-panel">
      <div className="export-row">
        <AnnotationExportLink book={book} annotations={annotations} format="markdown" label="Export Markdown" />
        <AnnotationExportLink book={book} annotations={annotations} format="json" label="Export JSON" />
        <AnnotationArchiveLink book={book} annotations={annotations} />
        <button type="button" onClick={() => importRef.current?.click()}>Import</button>
      </div>
      <input ref={importRef} className="visually-hidden" type="file" accept=".annotations,.json,application/json,application/zip" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onImport(file);
      }} />
      {notice && <p className="panel-notice" role="status">{notice}</p>}
      {annotations.length > 0 && <div className="annotation-filters">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter notes or tags" aria-label="Filter notebook" />
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} aria-label="Filter annotation type"><option value="all">All types</option><option value="highlight">Highlights</option><option value="note">Notes</option><option value="bookmark">Bookmarks</option></select>
      </div>}
      {annotations.length === 0 ? <p className="empty-panel">Select text to highlight it, or press B to bookmark your location.</p> : filtered.length === 0 ? <p className="empty-panel">No notebook entries match this filter.</p> : (
        <div className="annotation-list">
          {[...filtered].reverse().map((annotation) => <AnnotationCard key={annotation.id} book={book} annotation={annotation} onNavigate={onNavigate} onDelete={onDelete} onEdit={onEdit} />)}
        </div>
      )}
    </div>
  );
}

function AnnotationCard({ book, annotation, onNavigate, onDelete, onEdit }: {
  book: BookRecord;
  annotation: AnnotationRecord;
  onNavigate: (annotation: AnnotationRecord) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, patch: Pick<AnnotationRecord, "note" | "color" | "tags">) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(annotation.note ?? "");
  const [color, setColor] = useState<NonNullable<AnnotationRecord["color"]>>(annotation.color ?? "yellow");
  const [tags, setTags] = useState((annotation.tags ?? []).join(", "));
  const locator = Locator.deserialize(annotation.locator);
  const citation = [annotation.quote ? `“${annotation.quote}”` : annotation.type === "bookmark" ? "Bookmark" : "Annotation", `— ${book.title}`, book.author, locator?.title].filter(Boolean).join(", ");
  if (editing) return <article className="annotation-card is-editing">
    <span className="annotation-type">Edit {annotation.type}</span>
    <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note" aria-label="Annotation note" />
    <ColorPicker value={color} onChange={setColor} />
    <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, separated by commas" aria-label="Annotation tags" />
    <div className="annotation-edit-actions"><button className="primary-button" type="button" onClick={() => { onEdit(annotation.id, { note: note.trim() || undefined, color, tags: parseTags(tags) }); setEditing(false); }}>Save</button><button className="secondary-button" type="button" onClick={() => setEditing(false)}>Cancel</button></div>
  </article>;
  return (
    <article className={`annotation-card color-${annotation.color ?? "yellow"}`}>
      <button className="annotation-open" type="button" onClick={() => onNavigate(annotation)}>
        <span className="annotation-type">{annotation.type}</span>
        {annotation.quote && <blockquote>{annotation.quote}</blockquote>}
        {annotation.note && <p>{annotation.note}</p>}
        {!!annotation.tags?.length && <span className="tag-list">{annotation.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>}
        <small>{new Date(annotation.createdAt).toLocaleDateString()}</small>
      </button>
      <div className="annotation-actions">
        <button className="icon-button" type="button" onClick={() => setEditing(true)} aria-label="Edit annotation"><Icon name="edit" /></button>
        <button className="icon-button" type="button" onClick={() => void navigator.clipboard?.writeText(citation)} aria-label="Copy citation"><Icon name="copy" /></button>
        <button className="icon-button" type="button" onClick={() => void onDelete(annotation.id)} aria-label="Delete annotation"><Icon name="trash" /></button>
      </div>
    </article>
  );
}

function AnnotationExportLink({ book, annotations, format, label }: { book: BookRecord; annotations: AnnotationRecord[]; format: AnnotationExportFormat; label: string }) {
  const exported = useMemo(() => createAnnotationExport(book, annotations, format), [book, annotations, format]);
  const url = useMemo(() => URL.createObjectURL(new Blob([exported.content], { type: exported.type })), [exported]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <a href={url} download={exported.name}>{label}</a>;
}

function AnnotationArchiveLink({ book, annotations }: { book: BookRecord; annotations: AnnotationRecord[] }) {
  const exported = useMemo(() => createAnnotationArchive(book, annotations), [book, annotations]);
  const url = useMemo(() => URL.createObjectURL(new Blob([exported.content], { type: exported.type })), [exported]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <a href={url} download={exported.name} title="Experimental W3C EPUB annotation set">Export .annotations</a>;
}

function ColorPicker({ value, onChange }: { value: NonNullable<AnnotationRecord["color"]>; onChange: (color: NonNullable<AnnotationRecord["color"]>) => void }) {
  return <div className="color-picker" role="group" aria-label="Highlight color">{(["yellow", "green", "blue", "pink"] as const).map((color) => <button key={color} className={`color-swatch color-${color}`} type="button" aria-label={`${color} highlight`} aria-pressed={value === color} onClick={() => onChange(color)} />)}</div>;
}

function AppearancePanel({ preferences, onChange }: { preferences: ReaderPreferencesRecord; onChange: (patch: Partial<ReaderPreferencesRecord>) => void }) {
  return (
    <form className="appearance-form" onSubmit={(event) => event.preventDefault()}>
      <fieldset><legend>Reading preset</legend><div className="preset-grid">
        <button type="button" onClick={() => void onChange({ fontFamily: "Charter, 'Iowan Old Style', Georgia, serif", fontSize: 100, lineHeight: 1.5, letterSpacing: 0, wordSpacing: 0, pageGutter: 24, textAlign: "start", screenReaderMode: false })}><strong>Book</strong><span>Balanced defaults</span></button>
        <button type="button" onClick={() => void onChange({ fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif", fontSize: 125, lineHeight: 1.75, letterSpacing: 0.04, wordSpacing: 0.12, pageGutter: 32, textAlign: "left", columnCount: 1 })}><strong>Focus</strong><span>Roomier, clearer text</span></button>
      </div></fieldset>
      <fieldset><legend>Theme</legend><div className="segmented-control">
        {(["paper", "sepia", "night", "contrast"] as const).map((theme) => <button key={theme} type="button" aria-pressed={preferences.theme === theme} onClick={() => void onChange({ theme })}>{theme}</button>)}
      </div></fieldset>
      <label>Typeface<select value={preferences.fontFamily} onChange={(event) => void onChange({ fontFamily: event.target.value })}>
        <option value="Charter, 'Iowan Old Style', Georgia, serif">Book serif</option>
        <option value="Inter, system-ui, sans-serif">Clean sans</option>
        <option value="Atkinson Hyperlegible, system-ui, sans-serif">Accessible sans</option>
        <option value="Georgia, serif">Georgia</option>
      </select></label>
      <RangeControl label="Text size" value={preferences.fontSize} min={75} max={200} step={5} suffix="%" onChange={(fontSize) => void onChange({ fontSize })} />
      <RangeControl label="Line height" value={preferences.lineHeight} min={1.1} max={2.2} step={0.1} onChange={(lineHeight) => void onChange({ lineHeight })} />
      <RangeControl label="Margins" value={preferences.pageGutter} min={0} max={64} step={4} suffix=" px" onChange={(pageGutter) => void onChange({ pageGutter })} />
      <RangeControl label="Letter spacing" value={preferences.letterSpacing} min={0} max={0.2} step={0.01} suffix=" em" onChange={(letterSpacing) => void onChange({ letterSpacing })} />
      <RangeControl label="Word spacing" value={preferences.wordSpacing} min={0} max={0.5} step={0.05} suffix=" em" onChange={(wordSpacing) => void onChange({ wordSpacing })} />
      <fieldset><legend>Columns</legend><div className="segmented-control"><button type="button" aria-pressed={preferences.columnCount === 1} onClick={() => void onChange({ columnCount: 1 })}>One</button><button type="button" aria-pressed={preferences.columnCount === 2} onClick={() => void onChange({ columnCount: 2 })}>Two</button></div></fieldset>
      <label>Alignment<select value={preferences.textAlign} onChange={(event) => void onChange({ textAlign: event.target.value as ReaderPreferencesRecord["textAlign"] })}><option value="start">Book default</option><option value="left">Left</option><option value="justify">Justified</option><option value="right">Right</option></select></label>
      <fieldset className="accessibility-options"><legend>Accessibility</legend>
        <ToggleControl label="Screen reader mode" detail="One continuous column with predictable navigation" checked={preferences.screenReaderMode} onChange={(screenReaderMode) => void onChange({ screenReaderMode })} />
        <ToggleControl label="Reading ruler" detail="Track the current line with the pointer" checked={preferences.readingRuler} onChange={(readingRuler) => void onChange({ readingRuler })} />
        <ToggleControl label="Reduce motion" detail="Turn pages without animated transitions" checked={preferences.reduceMotion} onChange={(reduceMotion) => void onChange({ reduceMotion })} />
      </fieldset>
    </form>
  );
}

function ToggleControl({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="toggle-control"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SearchPanel({ query, results, activeIndex, searching, onQuery, onSubmit, onNavigate }: { query: string; results: BookSearchResult[]; activeIndex: number; searching: boolean; onQuery: (value: string) => void; onSubmit: (event: React.FormEvent) => void; onNavigate: (index: number) => void }) {
  return (
    <div className="search-panel">
      <form onSubmit={onSubmit}><label className="search-input"><span className="visually-hidden">Search this book</span><Icon name="search" /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search this book" /><button type="submit">Search</button></label></form>
      <p className="result-count" role="status">{searching ? "Searching…" : results.length ? `${results.length} ${results.length === 1 ? "occurrence" : "occurrences"}` : query ? "No matches yet" : "Enter two or more characters."}</p>
      {results.length > 0 && <div className="search-navigation" aria-label="Search result navigation">
        <button type="button" onClick={() => onNavigate(activeIndex - 1)}><Icon name="chevron-left" /> Previous</button>
        <span>{activeIndex + 1} of {results.length}</span>
        <button type="button" onClick={() => onNavigate(activeIndex + 1)}>Next <Icon name="chevron-right" /></button>
      </div>}
      <div className="search-results">{results.map((result, index) => <button key={result.id} type="button" aria-current={index === activeIndex ? "true" : undefined} onClick={() => onNavigate(index)}><strong>{result.title}</strong><span>{result.snippet}</span></button>)}</div>
    </div>
  );
}

function ProgressScrubber({ progress, onSeek }: { progress: number; onSeek: (progress: number) => void }) {
  const [value, setValue] = useState(progress);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setValue(progress);
  }, [progress]);
  const commit = (nextValue = value) => {
    if (!dragging.current) return;
    dragging.current = false;
    onSeek(nextValue);
  };
  return (
    <label className="footer-progress">
      <span className="visually-hidden">Reading progress</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={value}
        aria-valuetext={`${Math.round(value * 100)}% complete`}
        onPointerDown={() => { dragging.current = true; }}
        onChange={(event) => setValue(Number(event.target.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
            onSeek(Number(event.currentTarget.value));
          }
        }}
      />
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

function RangeControl({ label, value, min, max, step, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="range-control"><span><span>{label}</span><output>{value}{suffix}</output></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function StorageBadge({ status, onPersist }: { status: StorageStatus; onPersist: () => void }) {
  const usage = formatBytes(status.usage);
  if (status.persisted) return <div className="storage-badge is-safe"><Icon name="shield" /><span><strong>Stored locally</strong><small>{usage} used · protected from automatic cleanup</small></span></div>;
  return <button className="storage-badge" type="button" onClick={onPersist}><Icon name="shield" /><span><strong>Protect local library</strong><small>{usage} used · request persistent storage</small></span></button>;
}

function ToolButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return <button className="tool-button" type="button" aria-label={label} aria-pressed={active} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><Icon name="book" /></span><span><strong>Better ePub</strong><small>Read on your terms</small></span></div>;
}

function LoadingScreen({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`loading-screen ${compact ? "is-compact" : ""}`} role="status"><span className="spinner" />{label}</div>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    book: <><path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" /><path d="M8 7h9a3 3 0 0 1 3 3v10h-3" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    note: <><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></>,
    text: <><path d="M5 18 10.5 6h3L19 18M7.5 14h9" /></>,
    bookmark: <><path d="M7 4h10v16l-5-3-5 3z" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    "chevron-left": <><path d="m15 18-6-6 6-6" /></>,
    "chevron-right": <><path d="m9 18 6-6-6-6" /></>,
    scroll: <><path d="M7 4h10v16H7zM10 8h4M10 12h4M10 16h4" /></>,
    pages: <><path d="M4 5h7v14H4zM13 5h7v14h-7z" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-5" /></>,
    download: <><path d="M12 4v11M8 11l4 4 4-4M5 20h14" /></>,
    upload: <><path d="M12 20V9M8 13l4-4 4 4M5 4h14" /></>,
    return: <><path d="m9 7-5 5 5 5" /><path d="M4 12h10a5 5 0 0 1 5 5v2" /></>,
    speaker: <><path d="M5 10v4h4l5 4V6l-5 4z" /><path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></>,
    play: <><path d="m9 6 9 6-9 6z" /></>,
    pause: <><path d="M9 6v12M15 6v12" /></>,
    stop: <><path d="M7 7h10v10H7z" /></>,
    previous: <><path d="M6 6v12M18 7l-8 5 8 5z" /></>,
    next: <><path d="M18 6v12M6 7l8 5-8 5z" /></>,
    edit: <><path d="m4 20 4-1 11-11-3-3L5 16zM14 7l3 3" /></>,
    copy: <><path d="M8 8h11v11H8zM5 16H4V5h11v1" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.book}</svg>;
}

function useCoverUrl(book: BookRecord) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!book.coverPath) return;
    let objectUrl: string | undefined;
    void db.resources.get([book.id, book.coverPath]).then((resource) => {
      if (!resource) return;
      objectUrl = URL.createObjectURL(resource.blob);
      setUrl(objectUrl);
    });
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [book.id, book.coverPath]);
  return url;
}

function useSourceUrl(book: BookRecord) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    void db.resources.get([book.id, "__source__.epub"]).then((resource) => {
      if (!resource || disposed) return;
      objectUrl = URL.createObjectURL(resource.blob);
      setUrl(objectUrl);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [book.id]);
  return url;
}

function toReadiumPreferences(preferences: ReaderPreferencesRecord) {
  const colors = themeColors(preferences.theme);
  const alignments = {
    start: ReadiumTextAlignment.start,
    left: ReadiumTextAlignment.left,
    right: ReadiumTextAlignment.right,
    justify: ReadiumTextAlignment.justify,
  };
  return {
    scroll: preferences.flow === "scrolled",
    columnCount: preferences.columnCount,
    fontFamily: preferences.fontFamily,
    fontSize: preferences.fontSize / 100,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    wordSpacing: preferences.wordSpacing,
    pageGutter: preferences.pageGutter,
    textAlign: alignments[preferences.textAlign],
    backgroundColor: colors.background,
    textColor: colors.text,
    linkColor: colors.link,
    visitedColor: colors.visited,
    selectionBackgroundColor: colors.selection,
    selectionTextColor: colors.text,
  };
}

function themeColors(theme: ReaderPreferencesRecord["theme"]) {
  if (theme === "contrast") return { background: "#000000", text: "#ffffff", link: "#7dd3fc", visited: "#f0abfc", selection: "#ffe600" };
  if (theme === "night") return { background: "#1b1c1a", text: "#ecebe5", link: "#b9d7c4", visited: "#c7b7dd", selection: "#685b25" };
  if (theme === "sepia") return { background: "#eee4cf", text: "#3c3328", link: "#315c4a", visited: "#704c71", selection: "#e2c966" };
  return { background: "#fbfaf6", text: "#222722", link: "#2f6148", visited: "#6b4b74", selection: "#f1d76a" };
}

function parseTags(value: string) {
  const tags = [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
  return tags.length ? tags : undefined;
}

function framePublicationPath(source: string, bookId: string) {
  try {
    const marker = `/__books/${encodeURIComponent(bookId)}/`;
    const path = new URL(source).pathname;
    const index = path.indexOf(marker);
    if (index < 0) return undefined;
    return decodeURIComponent(path.slice(index + marker.length));
  } catch {
    return undefined;
  }
}

function annotationColor(color: AnnotationRecord["color"]) {
  return { yellow: "#f1d76a", green: "#a8d8b0", blue: "#a9cde8", pink: "#e8b2c2" }[color || "yellow"];
}

async function ensureServiceWorkerControl() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support offline book storage.");
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("The offline reader is still starting. Reload the page and try again.")), 5000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function chapterTitle(book: BookRecord, href?: string, index?: number) {
  const item = href ? flattenToc(book.manifest.toc).find((candidate) => href.startsWith(candidate.href.split("#", 1)[0])) : undefined;
  return item?.title || (index !== undefined ? `Chapter ${index + 1}` : "Reading");
}

function panelLabel(panel: NonNullable<Parameters<typeof ReaderView>[0]> extends never ? never : "toc" | "notes" | "appearance" | "search") {
  return { toc: "Contents", notes: "Notebook", appearance: "Appearance", search: "Search" }[panel];
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "book";
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function relativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

async function countBookWords(book: BookRecord) {
  let count = 0;
  for (const item of book.manifest.readingOrder) {
    const path = item.href.split("#", 1)[0];
    const record = await db.resources.get([book.id, path]);
    if (!record || !record.mediaType.includes("html")) continue;
    const document = new DOMParser().parseFromString(await record.blob.text(), record.mediaType as DOMParserSupportedType);
    document.querySelectorAll("script, style, nav").forEach((element) => element.remove());
    count += document.body?.textContent?.trim().split(/\s+/u).filter(Boolean).length ?? 0;
  }
  return count;
}

async function consumeSharedEpubs() {
  if (!("caches" in window)) return [];
  const cache = await caches.open("better-epub-share-target");
  const requests = (await cache.keys()).filter((request) => new URL(request.url).pathname.includes("/__shared_epub__/"));
  const files: File[] = [];
  for (const request of requests) {
    const response = await cache.match(request);
    if (response) {
      const encodedName = response.headers.get("X-Better-Epub-Filename") || "shared.epub";
      const name = decodeURIComponent(encodedName);
      files.push(new File([await response.blob()], name, { type: "application/epub+zip" }));
    }
    await cache.delete(request);
  }
  return files;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
