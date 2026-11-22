"""Exact locator QA on an isolated production build; generated EPUBs only."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from threading import Thread
from time import monotonic
from urllib.parse import urlsplit
from zipfile import ZipFile
from playwright.sync_api import sync_playwright, expect

def zipped(members):
    buf = BytesIO()
    with ZipFile(buf, 'w') as z:
        for k, v in members.items():
            z.writestr(k, v)
    return buf.getvalue()

def epub(title):
    paras = ''.join(f'<p id="p{i}">Marker {i:03}. '+("The near field joined the night's constellations, obscured by a gentle mist. " * 12)+'</p>' for i in range(96))
    return zipped({
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OPS/package.opf": f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">locator-qa</dc:identifier><dc:title>{title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
        "OPS/one.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title></head><body><p>Preface</p></body></html>',
        "OPS/two.xhtml": f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Long second chapter</title></head><body><h1>Long second chapter</h1>{paras}</body></html>',
    })

def restore(p, title, progress=0, locator=None, stamp=1000000000000):
    book = dict(id="locator-qa", title=title, progress=progress, lastLocator=locator,
                importedAt=stamp, lastOpenedAt=stamp)
    content = zipped({"books/locator-qa.epub": epub(title), "backup.json": json.dumps(dict(
        format="better-epub-backup", version=1, books=[dict(
            source="books/locator-qa.epub", book=book,
            preferences=dict(theme="paper", reduceMotion=True),
            annotations=[], sessions=[])]))})
    p.locator('input[accept*="betterepub-backup"]').set_input_files(
        dict(name="qa.betterepub-backup", mimeType="application/zip", buffer=content))
    expect(p.get_by_role('status')).to_contain_text('1 book restored', timeout=12000)

READ_JS = """() => new Promise((resolve,reject)=>{
  const req=indexedDB.open('better-epub'); req.onsuccess=()=>{
    const db=req.result; const row=db.transaction('books').objectStore('books').get('locator-qa');
    row.onsuccess=()=>{db.close();resolve(row.result)};row.onerror=reject;
  };req.onerror=reject;
})"""

# Poll the stored *within-chapter* progression, rather than overall chapter percentage.
def wait_move(page, lower):
    until = monotonic() + 8
    while monotonic() < until:
        book = page.evaluate(READ_JS) or {}
        loc = book.get('lastLocator') or {}
        if loc.get('href') == 'OPS/two.xhtml' and (loc.get('locations', {}).get('progression') or 0) > lower:
            return book
        page.wait_for_timeout(80)
    raise AssertionError(f'Reading did not advance from {lower}; final stored locator was {loc}')

def locator_flow(browser, base):
    ctx=browser.new_context(viewport={'width':1040,'height':760})
    ctx.route('**/*', lambda r:r.continue_() if urlsplit(r.request.url).hostname=='127.0.0.1' else r.abort())
    sender=ctx.new_page(); reader=ctx.new_page()
    sender.goto(base); restore(sender, 'Starting Copy')
    reader.goto(base)
    reader.evaluate("""() => Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker not ready')), 10000)),
    ]).then(() => undefined)""")
    if not reader.evaluate('Boolean(navigator.serviceWorker.controller)'):
        reader.reload()
    reader.wait_for_function('Boolean(navigator.serviceWorker.controller)')
    reader.get_by_role('button',name='Open Starting Copy').click()
    nxt=reader.get_by_role('button',name='Next page'); expect(nxt).to_be_visible(timeout=15000)
    reader.get_by_role('button', name='Chapter 2', exact=True).click()
    reader.wait_for_function("""() => Array.from(document.querySelectorAll('.readium-container iframe')).some(
        f => f.contentDocument?.querySelector('#p0') && f.getBoundingClientRect().width > 0)""")
    # Let the move to the second spine item and its persistent write settle.
    until=monotonic()+8
    while monotonic()<until:
        start=sender.evaluate(READ_JS)
        if (start.get('lastLocator') or {}).get('href') == 'OPS/two.xhtml': break
        reader.wait_for_timeout(80)
    else:
        raise AssertionError('Could not open chapter 2')
    nxt.click()
    moved=wait_move(reader, (start.get('lastLocator') or {}).get('locations',{}).get('progression') or 0)
    for _ in range(2):
        nxt.click()
        moved=wait_move(reader, moved['lastLocator']['locations']['progression'])
    assert moved['progress'] == 0.5, moved
    exact=moved['lastLocator']
    part=exact['locations']['progression']
    stamp=1234567890000
    restore(sender, 'Restored Copy', moved['progress'], exact, stamp)
    expect(reader.locator('.reader-title strong')).to_have_text('Restored Copy', timeout=15000)
    expect(nxt).to_be_visible(timeout=15000)
    reader.wait_for_timeout(900)
    passive=sender.evaluate(READ_JS)
    print('REFERENCE', json.dumps(dict(locator=exact, progress=moved['progress'], stamp=stamp), sort_keys=True))
    print('AFTER REMOUNT', json.dumps({k:passive[k] for k in ('lastLocator','progress','lastOpenedAt')},sort_keys=True))
    reader.reload()
    reader.get_by_role('button',name='Open Restored Copy').click()
    expect(nxt).to_be_visible(timeout=15000)
    reader.wait_for_timeout(900)
    reopened=sender.evaluate(READ_JS)
    print('AFTER REOPEN', json.dumps({k:reopened[k] for k in ('lastLocator','progress','lastOpenedAt')},sort_keys=True))
    nxt.click()
    advanced=wait_move(reader, part)
    print('AFTER NEXT', json.dumps({k:advanced[k] for k in ('lastLocator','progress','lastOpenedAt')},sort_keys=True))
    reader.reload()
    reader.get_by_role('button',name='Open Restored Copy').click(); expect(nxt).to_be_visible(timeout=15000)
    reader.wait_for_timeout(900)
    final=sender.evaluate(READ_JS)
    print('AFTER NEXT + REOPEN', json.dumps({k:final[k] for k in ('lastLocator','progress','lastOpenedAt')},sort_keys=True))
    ctx.close()
    assert passive['lastLocator']==reopened['lastLocator']==exact, 'Exact in-chapter locator changed on remount/reopen'
    assert passive['progress']==reopened['progress']==advanced['progress']==final['progress']==0.5
    assert advanced['lastLocator']==final['lastLocator'], 'Next-page locator failed to survive reopen'
    assert passive['lastOpenedAt']==stamp, 'Restore-triggered remount rewrote restored timestamp without input'
    print('PASS exact restored locator, passive timestamp, and next-page persistence')

def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('dist', type=Path, help='Production build directory (npm run build)')
    cli.add_argument('--chromium', help='Use an existing Chromium executable instead of Playwright’s managed browser')
    args = cli.parse_args()
    dist = args.dist.resolve()
    if not (dist / 'index.html').is_file() or not (dist / 'service-worker.js').is_file():
        cli.error(f'{dist} does not contain a production PWA build; run npm run build first')
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self,*_): pass
    server=ThreadingHTTPServer(('127.0.0.1',0), partial(Quiet,directory=str(dist)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as api:
            browser=api.chromium.launch(executable_path=args.chromium,args=['--disable-gpu','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
            print('Chromium', browser.version, flush=True)
            locator_flow(browser, f'http://127.0.0.1:{server.server_port}/')
            browser.close()
    finally:
        server.shutdown();server.server_close()
if __name__=='__main__':main()
