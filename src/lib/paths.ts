const BOOK_PATH_MARKER = "__books";

export function virtualBookBase(bookId: string) {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  return new URL(`${BOOK_PATH_MARKER}/${encodeURIComponent(bookId)}/`, base).href;
}

export function virtualResourceUrl(bookId: string, path: string) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(encodedPath, virtualBookBase(bookId)).href;
}

export function normalizeArchivePath(path: string) {
  const decoded = safeDecode(path).replaceAll("\\", "/");
  const parts: string[] = [];
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("The EPUB contains an unsafe path.");
      parts.pop();
      continue;
    }
    if (part.includes("\0")) throw new Error("The EPUB contains an invalid path.");
    parts.push(part);
  }
  return parts.join("/");
}

export function resolveArchivePath(baseFile: string, href: string) {
  const decodedHref = safeDecode(href.trim());
  if (/^[a-z][a-z\d+.-]*:/i.test(decodedHref) || decodedHref.startsWith("//")) {
    throw new Error("Remote EPUB resources are disabled to protect your privacy.");
  }
  if (decodedHref.startsWith("/")) {
    throw new Error("Absolute EPUB resource paths are disabled to protect your privacy.");
  }
  const withoutFragment = decodedHref.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  const baseDirectory = baseFile.includes("/")
    ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1)
    : "";
  return normalizeArchivePath(`${baseDirectory}${withoutFragment}`);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
