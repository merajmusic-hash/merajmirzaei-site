#!/usr/bin/env python3
"""Phone-layout check for every page of the site.

Most visitors are on a phone, so a page that scrolls sideways or has text
against the screen edge is a broken page. This opens every URL of the
sitemap at several phone widths and fails if it finds:

  overflow  the page is wider than the screen (it scrolls sideways)
  outside   a visible element sticking out past a screen edge (other than
            inside a row that is meant to scroll sideways, like the menu)
  edge      text closer than 8px to a screen edge
  clipped   text cut off by its own box
  covered   the end of the page hidden under the fixed social bar

Run it against a local preview (or the live site):

  pip install playwright && playwright install chromium
  npx wrangler dev                       # in another terminal
  python scripts/audit-phone.py http://localhost:8787

Options: --widths 320,360,390,412   --limit N (first N pages only)
"""
import re, sys, urllib.request
from playwright.sync_api import sync_playwright

args = sys.argv[1:]
BASE = (args[0] if args and not args[0].startswith('--') else 'http://localhost:8787').rstrip('/')
WIDTHS = [320, 360, 390, 412]
LIMIT = None
for i, a in enumerate(args):
    if a == '--widths': WIDTHS = [int(x) for x in args[i + 1].split(',')]
    if a == '--limit': LIMIT = int(args[i + 1])

CHECK = r"""
() => {
  const vw = document.documentElement.clientWidth;
  const out = { vw, docW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, outside: [], edge: [], clipped: [], covered: null };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    if (c) s += '.' + c;
    return s;
  };
  const scrollerOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const hiddenAncestor = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (p.hidden) return true;
    }
    return false;
  };
  const seen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'BR', 'NOSCRIPT'].includes(el.tagName)) continue;
    if (hiddenAncestor(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1.5 || r.left < -1.5) && !scrollerOf(el) && !el.closest('.mm-social-bar') && getComputedStyle(el).position !== 'fixed') {
      // report the outermost offender only
      let parentOff = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (seen.has(p)) { parentOff = true; break; }
      seen.add(el);
      if (!parentOff) out.outside.push(desc(el) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + '] ' + (el.textContent || '').trim().slice(0, 40));
    }
    const cs = getComputedStyle(el);
    if (/(hidden|clip)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && el !== document.body && el !== document.documentElement
        && el.children.length <= 3 && (el.textContent || '').trim() && cs.textOverflow !== 'ellipsis') {
      out.clipped.push(desc(el) + ' ' + el.clientWidth + '<' + el.scrollWidth + ' ' + (el.textContent || '').trim().slice(0, 40));
    }
  }
  // text too close to a screen edge
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const edgeSeen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || hiddenAncestor(el) || !visible(el)) continue;
    if (scrollerOf(el) || getComputedStyle(el).position === 'fixed') continue;
    let fixedAncestor = false;
    for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') { fixedAncestor = true; break; }
    if (fixedAncestor) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      if (r.left < 7.5 || r.right > vw - 7.5) {
        const key = desc(el);
        if (!edgeSeen.has(key)) { edgeSeen.add(key); out.edge.push(key + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + '] ' + n.nodeValue.trim().slice(0, 40)); }
        break;
      }
    }
  }
  // the end of the page under the fixed social bar
  const bar = document.querySelector('.mm-social-bar');
  if (bar && getComputedStyle(bar).display !== 'none') {
    const br = bar.getBoundingClientRect();
    const docH = document.documentElement.scrollHeight;
    // last piece of real content on the page
    let lastBottom = 0, lastEl = null;
    for (const el of document.querySelectorAll('main *, footer *')) {
      if (hiddenAncestor(el) || !visible(el) || el.children.length) continue;
      const b = el.getBoundingClientRect().bottom + scrollY;
      if (b > lastBottom) { lastBottom = b; lastEl = el; }
    }
    const barTopAtEnd = docH - (innerHeight - br.top);
    out.covered = lastBottom > barTopAtEnd + 1 ? (desc(lastEl) + ' ends ' + Math.round(lastBottom - barTopAtEnd) + 'px under the bar: ' + (lastEl.textContent || '').trim().slice(0, 30)) : null;
    out.bar = { h: Math.round(br.height), bottomGap: Math.round(innerHeight - br.bottom) };
  }
  out.outside = out.outside.slice(0, 8); out.edge = out.edge.slice(0, 8); out.clipped = out.clipped.slice(0, 8);
  return out;
}
"""

def site_paths():
    xml = urllib.request.urlopen(BASE + '/sitemap.xml').read().decode('utf-8')
    paths = [re.sub(r'^https?://[^/]+', '', loc) or '/' for loc in re.findall(r'<loc>([^<]+)</loc>', xml)]
    return paths[:LIMIT] if LIMIT else paths


def problems(res):
    found = []
    if res['docW'] > res['vw'] + 1:
        found.append(f"overflow: page is {res['docW']}px wide on a {res['vw']}px screen")
    for kind in ('outside', 'edge', 'clipped'):
        found += [f'{kind}: {item}' for item in res[kind]]
    if res.get('covered'):
        found.append('covered: ' + res['covered'])
    return found


def main():
    paths = site_paths()
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in WIDTHS:
            # en-GB so the English pages don't redirect to their Persian twin
            ctx = browser.new_context(viewport={'width': width, 'height': 740}, is_mobile=True, has_touch=True, locale='en-GB')
            page = ctx.new_page()
            bad = 0
            for path in paths:
                try:
                    page.goto(BASE + path, wait_until='load', timeout=30000)
                    page.wait_for_timeout(250)
                    found = problems(page.evaluate(CHECK))
                except Exception as err:  # a page that fails to load is a failure too
                    found = ['could not check: ' + str(err)[:120]]
                if found:
                    bad += 1
                    print(f'FAIL {path} @{width}px')
                    for line in found[:6]:
                        print('     ' + line[:160])
            print(f'{"ok  " if not bad else "FAIL"} {width}px: {len(paths) - bad}/{len(paths)} pages clean')
            failures += bad
            ctx.close()
        browser.close()
    print('\nPASS' if not failures else f'\nFAIL: {failures} page/width combinations with problems')
    sys.exit(0 if not failures else 1)


if __name__ == '__main__':
    main()
