export const EPUB_DOCUMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'self' blob: 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-same-origin",
].join("; ");

export const EPUB_DOCUMENT_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "clipboard-read=()",
  "clipboard-write=()",
].join(", ");

export function isPublicationDocument(mediaType: string) {
  const normalized = mediaType.toLowerCase().split(";", 1)[0].trim();
  return normalized === "text/html"
    || normalized === "application/xhtml+xml"
    || normalized === "image/svg+xml";
}

const ACTIVE_ELEMENTS = "script, iframe, frame, frameset, object, embed, applet, form";
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
]);

export function sanitizePublicationMarkup(source: string, mediaType: string) {
  const normalized = mediaType.toLowerCase().split(";", 1)[0].trim();
  const parserType: DOMParserSupportedType = normalized === "text/html"
    ? "text/html"
    : normalized === "image/svg+xml"
      ? "image/svg+xml"
      : "application/xhtml+xml";
  const document = new DOMParser().parseFromString(source, parserType);
  if (document.querySelector("parsererror")) {
    throw new Error("The EPUB contains invalid publication markup.");
  }

  document.querySelectorAll(ACTIVE_ELEMENTS).forEach((element) => element.remove());
  document.querySelectorAll("meta[http-equiv]").forEach((element) => {
    const directive = element.getAttribute("http-equiv")?.trim().toLowerCase();
    if (directive === "refresh") element.remove();
  });
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (URL_ATTRIBUTES.has(name) && isScriptableUrl(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
      if (name === "style" && /url\s*\(\s*['\"]?\s*(?:javascript|vbscript):/i.test(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  });

  return new XMLSerializer().serializeToString(document);
}

function isScriptableUrl(value: string) {
  const compact = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return compact.startsWith("javascript:")
    || compact.startsWith("vbscript:")
    || compact.startsWith("data:text/html")
    || compact.startsWith("data:application/xhtml+xml")
    || compact.startsWith("data:image/svg+xml");
}
