import { describe, expect, it } from "vitest";
import {
  EPUB_DOCUMENT_CONTENT_SECURITY_POLICY,
  EPUB_DOCUMENT_PERMISSIONS_POLICY,
  isPublicationDocument,
  sanitizePublicationMarkup,
} from "./security";

describe("publication response security", () => {
  it("classifies executable publication document types", () => {
    expect(isPublicationDocument("application/xhtml+xml")).toBe(true);
    expect(isPublicationDocument("text/html; charset=utf-8")).toBe(true);
    expect(isPublicationDocument("image/svg+xml")).toBe(true);
    expect(isPublicationDocument("text/css")).toBe(false);
  });

  it("disables publication scripts, network access, forms, and privileged APIs", () => {
    expect(EPUB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("script-src 'none'");
    expect(EPUB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(EPUB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
    expect(EPUB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("sandbox allow-same-origin");
    expect(EPUB_DOCUMENT_PERMISSIONS_POLICY).toContain("camera=()");
    expect(EPUB_DOCUMENT_PERMISSIONS_POLICY).toContain("clipboard-write=()");
  });

  it("removes authored executable markup without removing book text", () => {
    const sanitized = sanitizePublicationMarkup(`<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><head>
        <meta http-equiv="refresh" content="0; https://example.com" />
        <script>parent.document.body.textContent = "owned"</script>
      </head><body onload="steal()"><p onclick="steal()">Keep this text.</p>
        <a href=" java\nscript:steal()">Unsafe link</a>
        <iframe srcdoc="&lt;script&gt;steal()&lt;/script&gt;"></iframe>
        <img src="cover.jpg" onerror="steal()" />
      </body></html>`, "application/xhtml+xml");

    expect(sanitized).toContain("Keep this text.");
    expect(sanitized).toContain("cover.jpg");
    expect(sanitized).not.toMatch(/<script|<iframe|http-equiv="refresh"/i);
    expect(sanitized).not.toMatch(/\sonload=|\sonclick=|\sonerror=|javascript:/i);
  });
});
