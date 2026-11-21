import { createLibraryBackup, restoreLibraryBackup } from "../src/lib/backup";
import { db, DEFAULT_PREFERENCES } from "../src/lib/db";
import { importEpub } from "../src/lib/epub";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

const stores = ["books", "resources", "annotations", "preferences", "sessions"];
const keys = ["one", "two"];
const waitRequest = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const equalBytes = (a, b) => a.length === b.length && a.every((v,i) => v === b[i]);

async function fixture(epoch, id) {
  const title = epoch + "-" + id;
  const progress = epoch === "A" ? .2 : .8;
  const locator = { href: "OPS/chapter.xhtml", type: "application/xhtml+xml", locations: { progression: progress } };
  const bytes = zipSync(Object.fromEntries(Object.entries({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/package.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>'+id+'</dc:identifier><dc:title>'+title+'</dc:title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>'+title+'</p></body></html>',
  }).map(([path, text]) => [path, strToU8(text)])));
  const file = new File([bytes], id+".epub", {type:"application/epub+zip"});
  const imported = await importEpub(file);
  return {
    bytes,
    book: {...imported.book, id, progress, lastLocator: locator},
    resources: imported.resources.map(r => ({...r, bookId:id})),
    annotations: [{id:"note-"+id, bookId:id, type:"note", locator, note:title, createdAt:10, updatedAt:11}],
    preferences: {bookId:id, ...DEFAULT_PREFERENCES, theme:epoch === "A" ? "sepia" : "night"},
    sessions: [{id:"session-"+id, bookId:id, startedAt:10, endedAt:20, startProgress:0, endProgress:progress}],
  };
}
function write(connection, fixtures) {
  const tx = connection.transaction(stores, "readwrite");
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error("Writer aborted"));
  });
  for (const row of fixtures) {
    tx.objectStore("books").put(row.book);
    for (const s of ["resources","annotations","sessions"]) for (const value of row[s]) tx.objectStore(s).put(value);
    tx.objectStore("preferences").put(row.preferences);
  }
  return done;
}

export async function replay() {
  await db.open();
  const peer = await waitRequest(indexedDB.open(db.name));
  if (peer === db.backendDB()) throw new Error("Expected independent connections");
  const A = await Promise.all(keys.map(id => fixture("A",id)));
  const B = await Promise.all(keys.map(id => fixture("B",id)));
  await write(peer, A);
  const events = [];
  let writer;
  // Queue B at delivery of the first books read, before Dexie's handler issues child reads.
  // Never wait for the writer from within the reader's transaction.
  const original = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function(...args) {
    const request = original.apply(this, args);
    if (this.name === "books" && this.transaction.db === db.backendDB()) {
      request.addEventListener("success", () => {
        if (writer) return;
        events.push("books read; queue B");
        writer = write(peer,B).then(() => events.push("B committed"));
      }, {once:true});
    }
    return request;
  };
  let archive;
  try {
    archive = await createLibraryBackup();
  } finally {
    IDBObjectStore.prototype.getAll = original;
  }
  if (!writer) throw new Error("Request-order barrier did not fire");
  await writer;
  peer.close();
  const identify = (bytes,i) => equalBytes(A[i].bytes,bytes) ? "A" : equalBytes(B[i].bytes,bytes) ? "B" : "unknown";
  const summarize = (book, source, notes, preferences, sessions) => ({
    id:book.id, title:book.title, progress:book.progress, locator:book.lastLocator.locations.progression,
    source, notes: notes.map(n=>n.note), theme:preferences.theme, sessions:sessions.map(s=>s.endProgress),
  });
  const entries = unzipSync(new Uint8Array(archive.bytes));
  const manifest = JSON.parse(strFromU8(entries["backup.json"]));
  const exported = manifest.books.map(s => summarize(s.book,identify(entries[s.source],keys.indexOf(s.book.id)),s.annotations,s.preferences,s.sessions));
  async function current() {
    return Promise.all(keys.map(async (key,i) => {
      const resource = await db.resources.get([key,"__source__.epub"]);
      return summarize(await db.books.get(key),identify(new Uint8Array(await resource.blob.arrayBuffer()),i),
        await db.annotations.where("bookId").equals(key).toArray(),await db.preferences.get(key),await db.sessions.where("bookId").equals(key).toArray());
    }));
  }
  const afterWriter = await current();
  // New, ephemeral profile; clear only this script's synthetic rows to prove independent restore.
  await db.transaction("rw", stores, async () => { for (const name of stores) await db.table(name).clear(); });
  const count = await restoreLibraryBackup(new File([archive.bytes],archive.name,{type:"application/zip"}));
  const restored = await current();
  const expected = (epoch) => keys.map(id=>({
    id,title:epoch+"-"+id,progress:epoch==="A"?.2:.8,locator:epoch==="A"?.2:.8,source:epoch,
    notes:[epoch+"-"+id],theme:epoch==="A"?"sepia":"night",sessions:[epoch==="A"?.2:.8]
  }));
  const isEpoch = (rows,epoch) => JSON.stringify(rows) === JSON.stringify(expected(epoch));
  const writerOK = isEpoch(afterWriter,"B");
  const exportA = isEpoch(exported,"A");
  const restoreA = count === 2 && isEpoch(restored,"A");
  db.close();
  return {events, afterWriter, exported, restored, writerOK, exportA, restoreA, pass:writerOK && exportA && restoreA};
}
