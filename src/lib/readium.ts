import {
  HttpFetcher,
  Locator,
  Manifest,
  Publication,
} from "@readium/shared";
import type { BookRecord, ManifestLinkJson } from "./types";
import { virtualBookBase } from "./paths";

export function createPublication(book: BookRecord) {
  const base = virtualBookBase(book.id);
  const metadata = {
    ...book.manifest.metadata,
    readingProgression: book.manifest.metadata.readingProgression === "auto"
      ? undefined
      : book.manifest.metadata.readingProgression,
  };
  const manifest = Manifest.deserialize({
    "@context": ["https://readium.org/webpub-manifest/context.jsonld"],
    metadata,
    links: [
      {
        href: `${base}manifest.json`,
        type: "application/webpub+json",
        rel: "self",
      },
    ],
    readingOrder: book.manifest.readingOrder,
    resources: book.manifest.resources,
    toc: book.manifest.toc,
  });
  if (!manifest) throw new Error("The stored publication manifest is invalid.");
  return new Publication({ manifest, fetcher: new HttpFetcher(undefined, base) });
}

export function createPositions(book: BookRecord) {
  const items = book.manifest.readingOrder;
  return items
    .map((item, index) => Locator.deserialize({
      href: withoutFragment(item.href),
      type: item.type || "application/xhtml+xml",
      title: item.title,
      locations: {
        position: index + 1,
        progression: 0,
        totalProgression: index / Math.max(items.length, 1),
      },
    }))
    .filter((locator): locator is Locator => Boolean(locator));
}

export function flattenToc(items: ManifestLinkJson[]): ManifestLinkJson[] {
  return items.flatMap((item) => [item, ...flattenToc(item.children ?? [])]);
}

function withoutFragment(href: string) {
  return href.split("#", 1)[0] || href;
}
