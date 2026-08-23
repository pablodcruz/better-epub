import { Locator, LocatorLocations, LocatorText } from "@readium/shared";

export interface BookSearchResult {
  id: string;
  title: string;
  snippet: string;
  locator: ReturnType<Locator["serialize"]>;
}

interface SearchableResource {
  href: string;
  type: string;
  title: string;
  text: string;
  spineIndex: number;
  spineLength: number;
}

export function findResourceMatches(resource: SearchableResource, query: string, limit = 100): BookSearchResult[] {
  const normalizedQuery = normalizeWhitespace(query).trim();
  if (normalizedQuery.length < 2 || limit <= 0) return [];

  const searchable = normalizeWithSourceMap(resource.text);
  const haystack = searchable.text.toLocaleLowerCase();
  const needle = normalizedQuery.toLocaleLowerCase();
  const results: BookSearchResult[] = [];
  let from = 0;

  while (from <= haystack.length - needle.length && results.length < limit) {
    const match = haystack.indexOf(needle, from);
    if (match < 0) break;
    const normalizedEnd = match + normalizedQuery.length;
    const sourceStart = searchable.sourceIndexes[match];
    const finalSourceIndex = searchable.sourceIndexes[Math.max(match, normalizedEnd - 1)];
    if (sourceStart === undefined || finalSourceIndex === undefined) break;
    const sourceEnd = finalSourceIndex + 1;
    const highlight = resource.text.slice(sourceStart, sourceEnd);
    const before = resource.text.slice(Math.max(0, sourceStart - 64), sourceStart);
    const after = resource.text.slice(sourceEnd, Math.min(resource.text.length, sourceEnd + 64));
    const localProgression = resource.text.length ? sourceStart / resource.text.length : 0;
    const totalProgression = Math.min(1, (resource.spineIndex + localProgression) / Math.max(resource.spineLength, 1));
    const locator = new Locator({
      href: resource.href,
      type: resource.type,
      title: resource.title,
      locations: new LocatorLocations({ progression: localProgression, totalProgression }),
      text: new LocatorText({ before, highlight, after }),
    });
    const snippetStart = Math.max(0, match - 72);
    const snippetEnd = Math.min(searchable.text.length, normalizedEnd + 112);

    results.push({
      id: `${resource.href}:${sourceStart}:${sourceEnd}`,
      title: resource.title,
      snippet: `${snippetStart > 0 ? "…" : ""}${searchable.text.slice(snippetStart, snippetEnd)}${snippetEnd < searchable.text.length ? "…" : ""}`,
      locator: locator.serialize(),
    });
    from = match + Math.max(needle.length, 1);
  }

  return results;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ");
}

function normalizeWithSourceMap(source: string) {
  let text = "";
  const sourceIndexes: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/u.test(character)) {
      if (inWhitespace || text.length === 0) continue;
      text += " ";
      sourceIndexes.push(index);
      inWhitespace = true;
    } else {
      text += character;
      sourceIndexes.push(index);
      inWhitespace = false;
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    sourceIndexes.pop();
  }
  return { text, sourceIndexes };
}
