"""Observe one suspended old Readium reader across a same-origin PWA restore."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from time import monotonic
from urllib.parse import urlsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeout, expect, sync_playwright

from check_release_cycle import expected_asset, wait_stage
from check_restore_locator import READ_JS, restore, wait_move

PREFIX = 'FROZEN_READER '
# Observe the old document only. No injected writes or changes to application scheduling.
PROBE = """prefix => {
    const emit = (event, detail = {}) => console.info(prefix + JSON.stringify({event, ...detail}));
    const snapshot = v => ({
        locator: v.lastLocator ?? null, progress: v.progress ?? null,
        revision: v.restoreRevision ?? null, opened: v.lastOpenedAt ?? null
    });
    let order = 0;
    for (const method of ['put', 'add']) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {
            const value = args[0];
            if (this.name !== 'books' || this.transaction.db.name !== 'better-epub' ||
                (value?.id ?? args[1]) !== 'locator-qa')
                return original.apply(this, args);
            const detail = {order: ++order, method, ...snapshot(value)};
            emit('old-write-attempt', detail);
            const result = original.apply(this, args);
            this.transaction.addEventListener('complete', () => emit('old-write-committed', detail), {once: true});
            this.transaction.addEventListener('abort', () => emit('old-write-aborted', detail), {once: true});
            return result;
        };
    }
    document.addEventListener('freeze', () => emit('old-freeze'));
    document.addEventListener('resume', () => emit('old-resume'));
    navigator.serviceWorker.addEventListener('controllerchange', () => emit('old-controllerchange'));
    window.initialReleaseMarker = true;
}"""


def position(row):
    return {k: row.get(k) for k in ('lastLocator', 'progress', 'restoreRevision', 'lastOpenedAt')}


def exercise(browser, origin, selector, candidate, baseline):
    old_asset, new_asset = expected_asset(baseline), expected_asset(candidate)
    if old_asset == new_asset:
        print('SKIP same application bundle: no old/new frozen reader handoff to test', flush=True)
        return
    assert (baseline / 'service-worker.js').read_bytes() != (candidate / 'service-worker.js').read_bytes()
    ctx = browser.new_context(viewport={'width': 1040, 'height': 760})
    ctx.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(origin).netloc else r.abort())
    active, reader = ctx.new_page(), ctx.new_page()
    events = []

    def emit(event, **detail):
        events.append(event)
        print(PREFIX + json.dumps(dict(event=event, **detail), sort_keys=True), flush=True)

    def console(message):
        if message.text.startswith(PREFIX):
            entry = json.loads(message.text[len(PREFIX):])
            event = entry.pop('event')
            emit(event, **entry)

    reader.on('console', console)
    reader.on('framenavigated', lambda f: emit('reader-navigation') if f == reader.main_frame else None)

    try:
        active.goto(f'{origin}/index.html')
        wait_stage(active, old_asset)
        restore(active, 'Old Reader Copy')
        reader.goto(f'{origin}/index.html')
        wait_stage(reader, old_asset)
        reader.evaluate(PROBE, PREFIX)
        reader.get_by_role('button', name='Open Old Reader Copy').click()
        nxt = reader.get_by_role('button', name='Next page')
        expect(nxt).to_be_visible(timeout=15000)
        reader.get_by_role('button', name='Chapter 2', exact=True).click()
        reader.wait_for_function("""() => Array.from(document.querySelectorAll('.readium-container iframe')).some(
            f => f.contentDocument?.querySelector('#p0') && f.getBoundingClientRect().width > 0)""")
        until = monotonic() + 8
        while monotonic() < until:
            row = active.evaluate(READ_JS)
            if (row.get('lastLocator') or {}).get('href') == 'OPS/two.xhtml':
                break
            active.wait_for_timeout(80)
        else:
            raise AssertionError('Old Readium session did not reach chapter 2')
        before = row['lastLocator']['locations'].get('progression') or 0
        old_commits = events.count('old-write-committed')
        nxt.click()
        moved = wait_move(active, before)
        deadline = monotonic() + 2
        while events.count('old-write-committed') == old_commits and monotonic() < deadline:
            active.wait_for_timeout(80)
        assert events.count('old-write-committed') > old_commits, 'No verified pre-freeze probe write'
        assert moved['lastLocator']['href'] == 'OPS/two.xhtml' and not moved.get('restoreRevision')
        expect(reader.locator('.reader-title strong')).to_have_text('Old Reader Copy')
        emit('old-reader-positioned', **position(moved))

        # This must be an actual background tab before the lifecycle command.
        active.bring_to_front()
        reader.wait_for_function("() => document.visibilityState === 'hidden'", timeout=5000, polling=80)
        emit('old-reader-hidden')
        cdp = ctx.new_cdp_session(reader)
        # CDP changes the actual renderer lifecycle, rather than only setting document visibility.
        # Do not evaluate JS or perform a user action in the suspended reader until it is thawed.
        freeze_window = len(events)
        emit('freeze-requested')
        cdp.send('Page.setWebLifecycleState', {'state': 'frozen'})
        try:
            # Establish the precondition before starting the service-worker update.
            until = monotonic() + 5
            while 'old-freeze' not in events[freeze_window:] and monotonic() < until:
                active.wait_for_timeout(80)
            assert 'old-freeze' in events[freeze_window:], (
                'CDP freeze was not acknowledged; no update or restore was attempted')
            emit('freeze-acknowledged-before-update')
            active.evaluate('window.initialReleaseMarker = true')
            selector['dist'] = candidate
            active.evaluate("""() => {
                navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {});
            }""")
            wait_stage(active, new_asset, changed=True)
            emit('active-upgraded', asset=new_asset)
            restore(active, 'Restored While Reader Frozen', progress=0.125, stamp=1234567890000,
                    locator=dict(href='OPS/one.xhtml', type='application/xhtml+xml',
                                 locations=dict(position=1, progression=0, totalProgression=0.125)))
            restored = position(active.evaluate(READ_JS))
            assert restored['restoreRevision'] and restored['lastLocator']['href'] == 'OPS/one.xhtml'
            assert restored['progress'] == 0.125 and restored['lastOpenedAt'] == 1234567890000
            emit('restore-committed-before-thaw', **restored)
            before_thaw = events[freeze_window:]
            assert 'old-resume' not in before_thaw and 'reader-navigation' not in before_thaw, (
                'Old reader resumed or navigated before the deliberate thaw')
            window = len(events)
        finally:
            emit('thaw-requested')
            cdp.send('Page.setWebLifecycleState', {'state': 'active'})
            cdp.detach()

        # Poll via the active tab throughout thaw. Also take the final snapshot
        # after automatic navigation; no forced reload or synthetic old DB write.
        deadline = monotonic() + 30
        samples = []
        reloaded = False
        while monotonic() < deadline:
            sample = position(active.evaluate(READ_JS))
            if sample != restored and (not samples or samples[-1] != sample):
                samples.append(sample)
                emit('restored-position-changed', **sample)
            try:
                reader.wait_for_function("""asset => [...document.scripts].some(
                    s => s.getAttribute('src') === asset) && !window.initialReleaseMarker &&
                    !!navigator.serviceWorker.controller""", arg=new_asset, timeout=600)
            except PlaywrightTimeout:
                continue
            reloaded = True
            break
        if reloaded:
            active.wait_for_timeout(800)
        final = position(active.evaluate(READ_JS))
        tail = events[window:]
        emit('final-position', **final, reloaded=reloaded,
             old_attempts=tail.count('old-write-attempt'), old_commits=tail.count('old-write-committed'))
        assert reloaded, 'Old reader did not automatically load the new bundle after this thaw'
        assert not samples and final == restored, 'Restored locator/revision changed while the old reader thawed'
        if not tail.count('old-write-attempt'):
            print('OBSERVED BOUND: no old reader write attempt was observed in this frozen/thaw run.', flush=True)
        print('PASS suspended reader reloaded and preserved the restored locator and revision in this run', flush=True)
    finally:
        ctx.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dist', type=Path, help='Candidate production build')
    parser.add_argument('baseline', type=Path, help='Previous production build (exact PR base in CI)')
    parser.add_argument('--chromium', help='Use an existing Chromium executable')
    args = parser.parse_args()
    candidate, baseline = args.dist.resolve(), args.baseline.resolve()
    for release in (candidate, baseline):
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
            # Use full Chromium (new headless) for real multi-tab visibility.
            target = {'executable_path': args.chromium} if args.chromium else {'channel': 'chromium'}
            browser = api.chromium.launch(**target, ignore_default_args=[
                '--disable-backgrounding-occluded-windows',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
            ], args=[
                '--disable-gpu', '--disable-background-networking',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            ])
            print('Chromium', browser.version, flush=True)
            try:
                exercise(browser, f'http://127.0.0.1:{server.server_port}', selector, candidate, baseline)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
