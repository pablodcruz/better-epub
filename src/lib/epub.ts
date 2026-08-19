import { strFromU8, unzipSync } from "fflate";
import type {
  ImportedBook,
  ManifestLinkJson,
  ResourceRecord,
  StoredManifest,
} from "./types";
import { normalizeArchivePath, resolveArchivePath } from "./paths";
import { isPublicationDocument, sanitizePublicationMarkup } from "./security";

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 10_000;

interface PackageItem {
  id: string;
  path: string;
  mediaType: string;
  properties: Set<string>;
}

export async function importEpub(file: File): Promise<ImportedBook> {
  if (!file.name.toLowerCase().endsWith(".epub") && file.type !== "application/epub+zip") {
    throw new Error("Choose a DRM-free EPUB file.");
  }
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error("This EPUB is larger than the 250 MB import limit.");
  }

  let preflightCount = 0;
  let preflightExpandedBytes = 0;
  const preflightPaths = new Set<string>();
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      preflightCount += 1;
      if (preflightCount > MAX_RESOURCE_COUNT) {
        throw new Error("This EPUB contains too many files to open safely.");
      }
      const path = normalizeArchivePath(entry.name);
      if (!path || entry.name.endsWith("/")) return false;
      if (entry.originalSize > MAX_RESOURCE_BYTES) {
        throw new Error(`The EPUB resource “${path}” is too large to open safely.`);
      }
      preflightExpandedBytes += entry.originalSize;
      if (preflightExpandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("The expanded EPUB exceeds the 500 MB safety limit.");
      }
      if (preflightPaths.has(path)) {
        throw new Error(`The EPUB contains duplicate resource path “${path}”.`);
      }
      preflightPaths.add(path);
      return true;
    },
  });
  const entries = Object.entries(archive);
  if (entries.length > MAX_RESOURCE_COUNT) {
    throw new Error("This EPUB contains too many files to open safely.");
  }

  let expandedBytes = 0;
  const files = new Map<string, Uint8Array>();
  for (const [unsafePath, data] of entries) {
    const path = normalizeArchivePath(unsafePath);
    if (!path || unsafePath.endsWith("/")) continue;
    if (data.byteLength > MAX_RESOURCE_BYTES) {
      throw new Error(`The EPUB resource “${path}” is too large to open safely.`);
    }
    expandedBytes += data.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("The expanded EPUB exceeds the 500 MB safety limit.");
    }
    files.set(path, data);
  }

  const containerXml = readXml(files, "META-INF/container.xml");
  const rootfile = firstByLocalName(containerXml, "rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("The EPUB package document could not be located.");
  const packagePath = normalizeArchivePath(rootfile);
  const packageDocument = readXml(files, packagePath);

  const metadataElement = firstByLocalName(packageDocument, "metadata");
  const title = textOf(metadataElement, "title") || file.name.replace(/\.epub$/i, "");
  const author = textOf(metadataElement, "creator") || "Unknown author";
  const identifier = textOf(metadataElement, "identifier") || crypto.randomUUID();
  const language = textOf(metadataElement, "language") || "en";
  const description = textOf(metadataElement, "description") || undefined;

  const renditionLayout = metaProperty(metadataElement, "rendition:layout") === "pre-paginated"
    ? "fixed"
    : "reflowable";
  const spine = firstByLocalName(packageDocument, "spine");
  const direction = spine?.getAttribute("page-progression-direction");
  const readingProgression = direction === "rtl" ? "rtl" : direction === "ltr" ? "ltr" : "auto";

  const manifestItems = new Map<string, PackageItem>();
  for (const item of allByLocalName(firstByLocalName(packageDocument, "manifest"), "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifestItems.set(id, {
      id,
      path: resolveArchivePath(packagePath, href),
      mediaType: item.getAttribute("media-type") || inferMediaType(href),
      properties: new Set((item.getAttribute("properties") || "").split(/\s+/).filter(Boolean)),
    });
  }

  const readingOrder: ManifestLinkJson[] = [];
  for (const itemref of allByLocalName(spine, "itemref")) {
    if (itemref.getAttribute("linear") === "no") continue;
    const item = manifestItems.get(itemref.getAttribute("idref") || "");
    if (!item) continue;
    readingOrder.push({
      href: item.path,
      type: item.mediaType,
      properties: itemref.getAttribute("properties")?.includes("rendition:layout-pre-paginated")
        ? { layout: "fixed" }
        : undefined,
    });
  }
  if (readingOrder.length === 0) throw new Error("The EPUB does not contain a readable spine.");

  const navItem = [...manifestItems.values()].find((item) => item.properties.has("nav"));
  const ncxId = spine?.getAttribute("toc");
  const ncxItem = (ncxId ? manifestItems.get(ncxId) : undefined)
    ?? [...manifestItems.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
  const toc = navItem
    ? parseNavigation(readXml(files, navItem.path), navItem.path)
    : ncxItem
      ? parseNcx(readXml(files, ncxItem.path), ncxItem.path)
      : [];

  const legacyCoverId = allByLocalName(metadataElement, "meta")
    .find((meta) => meta.getAttribute("name") === "cover")
    ?.getAttribute("content");
  const coverItem = [...manifestItems.values()].find((item) => item.properties.has("cover-image"))
    ?? (legacyCoverId ? manifestItems.get(legacyCoverId) : undefined);

  const resources: ManifestLinkJson[] = [...manifestItems.values()]
    .filter((item) => !readingOrder.some((link) => link.href === item.path))
    .map((item) => ({
      href: item.path,
      type: item.mediaType,
      rel: coverItem?.path === item.path ? "cover" : undefined,
    }));

  const manifest: StoredManifest = {
    metadata: {
      title,
      author: [{ name: author }],
      identifier,
      language: [language],
      description,
      conformsTo: ["https://readium.org/webpub-manifest/profiles/epub"],
      layout: renditionLayout,
      readingProgression,
    },
    readingOrder,
    resources,
    toc,
    coverPath: coverItem?.path,
  };

  const id = await stableBookId(identifier, file);
  const resourceRecords: ResourceRecord[] = [];
  for (const [path, data] of files) {
    const item = [...manifestItems.values()].find((candidate) => candidate.path === path);
    const mediaType = item?.mediaType || inferMediaType(path);
    const content: BlobPart = isPublicationDocument(mediaType)
      ? sanitizePublicationMarkup(strFromU8(data), mediaType)
      : data as BlobPart;
    resourceRecords.push({
      bookId: id,
      path,
      mediaType,
      blob: new Blob([content], { type: mediaType }),
    });
  }
  resourceRecords.push({
    bookId: id,
    path: "__source__.epub",
    mediaType: "application/epub+zip",
    blob: file.slice(0, file.size, "application/epub+zip"),
  });

  const now = Date.now();
  return {
    book: {
      id,
      title,
      author,
      description,
      language,
      importedAt: now,
      lastOpenedAt: now,
      progress: 0,
      size: file.size,
      coverPath: coverItem?.path,
      manifest,
    },
    resources: resourceRecords,
  };
}

