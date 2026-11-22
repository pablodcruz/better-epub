"""Test a same-origin old → candidate → old PWA cycle with generated data only."""
import argparse
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from threading import Thread
from time import monotonic
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from check_restore_locator import restore

ASSET = r'src="(\./assets/index-[^"]+\.js)"'
DATABASE_SNAPSHOT = """async () => {
  const promise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await promise(indexedDB.open('better-epub'));
  const stores = Array.from(db.objectStoreNames);
  const tx = db.transaction(stores, 'readonly');
  const values = await Promise.all(stores.map((name) => promise(tx.objectStore(name).getAll())));
  db.close();
  const data = Object.fromEntries(stores.map((name, i) => [name, values[i]]));
  data.resources = await Promise.all(data.resources.map(async ({blob, ...resource}) => ({
    ...resource, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
  })));
  return {version: db.version, data};
}"""
CACHED_INDEX = r"""async () => {
  const indexes = [];
  for (const name of (await caches.keys()).filter(name => name.includes('precache'))) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname !== '/index.html') continue;
      const body = await (await cache.match(request)).text();
      indexes.push(body.match(/src="(\.\/assets\/index-[^"]+\.js)"/)?.[1] || 'missing');
    }
  }
  return indexes;
}"""
READ_RESOURCE = """async () => {
  const response = await fetch('/__books/locator-qa/OPS/two.xhtml');
  return [response.status, (await response.text()).includes('Marker 095')];
}"""
SEED_METADATA = """async () => {
  const db = await new Promise((res, rej) => {
    const request = indexedDB.open('better-epub');
    request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction(['annotations', 'sessions'], 'readwrite');
    tx.objectStore('annotations').put({id: 'seed-note', bookId: 'locator-qa', quote: 'Synthetic text', note: 'Keep this across update', createdAt: 1234, updatedAt: 1234});
    tx.objectStore('sessions').put({id: 'seed-session', bookId: 'locator-qa', startedAt: 1234, endedAt: 2345, durationSeconds: 1, mode: 'read'});
    tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej;
  });
  db.close();
}"""


def expected_asset(dist):
    return re.search(ASSET, (dist / 'index.html').read_text())[1]


def wait_stage(page, expected, *, changed=False):
    page.wait_for_function("""([asset, changed]) => {
      const hit = [...document.scripts].some(script => script.getAttribute('src') === asset);
      return hit && !!navigator.serviceWorker.controller && (!changed || !window.initialReleaseMarker);
    }""", arg=[expected, changed], timeout=30000)
    until = monotonic() + 10
    while monotonic() < until:
        if page.evaluate(CACHED_INDEX) == [expected]:
            return
        page.wait_for_timeout(200)
    raise AssertionError(f'Unexpected precached index bundles: {page.evaluate(CACHED_INDEX)}')


def assert_offline(ctx, origin, asset, title):
    offline_page = ctx.new_page()
    ctx.set_offline(True)
    try:
        response = offline_page.goto(f'{origin}/index.html', wait_until='domcontentloaded')
        assert response.from_service_worker
        wait_stage(offline_page, asset)
        expect(offline_page.get_by_role('button', name=f'Open {title}')).to_be_visible(timeout=10000)
        assert offline_page.evaluate(READ_RESOURCE) == [200, True]
    finally:
        offline_page.close()
        ctx.set_offline(False)


def move_release(page, passive, selector, release, asset, title):
    for tab in (page, passive):
        tab.evaluate('window.initialReleaseMarker = true')
    selector['dist'] = release
    # A registration update check without forced reload. The currently loaded
    # app must handle the new service worker activating and reload itself.
    page.evaluate('''() => { navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {}); }''')
    for tab in (page, passive):
        wait_stage(tab, asset, changed=True)
        expect(tab.get_by_role('button', name=f'Open {title}')).to_be_visible(timeout=10000)
        assert tab.evaluate(READ_RESOURCE) == [200, True]


def exercise(browser, origin, dist, baseline, selector):
    old_asset, new_asset = expected_asset(baseline), expected_asset(dist)
    if old_asset == new_asset:
        print('SKIP same application bundle: no old/new app handoff to test', flush=True)
        return
    assert sha256((baseline / 'service-worker.js').read_bytes()).digest() != sha256(
        (dist / 'service-worker.js').read_bytes()).digest(), 'Worker bytes must change'
    ctx = browser.new_context()
    ctx.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).hostname == '127.0.0.1' else r.abort())
    page = ctx.new_page()
    page.goto(f'{origin}/index.html')
    wait_stage(page, old_asset)
    restore(page, 'Existing v2 Copy', progress=0.5, locator=dict(
        href='OPS/two.xhtml', type='application/xhtml+xml',
        locations=dict(position=2, progression=0.25, totalProgression=0.5)))
    page.evaluate(SEED_METADATA)
    old = page.evaluate(DATABASE_SNAPSHOT)
    assert old['version'] == 20 and 'restoreRevision' not in old['data']['books'][0]
    assert old['data']['annotations'][0]['id'] == 'seed-note'
    assert old['data']['sessions'][0]['id'] == 'seed-session'
    assert_offline(ctx, origin, old_asset, 'Existing v2 Copy')
    print('PASS baseline: old application, precache, legacy v2 library and offline EPUB bytes', flush=True)

    passive = ctx.new_page()
    passive.goto(f'{origin}/index.html')
    wait_stage(passive, old_asset)
    expect(passive.get_by_role('button', name='Open Existing v2 Copy')).to_be_visible(timeout=10000)
    move_release(page, passive, selector, dist, new_asset, 'Existing v2 Copy')
    assert page.evaluate(DATABASE_SNAPSHOT) == old, 'Upgrade changed an untouched existing v2 library'
    assert_offline(ctx, origin, new_asset, 'Existing v2 Copy')
    print('PASS upgrade: same origin/profile, both open old tabs reloaded automatically, existing library remained byte-equivalent', flush=True)

    restore(page, 'Restored v2 Copy', progress=0.75, locator=dict(
        href='OPS/two.xhtml', type='application/xhtml+xml',
        locations=dict(position=2, progression=0.5, totalProgression=0.75)), stamp=1234567890000)
    restored = page.evaluate(DATABASE_SNAPSHOT)
    assert restored['version'] == 20 and restored['data']['books'][0]['restoreRevision']
    assert restored['data']['books'][0]['progress'] == 0.75
    assert restored['data']['annotations'] == restored['data']['sessions'] == []
    assert restored != old

    move_release(page, passive, selector, baseline, old_asset, 'Restored v2 Copy')
    assert page.evaluate(DATABASE_SNAPSHOT) == restored, 'Rollback changed restored v2 data'
    assert_offline(ctx, origin, old_asset, 'Restored v2 Copy')
    print('PASS rollback: previous app and precache work with restored v2 data; a committed restore is not undone', flush=True)
    ctx.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dist', type=Path)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('--chromium')
    args = parser.parse_args()
    dist, baseline = args.dist.resolve(), args.baseline.resolve()
    for release in (dist, baseline):
        if not all((release / p).is_file() for p in ('index.html', 'service-worker.js')):
            parser.error(f'{release} is not a production PWA build')
    selector = {'dist': baseline}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *handler_args):
            super().__init__(*handler_args, directory=str(selector['dist']))

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as api:
            browser = api.chromium.launch(executable_path=args.chromium, args=[
                '--disable-background-networking',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            ])
            print('Chromium', browser.version, flush=True)
            exercise(browser, f'http://127.0.0.1:{server.server_port}', dist, baseline, selector)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
