/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { setCatchHandler } from "workbox-routing";
import {
  EPUB_DOCUMENT_CONTENT_SECURITY_POLICY,
  EPUB_DOCUMENT_PERMISSIONS_POLICY,
  isPublicationDocument,
} from "./lib/security";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

const DATABASE_NAME = "better-epub";
const RESOURCE_STORE = "resources";
const BOOK_MARKER = "/__books/";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes(BOOK_MARKER)) return;
  event.respondWith(serveBookResource(event.request, url));
});

setCatchHandler(async ({ request }) => {
  if (request.destination === "document") {
    const cached = await caches.match(new URL("./index.html", self.registration.scope));
    if (cached) return cached;
  }
  return Response.error();
});

async function serveBookResource(request: Request, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const markerIndex = url.pathname.indexOf(BOOK_MARKER);
  const segments = url.pathname.slice(markerIndex + BOOK_MARKER.length).split("/");
  const bookId = decodeURIComponent(segments.shift() || "");
  const path = segments.map((segment) => decodeURIComponent(segment)).join("/");
  if (!bookId || !path || path === "manifest.json") {
    return new Response("Not found", { status: 404 });
  }

  const record = await getResource(bookId, path);
  if (!record) return new Response("Not found", { status: 404 });

  const blob = record.blob as Blob;
  const commonHeaders = new Headers({
    "Content-Type": record.mediaType || blob.type || "application/octet-stream",
    "Content-Length": String(blob.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (isPublicationDocument(record.mediaType || blob.type)) {
    commonHeaders.set("Content-Security-Policy", EPUB_DOCUMENT_CONTENT_SECURITY_POLICY);
    commonHeaders.set("Permissions-Policy", EPUB_DOCUMENT_PERMISSIONS_POLICY);
  }

  if (request.method === "HEAD") return new Response(null, { status: 200, headers: commonHeaders });

  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
      if (start <= end && start < blob.size) {
        commonHeaders.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
        commonHeaders.set("Content-Length", String(end - start + 1));
        commonHeaders.set("Accept-Ranges", "bytes");
        return new Response(blob.slice(start, end + 1, blob.type), {
          status: 206,
          headers: commonHeaders,
        });
      }
    }
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` },
    });
  }

  return new Response(blob, { status: 200, headers: commonHeaders });
}

async function getResource(bookId: string, path: string): Promise<{ blob: Blob; mediaType: string } | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RESOURCE_STORE, "readonly");
    const request = transaction.objectStore(RESOURCE_STORE).get([bookId, path]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    // Dexie maps its logical schema version to a larger native IndexedDB
    // version. Opening without a requested version attaches to the current
    // database instead of accidentally requesting a downgrade.
    const request = indexedDB.open(DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export {};
