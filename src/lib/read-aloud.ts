import {
  Footnote,
  HTMLResourceContentIterator,
  Link,
  Locator,
  LocatorText,
  TextElement,
  type Publication,
} from "@readium/shared";
import type { BookRecord } from "./types";

export interface SpeechSegment {
  id: string;
  text: string;
  language?: string;
  locator: Locator;
}

export async function loadSpeechSegments(
  publication: Publication,
  book: BookRecord,
  start: Locator,
  skipFootnotes = true,
): Promise<SpeechSegment[]> {
  const href = start.href.split("#", 1)[0];
  const manifestLink = book.manifest.readingOrder.find((item) => item.href.split("#", 1)[0] === href);
  const link = Link.deserialize({ href, type: manifestLink?.type || start.type, title: start.title });
  if (!link) return [];
  const iterator = new HTMLResourceContentIterator(publication.get(link), start);
  const segments: SpeechSegment[] = [];
  let elementIndex = 0;

  while (await iterator.hasNext()) {
    const element = iterator.next();
    if (!(element instanceof TextElement) || (skipFootnotes && element.role === Footnote)) continue;
    const text = element.text?.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    for (const sentence of splitSentences(text, book.language)) {
      const before = text.slice(Math.max(0, sentence.index - 64), sentence.index);
      const after = text.slice(sentence.index + sentence.text.length, sentence.index + sentence.text.length + 64);
      const locator = new Locator({
        href: element.locator.href,
        type: element.locator.type,
        title: element.locator.title,
        locations: element.locator.locations,
        text: new LocatorText({ before, highlight: sentence.text, after }),
      });
      segments.push({
        id: `${href}:${elementIndex}:${sentence.index}`,
        text: sentence.text,
        language: book.language,
        locator,
      });
    }
    elementIndex += 1;
    if (segments.length >= 5_000) break;
  }
  return segments;
}

export function adjacentResourceLocator(book: BookRecord, href: string, delta: -1 | 1) {
  const current = book.manifest.readingOrder.findIndex((item) => item.href.split("#", 1)[0] === href.split("#", 1)[0]);
  const item = book.manifest.readingOrder[current + delta];
  if (!item) return undefined;
  return Locator.deserialize({
    href: item.href.split("#", 1)[0],
    type: item.type || "application/xhtml+xml",
    title: item.title,
    locations: { progression: delta === 1 ? 0 : 1, position: current + delta + 1 },
  });
}

export function splitSentences(text: string, language?: string) {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    return [...new Segmenter(language, { granularity: "sentence" }).segment(text)]
      .map((segment) => ({ text: segment.segment.trim(), index: segment.index + segment.segment.search(/\S/u) }))
      .filter((segment) => segment.text.length > 0);
  }
  const results: Array<{ text: string; index: number }> = [];
  const pattern = /[^.!?]+(?:[.!?]+(?:[”’"']+)?|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim();
    if (value) results.push({ text: value, index: (match.index ?? 0) + match[0].search(/\S/u) });
  }
  return results;
}
