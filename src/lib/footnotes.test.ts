import { describe, expect, it } from "vitest";
import { extractFootnote, footnoteTarget } from "./footnotes";

describe("footnotes", () => {
  it("recognizes semantic note references and resolves relative resources", () => {
    document.body.innerHTML = `<a id="ref" epub:type="noteref" href="../notes.xhtml#note-1">1</a>`;
    const target = footnoteTarget(document.querySelector("a")!, "OPS/text/chapter.xhtml");
    expect(target).toEqual({ path: "OPS/notes.xhtml", fragment: "note-1" });
  });

  it("recognizes local asides even without explicit noteref semantics", () => {
    document.body.innerHTML = `<a href="#note-1">1</a><aside id="note-1">A local note.</aside>`;
    expect(footnoteTarget(document.querySelector("a")!, "chapter.xhtml")).toEqual({ path: "chapter.xhtml", fragment: "note-1" });
  });

  it("extracts readable note text while removing backlinks", async () => {
    const blob = new Blob([`<html><body><aside id="note"><h3>Note 1</h3><p>Useful context.</p><a role="doc-backlink">Back</a></aside></body></html>`], { type: "text/html" });
    await expect(extractFootnote(blob, "text/html", "note")).resolves.toEqual({ title: "Note 1", text: "Note 1Useful context." });
  });
});
