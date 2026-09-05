// Persistent social-links bar, injected on every public page (both
// languages) via a single <script src="/social-bar.js" defer></script>
// tag — one shared source instead of duplicating markup/CSS in ~20 files.
//
// Layout: a slim vertical column on the right edge on wide viewports, or a
// slim horizontal row along the bottom edge on narrow ones. The switch
// happens well above the site's usual 700px mobile breakpoint (see
// SWITCH_WIDTH below) because the page content itself (.wrap, max-width
// 1080px) already spans edge-to-edge with only ~20px of padding below
// ~1100px — there simply isn't a safe empty margin for a right-edge rail
// to sit in without touching real content until the viewport is wider
// than that. Below the switch width, the bottom bar is safer: it only
// needs its own thin strip at the very bottom, kept clear of the page's
// own content via the extra body padding added below.
(function(){
  if(document.querySelector('.mm-social-bar')) return; // avoid double-injection

  var LINKS = [
    { name: 'Instagram', url: 'https://www.instagram.com/merajmirzaei_music',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>' },
    { name: 'Telegram', url: 'https://t.me/merajmirzaei',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 3.5 2.6 10.8c-.9.35-.9 1.6.02 1.93l4.53 1.62 1.74 5.6c.22.7 1.1.9 1.6.36l2.5-2.7 4.9 3.6c.66.48 1.6.12 1.77-.68l3.2-15.1c.2-.9-.7-1.6-1.4-1.35Zm-3.2 3.4-8.4 7.6-.3 3.1-1.3-4.2 9.6-7.2c.2-.15.45.1.4.35Z"/></svg>' },
    { name: 'YouTube', url: 'https://youtube.com/@miragesohi',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10.3 9.1v5.8l5.1-2.9Z" fill="currentColor" stroke="none"/></svg>' },
    { name: 'Spotify', url: 'https://open.spotify.com/artist/3wHa2wASrgywhttuHleFl1',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9.5"/><path d="M7 10.2c3.2-.9 6.8-.6 9.6 1" stroke-linecap="round"/><path d="M7.6 13c2.7-.7 5.7-.4 8 .9" stroke-linecap="round"/><path d="M8.2 15.6c2.1-.5 4.5-.3 6.3.7" stroke-linecap="round"/></svg>' },
  ];

  var SWITCH_WIDTH = 1180; // px; see comment above

  var style = document.createElement('style');
  style.textContent =
    '.mm-social-bar{position:fixed;z-index:500;display:flex;margin:0;padding:0}' +
    '.mm-social-bar a{display:flex;align-items:center;justify-content:center;' +
      'width:26px;height:26px;color:var(--brass,#C2A878);opacity:.5;' +
      'text-decoration:none;transition:opacity .15s}' +
    '.mm-social-bar a:hover,.mm-social-bar a:focus-visible,.mm-social-bar a:active{opacity:1}' +
    '.mm-social-bar a:focus-visible{outline:2px solid var(--brass,#C2A878);outline-offset:2px;border-radius:3px}' +
    '.mm-social-bar svg{width:19px;height:19px;display:block;pointer-events:none}' +
    '@media(min-width:' + SWITCH_WIDTH + 'px){' +
      '.mm-social-bar{right:16px;top:50%;transform:translateY(-50%);flex-direction:column;gap:16px}' +
    '}' +
    '@media(max-width:' + (SWITCH_WIDTH - 1) + 'px){' +
      '.mm-social-bar{left:0;right:0;bottom:0;justify-content:center;gap:28px;' +
        'padding:9px 0 calc(9px + env(safe-area-inset-bottom));background:transparent}' +
      'body{padding-bottom:calc(50px + env(safe-area-inset-bottom))}' +
    '}';
  document.head.appendChild(style);

  var bar = document.createElement('nav');
  bar.className = 'mm-social-bar';
  bar.setAttribute('aria-label', 'Social links');
  bar.innerHTML = LINKS.map(function(l){
    return '<a href="' + l.url + '" target="_blank" rel="noopener noreferrer" aria-label="' + l.name + '">' + l.svg + '</a>';
  }).join('');
  document.body.appendChild(bar);
})();
