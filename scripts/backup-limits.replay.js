import { createLibraryBackup, restoreLibraryBackup } from "../src/lib/backup";
import { db } from "../src/lib/db";
import { importEpub } from "../src/lib/epub";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";

async function fixture() {
  const text = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/package.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>synthetic</dc:identifier><dc:title>Synthetic EPUB</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Synthetic chapter.</p></body></html>',
  };
  const bytes = zipSync(Object.fromEntries(Object.entries(text).map(([name, body]) => [name, strToU8(body)])));
  const file = new File([bytes], "fixture.epub", {type:"application/epub+zip"});
  return { bytes, file, book: (await importEpub(file)).book };
}

async function clearSyntheticData() {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}

async function attempt(count) {
  const { bytes, file, book } = await fixture();
  const ids = Array.from({length:count}, (_,i) => "synthetic-"+String(i+1).padStart(4,"0"));
  await db.transaction("rw", [db.books, db.resources], async () => {
    await db.books.bulkPut(ids.map(id=>({...book,id,progress:.25})));
    await db.resources.bulkPut(ids.map(bookId=>({bookId,path:"__source__.epub",mediaType:"application/epub+zip",blob:file})));
  });

  let backupFile, exportError, restoreError, returnedCount, archivedCount, reloadedCount, bytesMatch;
  try {
    const backup = await createLibraryBackup();
    returnedCount = backup.bookCount;
    backupFile = new File([backup.blob],backup.name,{type:backup.blob.type});
    const zip = unzipSync(new Uint8Array(backup.bytes));
    archivedCount = JSON.parse(strFromU8(zip["backup.json"])).books.length;
  } catch (e) {
    exportError = String(e.message);
  }
  if (backupFile) {
    await clearSyntheticData();
    try {
      reloadedCount = await restoreLibraryBackup(backupFile);
      const source = await db.resources.get([ids[0],"__source__.epub"]);
      const restoredBytes = new Uint8Array(await source.blob.arrayBuffer());
      bytesMatch = restoredBytes.length === bytes.length && restoredBytes.every((value,i)=>value===bytes[i]);
    } catch (e) {
      restoreError = String(e.message);
    }
  }
  await clearSyntheticData();
  return { count, fixtureBytes:bytes.length, exportError, returnedCount, archiveBytes:backupFile?.size, archivedCount, restoreError, reloadedCount, bytesMatch };
}

export async function replay() {
  await db.open();
  const cases = [];
  for (const count of [1000,1001]) cases.push(await attempt(count));
  const [good,bad] = cases;
  return { cases, passed:good.returnedCount===1000 && good.reloadedCount===1000 && good.bytesMatch && !bad.archiveBytes && /1,000/.test(bad.exportError) };
}
