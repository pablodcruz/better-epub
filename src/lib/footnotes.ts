export interface FootnoteTarget {
  path: string;
  fragment: string;
}

export function footnoteTarget(anchor: HTMLAnchorElement, currentPath: string): FootnoteTarget | undefined {
  const href = anchor.getAttribute("href");
  if (!href || !href.includes("#") || /^(?:https?:|mailto:|tel:|data:)/i.test(href)) return undefined;
  const [, rawFragment = ""] = href.split("#", 2);
  if (!rawFragment) return undefined;
  const fragment = safeDecode(rawFragment);
  const epubType = anchor.getAttribute("epub:type") || anchor.getAttributeNS("http://www.idpf.org/2007/ops", "type") || "";
  const role = anchor.getAttribute("role") || "";
  const explicit = epubType.split(/\s+/u).includes("noteref") || role.split(/\s+/u).includes("doc-noteref");
  const localTarget = href.startsWith("#") ? anchor.ownerDocument.getElementById(fragment) : null;
  const targetType = localTarget?.getAttribute("epub:type") || localTarget?.getAttributeNS("http://www.idpf.org/2007/ops", "type") || "";
  const targetRole = localTarget?.getAttribute("role") || "";
  const implicit = localTarget?.localName === "aside"
    || /(?:^|\s)(?:footnote|endnote)(?:\s|$)/u.test(targetType)
    || /(?:^|\s)doc-(?:footnote|endnote)(?:\s|$)/u.test(targetRole);
  if (!explicit && !implicit) return undefined;

  const pathPart = href.split("#", 1)[0];
  const path = pathPart ? resolveRelativePath(currentPath, pathPart) : currentPath;
  return { path, fragment };
}

export async function extractFootnote(blob: Blob, mediaType: string, fragment: string) {
  const document = new DOMParser().parseFromString(await blob.text(), mediaType as DOMParserSupportedType);
  const element = document.getElementById(fragment);
  if (!element) return undefined;
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("script, style, nav, [role='doc-backlink'], [epub\\:type~='backlink']").forEach((node) => node.remove());
  const text = copy.textContent?.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  const heading = copy.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.replace(/\s+/gu, " ").trim();
  return { title: heading || "Footnote", text: text.slice(0, 12_000) };
}

function resolveRelativePath(currentPath: string, relativePath: string) {
  const resolved = new URL(relativePath, `https://book.invalid/${currentPath}`).pathname;
  return safeDecode(resolved.replace(/^\//, ""));
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
