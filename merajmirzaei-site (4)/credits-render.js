// Renders credits.html / releases.html (both languages) from
// /data/credits.json as a grid of uniform track cards — one component
// shared by both pages, so every card (client credit or MIRAGE release,
// with or without audio) has identical structure and size. Each page sets
// window.__CREDITS_CONFIG__ = { lang: 'en'|'fa', page: 'credits'|'releases',
// mount: '#id' } before loading this script.
//
// Public pages only ever read these fields: artist_en/fa, title_en/fa,
// release_type, links, cover_url, role_*. status_* and notes are
// admin-only and are never touched here.
(function(){
  var cfg = window.__CREDITS_CONFIG__;
  if(!cfg) return;
  var lang = cfg.lang, page = cfg.page;
  var mount = document.querySelector(cfg.mount);
  if(!mount) return;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  var FA_DIGITS = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function faDigits(n){
    return String(n).replace(/[0-9]/g, function(d){ return FA_DIGITS[+d]; });
  }

  // Any of an entry's free-form links can carry the playable Spotify/YouTube
  // source for the existing one-click embed player, identified by URL shape
  // (not by label, so renaming a label in the admin UI never breaks this).
  function findLink(links, re){
    if(!Array.isArray(links)) return null;
    for(var i=0;i<links.length;i++){ if(re.test(links[i].url||'')) return links[i]; }
    return null;
  }
  var RE_SPOTIFY_ARTIST = /open\.spotify\.com\/artist\//i;
  var RE_SPOTIFY_PLAYABLE = /open\.spotify\.com\/(album|track)\/([A-Za-z0-9]+)/i;
  var RE_YOUTUBE_WATCH = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
  var RE_YOUTUBE_CHANNEL = /youtube\.com\/(@|channel\/)/i;

  function spotifyPlayable(links){
    var l = findLink(links, RE_SPOTIFY_PLAYABLE);
    if(!l) return null;
    var m = l.url.match(RE_SPOTIFY_PLAYABLE);
    return { kind: m[1].toLowerCase(), id: m[2] };
  }
  function youtubeId(links){
    var l = findLink(links, RE_YOUTUBE_WATCH);
    if(!l) return null;
    var m = l.url.match(RE_YOUTUBE_WATCH);
    return m[1];
  }

  // Links that are NOT the artist-profile link, NOT the page-level YouTube
  // channel link, and NOT the playable Spotify/YouTube source render as an
  // ordinary "extra" link (e.g. a Telegram download) attached to the card,
  // exactly like the Telegram link already did before this rewrite. All
  // external, so always target=_blank.
  function extraLinks(links){
    if(!Array.isArray(links)) return [];
    return links.filter(function(l){
      if(!l.url) return false;
      if(RE_SPOTIFY_ARTIST.test(l.url)) return false;
      if(RE_SPOTIFY_PLAYABLE.test(l.url)) return false;
      if(RE_YOUTUBE_WATCH.test(l.url)) return false;
      if(RE_YOUTUBE_CHANNEL.test(l.url)) return false;
      return true;
    });
  }

  var ROLE_LABELS = {
    en: { role_arrangement:'Arrangement', role_production:'Production', role_mix:'Mix', role_mastering:'Master' },
    fa: { role_arrangement:'تنظیم', role_production:'پروداکشن', role_mix:'میکس', role_mastering:'مستر' },
  };
  var ROLE_ORDER = ['role_arrangement','role_production','role_mix','role_mastering'];
  function roleBadges(entry){
    var labels = ROLE_LABELS[lang];
    return ROLE_ORDER.filter(function(f){ return !!entry[f]; })
      .map(function(f){ return '<span class="tc-role">'+esc(labels[f])+'</span>'; })
      .join('');
  }

  var PENDING_TEXT = { en:'catalogue being verified', fa:'فهرست آثار در حال تأیید است' };

  // Same fallback glyph already used for a broken cover image elsewhere on
  // the site (see the onerror handler below), rendered directly here when
  // an entry simply has no cover_url yet, so every card gets a same-size
  // cover slot whether or not art exists.
  function coverFallbackSvg(){
    return '<svg class="thumb-fallback" viewBox="0 0 42 42" role="img" aria-label="No cover art available" xmlns="http://www.w3.org/2000/svg">'
      + '<circle class="note-head" cx="17" cy="31" r="5.5"/>'
      + '<rect class="note-stem" x="21" y="9" width="2.6" height="23" rx="1.3"/>'
      + '<path class="note-flag" d="M23.6 9c5.5 1.2 8 5 6.8 10-1.1-3.4-3.6-5.2-6.8-6.2z"/>'
      + '</svg>';
  }

  // One card, identical structure whether or not the entry is playable —
  // only the play button vs. an equal-size empty spacer differs.
  function renderCard(entry){
    var sp = spotifyPlayable(entry.links);
    var yt = youtubeId(entry.links);
    var playable = !!(sp && sp.kind === 'album');
    var extras = extraLinks(entry.links);
    var tg = extras[0];

    var artistPrimary = lang === 'fa' ? entry.artist_fa : entry.artist_en;
    var artistAlt = lang === 'fa' ? entry.artist_en : entry.artist_fa;
    var artistLink = findLink(entry.links, RE_SPOTIFY_ARTIST);

    var hasTitle = !!(entry.title_en || entry.title_fa);
    var titlePrimary = hasTitle ? (lang === 'fa' ? entry.title_fa : entry.title_en) : PENDING_TEXT[lang];
    var titleAlt = hasTitle ? (lang === 'fa' ? entry.title_en : entry.title_fa) : '';
    var titlePrimaryClass = 'tc-title' + (hasTitle ? '' : ' tc-title-pending');

    var coverHtml = entry.cover_url
      ? '<img class="tc-img" src="'+esc(entry.cover_url)+'" loading="lazy" alt="">'
      : coverFallbackSvg();

    var artistHtml = artistLink
      ? '<a class="tc-artist" href="'+esc(artistLink.url)+'" target="_blank" rel="noopener noreferrer">'+esc(artistPrimary)+'</a>'
      : '<span class="tc-artist">'+esc(artistPrimary)+'</span>';

    var bodyHtml = '<div class="tc-cover">'+coverHtml+'</div>'
      + '<div class="tc-body">'
      + artistHtml
      + (artistAlt ? '<span class="tc-artist-alt">'+esc(artistAlt)+'</span>' : '')
      + '<span class="'+titlePrimaryClass+'">'+esc(titlePrimary)+'</span>'
      + (titleAlt ? '<span class="tc-title-alt">'+esc(titleAlt)+'</span>' : '')
      + '<span class="tc-roles">'+roleBadges(entry)+'</span>'
      + '</div>';

    if(!playable){
      return '<div class="trackcard-wrap"><div class="trackcard">'+bodyHtml+'<span class="tc-play-spacer" aria-hidden="true"></span></div></div>';
    }

    var attrs = ' data-embed="'+esc('https://open.spotify.com/embed/album/'+sp.id+'?utm_source=generator&theme=0')+'"'
      + ' data-uri="spotify:album:'+esc(sp.id)+'" data-h="152"';
    if(yt) attrs += ' data-yt="'+esc(yt)+'"';
    if(tg){
      // Telegram gets the same localized-label treatment as Spotify/YouTube
      // (detected by URL, not by stored label) so the existing button text
      // is preserved exactly; any other free-form link uses its own
      // admin-entered label as-is, since there's no per-language label field.
      var isTelegram = /t\.me\//i.test(tg.url);
      var tgLabel = isTelegram ? (lang==='fa'?'دانلود از تلگرام':'Download on Telegram') : (tg.label || tg.url);
      attrs += ' data-tg="'+esc(tg.url)+'" data-tglabel="'+esc(tgLabel)+'"';
    }

    return '<div class="trackcard-wrap"><button class="trackcard sp" type="button"'+attrs+' aria-expanded="false">'
      + bodyHtml
      + '<span class="tc-play play">▶</span>'
      + '</button><div class="player"></div></div>';
  }

  function renderGrid(entries){
    mount.innerHTML = entries.map(renderCard).join('');
  }

  fetch('/data/credits.json')
    .then(function(r){ return r.json(); })
    .then(function(data){
      var isMirage = function(e){ return (e.artist_en||'').trim().toUpperCase() === 'MIRAGE'; };

      if(page === 'credits'){
        var credits = data.filter(function(e){ return !isMirage(e); });
        renderGrid(credits);
        var titledCount = credits.filter(function(e){ return e.title_en || e.title_fa; }).length;
        var statEl = document.getElementById('titlesCount');
        if(statEl) statEl.textContent = lang === 'fa' ? faDigits(titledCount) : String(titledCount);
      } else if(page === 'releases'){
        var mirage = data.filter(isMirage);
        renderGrid(mirage);

        var artistLink = null, channelLink = null;
        for(var i=0;i<mirage.length && (!artistLink || !channelLink);i++){
          artistLink = artistLink || findLink(mirage[i].links, RE_SPOTIFY_ARTIST);
          channelLink = channelLink || findLink(mirage[i].links, RE_YOUTUBE_CHANNEL);
        }
        var linkrowHtml = '';
        if(artistLink) linkrowHtml += '<a class="btn" href="'+esc(artistLink.url)+'" target="_blank" rel="noopener noreferrer">Spotify</a>\n  ';
        if(channelLink) linkrowHtml += '<a class="btn" href="'+esc(channelLink.url)+'" target="_blank" rel="noopener noreferrer">YouTube</a>';
        var linkrowMount = document.querySelector(cfg.linkrowMount);
        if(linkrowMount) linkrowMount.innerHTML = linkrowHtml;
      }
      document.dispatchEvent(new CustomEvent('credits-rendered'));
    })
    .catch(function(err){
      mount.innerHTML = '<p style="color:var(--muted)">Could not load data right now.</p>';
      if (window.console) console.error('credits-render:', err);
    });
})();