function readXml(files: Map<string, Uint8Array>, path: string) {
  const data = files.get(path);
  if (!data) throw new Error(`The EPUB is missing “${path}”.`);
  const source = strFromU8(data);
  if (/<!ENTITY\s/i.test(source)) throw new Error("Unsafe XML entities are not supported.");
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) throw new Error(`The EPUB contains invalid XML in “${path}”.`);
  return document;
}

function firstByLocalName(root: ParentNode | null | undefined, name: string) {
  return allByLocalName(root, name)[0];
}

function allByLocalName(root: ParentNode | null | undefined, name: string) {
  if (!root) return [];
  return [...root.querySelectorAll("*")].filter((element) => element.localName === name);
}

function textOf(root: ParentNode | null | undefined, localName: string) {
  return firstByLocalName(root, localName)?.textContent?.trim() || "";
}

function metaProperty(root: ParentNode | null | undefined, property: string) {
  return allByLocalName(root, "meta")
    .find((meta) => meta.getAttribute("property") === property)
    ?.textContent?.trim();
}

function parseNavigation(document: XMLDocument, navPath: string): ManifestLinkJson[] {
  const nav = allByLocalName(document, "nav").find((element) => {
    const epubType = element.getAttribute("epub:type") || element.getAttributeNS("http://www.idpf.org/2007/ops", "type");
    return epubType?.split(/\s+/).includes("toc");
  }) ?? allByLocalName(document, "nav")[0];
  const list = nav ? allByLocalName(nav, "ol")[0] : undefined;
  return list ? parseNavigationList(list, navPath) : [];
}

function parseNavigationList(list: Element, navPath: string): ManifestLinkJson[] {
  const links: ManifestLinkJson[] = [];
  for (const child of [...list.children]) {
    if (child.localName !== "li") continue;
    const anchor = [...child.children].find((element) => element.localName === "a");
    const nested = [...child.children].find((element) => element.localName === "ol");
    if (!anchor) continue;
    const href = anchor.getAttribute("href") || "";
    const [resourceHref, fragment] = href.split("#", 2);
    const resolved = resourceHref ? resolveArchivePath(navPath, resourceHref) : navPath;
    links.push({
      href: fragment ? `${resolved}#${fragment}` : resolved,
      title: anchor.textContent?.trim() || "Untitled section",
      children: nested ? parseNavigationList(nested, navPath) : undefined,
    });
  }
  return links;
}

function parseNcx(document: XMLDocument, ncxPath: string): ManifestLinkJson[] {
  const navMap = firstByLocalName(document, "navMap");
  if (!navMap) return [];
  return [...navMap.children]
    .filter((element) => element.localName === "navPoint")
    .map((element) => parseNcxPoint(element, ncxPath))
    .filter((link): link is ManifestLinkJson => link !== undefined);
}

function parseNcxPoint(point: Element, ncxPath: string): ManifestLinkJson | undefined {
  const source = firstByLocalName(point, "content")?.getAttribute("src");
  if (!source) return undefined;
  const [resourceHref, fragment] = source.split("#", 2);
  const resolved = resourceHref ? resolveArchivePath(ncxPath, resourceHref) : ncxPath;
  const children = [...point.children]
    .filter((element) => element.localName === "navPoint")
    .map((element) => parseNcxPoint(element, ncxPath))
    .filter((link): link is ManifestLinkJson => link !== undefined);
  return {
    href: fragment ? `${resolved}#${fragment}` : resolved,
    title: textOf(firstByLocalName(point, "navLabel"), "text") || "Untitled section",
    children: children.length > 0 ? children : undefined,
  };
}

function inferMediaType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    xhtml: "application/xhtml+xml",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    svg: "image/svg+xml",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    woff: "font/woff",
    woff2: "font/woff2",
    otf: "font/otf",
    ttf: "font/ttf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    smil: "application/smil+xml",
    ncx: "application/x-dtbncx+xml",
    xml: "application/xml",
  };
  return types[extension || ""] || "application/octet-stream";
}

async function stableBookId(identifier: string, file: File) {
  const input = new TextEncoder().encode(`${identifier}\0${file.name}\0${file.size}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].slice(0, 16).map((value) => value.toString(16).padStart(2, "0")).join("");
}
