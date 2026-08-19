import type { AnnotationRecord, BookRecord } from "./types";

export type AnnotationExportFormat = "markdown" | "json";

export function createAnnotationExport(
  book: Pick<BookRecord, "title" | "author">,
  annotations: AnnotationRecord[],
  format: AnnotationExportFormat,
) {
  const safeName = book.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "book";
  if (format === "json") {
    return {
      name: `${safeName}-annotations.json`,
      content: JSON.stringify({ book: { title: book.title, author: book.author }, annotations }, null, 2),
      type: "application/json",
    };
  }
  const body = annotations.map((annotation) => {
    const heading = `## ${annotation.type[0].toUpperCase()}${annotation.type.slice(1)}`;
    const quote = annotation.quote ? `\n\n> ${annotation.quote.replaceAll("\n", "\n> ")}` : "";
    const note = annotation.note ? `\n\n${annotation.note}` : "";
    return `${heading}${quote}${note}\n\n_${new Date(annotation.createdAt).toLocaleString()}_`;
  }).join("\n\n---\n\n");
  return {
    name: `${safeName}-annotations.md`,
    content: `# ${book.title}\n\n${book.author}\n\n${body}`,
    type: "text/markdown",
  };
}
