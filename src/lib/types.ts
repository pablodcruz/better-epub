import type { Locator } from "@readium/shared";

export type ReaderFlow = "paginated" | "scrolled";
export type ReaderTheme = "paper" | "sepia" | "night" | "contrast";
export type TextAlignment = "start" | "left" | "right" | "justify";

export interface ManifestLinkJson {
  href: string;
  type?: string;
  title?: string;
  rel?: string | string[];
  properties?: Record<string, unknown>;
  children?: ManifestLinkJson[];
}

export interface StoredManifest {
  metadata: {
    title: string;
    author?: Array<{ name: string }>;
    identifier?: string;
    language?: string[];
    description?: string;
    conformsTo: string[];
    layout: "fixed" | "reflowable";
    readingProgression: "ltr" | "rtl" | "auto";
  };
  readingOrder: ManifestLinkJson[];
  resources: ManifestLinkJson[];
  toc: ManifestLinkJson[];
  coverPath?: string;
}

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  description?: string;
  language?: string;
  importedAt: number;
  lastOpenedAt: number;
  progress: number;
  size: number;
  coverPath?: string;
  manifest: StoredManifest;
  lastLocator?: ReturnType<Locator["serialize"]>;
}

export interface ResourceRecord {
  bookId: string;
  path: string;
  mediaType: string;
  blob: Blob;
}

export interface AnnotationRecord {
  id: string;
  bookId: string;
  type: "highlight" | "note" | "bookmark";
  locator: ReturnType<Locator["serialize"]>;
  quote?: string;
  note?: string;
  color?: "yellow" | "green" | "blue" | "pink";
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ReaderPreferencesRecord {
  bookId: string;
  flow: ReaderFlow;
  theme: ReaderTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  wordSpacing: number;
  pageGutter: number;
  columnCount: 1 | 2;
  textAlign: TextAlignment;
  reduceMotion: boolean;
  screenReaderMode: boolean;
  readingRuler: boolean;
}

export interface ImportedBook {
  book: BookRecord;
  resources: ResourceRecord[];
}
