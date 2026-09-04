// Renders credits.html / releases.html / the homepage artist wall (both
// languages) from /data/credits.json. credits.html and releases.html share
// one uniform track-card component, so every card (client credit or MIRAGE
// release, with or without audio) has identical structure and size. The
// homepage ('roster' page) renders a photo-tile grid of selected artists
// instead. Each page sets window.__CREDITS_CONFIG__ = { lang: 'en'|'fa',
// page: 'credits'|'releases'|'roster', mount: '#id' } before loading this
// script.
//
// Public pages only ever read these fields: artist_en/fa, artist_image,
// spotify_artist_url, title_en/fa, release_type, links, cover_url, role_*.
// status_* and notes are admin-only and are never touched here.
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

  // Used both to build each artist tile's filter link on the homepage and
  // to match the credits page's ?artist= query param back to an artist_en.
  function slugify(s){
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

  function byOrder(a, b){ return (a.order || 0) - (b.order || 0); }

  // A tile's image, in priority order: the artist's dedicated artist_image
  // (an override, for later) — then their Spotify artist photo, fetched
  // below — then the cover_url of the first of their entries (in
  // credits.json order) that has one. Artists with none of those get a
  // plain tinted tile.
  function artistImageOf(entries){
    for(var i=0;i<entries.length;i++){ if(entries[i].artist_image) return entries[i].artist_image; }
    return '';
  }
  function coverArtOf(entries){
    for(var i=0;i<entries.length;i++){ if(entries[i].cover_url) return entries[i].cover_url; }
    return '';
  }
  function spotifyArtistUrlOf(entries){
    for(var i=0;i<entries.length;i++){ if(entries[i].spotify_artist_url) return entries[i].spotify_artist_url; }
    return '';
  }

  // The artist's own profile photo, via Spotify's public oEmbed endpoint
  // (no API key needed — the same mechanism that powers Spotify's embed
  // widgets anywhere). Resolves to null on any failure so the caller can
  // fall through to the next tile-image tier.
  function fetchSpotifyArtistImage(url){
    return fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ return (j && j.thumbnail_url) || null; })
      .catch(function(){ return null; });
  }

  function renderArtistTile(nameEn, entries, img){
    var nameFa = entries[0].artist_fa || '';
    var slug = slugify(nameEn);
    var cls = 'aw-tile' + (img ? ' has-photo' : '');
    var imgHtml = img ? '<img class="aw-img" src="'+esc(img)+'" loading="lazy" alt="">' : '';
    var nameHtml = '<span class="aw-name"><span class="aw-en">'+esc(nameEn)+'</span>'
      + (nameFa ? '<span class="aw-fa">'+esc(nameFa)+'</span>' : '') + '</span>';
    return '<a class="'+cls+'" href="credits.html?artist='+slug+'">'+imgHtml+nameHtml+'</a>';
  }

  var MORE_TEXT = { en:'Full credit sheet →', fa:'کارنامه کامل ←' };

  function trackCountLabel(n){
    if(lang === 'fa') return faDigits(n) + ' ' + 'اثر';
    return n + (n === 1 ? ' track' : ' tracks');
  }

  // One collapsible row per artist on the credits page — same photo
  // priority (artist_image, then Spotify, then first cover_url, then a
  // plain tile) as the homepage wall, name pair, and a track count.
  // Renders with whatever sync image is already on hand (artist_image or
  // cover_url) so the page never blocks on a network round trip; any
  // artist that still needs a Spotify lookup gets its row patched in place
  // once that resolves, never a full re-render (which would blow away an
  // already-open accordion section).
  function renderArtistRow(nameEn, entries){
    var nameFa = entries[0].artist_fa || '';
    var slug = slugify(nameEn);
    var primary = lang === 'fa' ? nameFa : nameEn;
    var alt = lang === 'fa' ? nameEn : nameFa;

    var syncImg = artistImageOf(entries) || coverArtOf(entries);
    var photoCls = 'ar-photo' + (syncImg ? ' has-photo' : '');
    var photoHtml = syncImg
      ? '<img class="ar-img" src="'+esc(syncImg)+'" loading="lazy" alt="">'
      : coverFallbackSvg();

    var nameHtml = '<span class="ar-name">'
      + '<span class="ar-primary">'+esc(primary)+'</span>'
      + (alt ? '<span class="ar-alt">'+esc(alt)+'</span>' : '')
      + '</span>';

    var header = '<button class="artist-row" type="button" aria-expanded="false" data-artist="'+slug+'">'
      + '<span class="'+photoCls+'">'+photoHtml+'</span>'
      + nameHtml
      + '<span class="ar-count">'+esc(trackCountLabel(entries.length))+'</span>'
      + '<span class="ar-chevron" aria-hidden="true">⌄</span>'
      + '</button>';

    var tracks = '<div class="artist-tracks" hidden>'
      + '<div class="trackcard-grid">' + entries.map(renderCard).join('') + '</div>'
      + '</div>';

    return '<div class="artist-group" data-artist="'+slug+'">' + header + tracks + '</div>';
  }

  function renderCreditsGrouped(entries){
    var order = [], byArtist = {};
    entries.forEach(function(e){
      var key = (e.artist_en || '').trim();
      if(!key) return;
      if(!byArtist[key]){ byArtist[key] = []; order.push(key); }
      byArtist[key].push(e);
    });

    mount.innerHTML = order.map(function(name){ return renderArtistRow(name, byArtist[name]); }).join('');

    // Accordion: opening one row closes whichever other row was open.
    // Hiding a section that has a track mid-playback would otherwise leave
    // it playing invisibly in the background — the page's own playback
    // script owns pause/cleanup, so trigger it via a real click on the
    // still-expanded track button before the section (and that button)
    // disappear, rather than duplicating its teardown logic here.
    function stopPlaybackWithin(tracksEl){
      var playing = tracksEl && tracksEl.querySelector('button.sp[aria-expanded="true"]');
      if(playing) playing.click();
    }

    mount.addEventListener('click', function(e){
      var btn = e.target.closest('.artist-row');
      if(!btn) return;
      var group = btn.closest('.artist-group');
      var tracksEl = group.querySelector('.artist-tracks');
      var isOpen = btn.getAttribute('aria-expanded') === 'true';

      var openBtn = mount.querySelector('.artist-row[aria-expanded="true"]');
      if(openBtn && openBtn !== btn){
        var openTracks = openBtn.closest('.artist-group').querySelector('.artist-tracks');
        stopPlaybackWithin(openTracks);
        openBtn.setAttribute('aria-expanded', 'false');
        if(openTracks) openTracks.hidden = true;
      }

      if(isOpen) stopPlaybackWithin(tracksEl);
      btn.setAttribute('aria-expanded', String(!isOpen));
      tracksEl.hidden = isOpen;
    });

    // Upgrade any row that has a spotify_artist_url but no artist_image —
    // in place, once the lookup resolves, never by re-rendering the list.
    order.forEach(function(name){
      var artistEntries = byArtist[name];
      if(artistImageOf(artistEntries)) return;
      var spotifyUrl = spotifyArtistUrlOf(artistEntries);
      if(!spotifyUrl) return;
      fetchSpotifyArtistImage(spotifyUrl).then(function(img){
        if(!img) return;
        var slug = slugify(name);
        var group = mount.querySelector('.artist-group[data-artist="'+slug+'"]');
        var photoSlot = group && group.querySelector('.ar-photo');
        if(!photoSlot) return;
        photoSlot.classList.add('has-photo');
        photoSlot.innerHTML = '<img class="ar-img" src="'+esc(img)+'" loading="lazy" alt="">';
      });
    });

    return { order: order, byArtist: byArtist };
  }

  // homepage: the ordered artist list from /data/homepage.json — each name
  // still needs at least one matching credits.json entry to actually
  // render a tile (for its photo/link data, and so a stale homepage.json
  // row for a since-removed artist just quietly drops out).
  function renderArtistWall(data, homepage){
    var byArtist = {};
    data.forEach(function(e){
      var key = (e.artist_en || '').trim();
      if(!key) return;
      (byArtist[key] = byArtist[key] || []).push(e);
    });
    var artists = homepage.slice().sort(byOrder)
      .map(function(h){ return (h.artist_en || '').trim(); })
      .filter(function(name){ return name && byArtist[name]; });

    // Resolve every tile's final image before the first paint, so a tile
    // never flashes from cover art to a Spotify photo once the lookup
    // lands — one oEmbed request per artist that has a spotify_artist_url
    // and no artist_image override, all in parallel.
    var images = artists.map(function(name){
      var entries = byArtist[name];
      var artistImg = artistImageOf(entries);
      if(artistImg) return Promise.resolve(artistImg);
      var spotifyUrl = spotifyArtistUrlOf(entries);
      if(spotifyUrl){
        return fetchSpotifyArtistImage(spotifyUrl).then(function(spotifyImg){
          return spotifyImg || coverArtOf(entries);
        });
      }
      return Promise.resolve(coverArtOf(entries));
    });

    Promise.all(images).then(function(resolved){
      var html = artists.map(function(name, i){
        return renderArtistTile(name, byArtist[name], resolved[i]);
      }).join('');
      html += '<a class="aw-tile aw-more" href="credits.html">'+esc(MORE_TEXT[lang])+'</a>';
      mount.innerHTML = html;
    });
  }

  // One card, identical structure whether or not the entry is playable —
  // only the play button vs. an equal-size empty spacer differs.
  function renderCard(entry){
    var sp = spotifyPlayable(entry.links);
    var yt = youtubeId(entry.links);
    // Both an album/single link (open.spotify.com/album/…) and a plain
    // track link (open.spotify.com/track/…, what Spotify's own "Share"
    // menu gives you for a single song) are playable — the embed and URI
    // below just need to use whichever kind was actually found.
    var playable = !!(sp && (sp.kind === 'album' || sp.kind === 'track'));
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

    var attrs = ' data-embed="'+esc('https://open.spotify.com/embed/'+sp.kind+'/'+sp.id+'?utm_source=generator&theme=0')+'"'
      + ' data-uri="spotify:'+sp.kind+':'+esc(sp.id)+'" data-h="152"';
    if(yt) attrs += ' data-yt="'+esc(yt)+'"';
    if(entry.start_seconds !== undefined && entry.start_seconds !== null && String(entry.start_seconds).trim() !== ''){
      attrs += ' data-start="'+esc(String(entry.start_seconds))+'"';
    }
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

  // Which of the two entry-list pages an entry belongs to is now an
  // explicit, admin-editable property (entry.pages) rather than being
  // inferred from the artist name — every entry that should appear
  // anywhere carries 'credits' and/or 'releases' in this array.
  function onPage(e, name){
    return Array.isArray(e.pages) && e.pages.indexOf(name) !== -1;
  }

  fetch('/data/credits.json')
    .then(function(r){ return r.json(); })
    .then(function(data){
      if(page === 'credits'){
        var credits = data.filter(function(e){ return onPage(e, 'credits'); }).sort(byOrder);
        var grouped = renderCreditsGrouped(credits);

        // A tile on the homepage photo wall (or any other link) can carry
        // ?artist=<slug> to land here with that artist's row already open,
        // matched against artist_en the same way tile links are built.
        var artistParam = null;
        try{ artistParam = new URLSearchParams(location.search).get('artist'); }catch(e){}
        var filterBar = document.querySelector(cfg.filterMount || '#filterBar');
        if(artistParam){
          var slug = artistParam.toLowerCase();
          var matchName = grouped.order.filter(function(n){ return slugify(n) === slug; })[0];
          if(matchName){
            if(filterBar){
              var label = filterBar.querySelector('.filterbar-label');
              var name = lang === 'fa' ? grouped.byArtist[matchName][0].artist_fa : matchName;
              if(label) label.textContent = (lang === 'fa' ? 'در حال نمایش: ' : 'Showing: ') + name;
              filterBar.classList.add('show');
            }
            var matchGroup = mount.querySelector('.artist-group[data-artist="'+slug+'"]');
            if(matchGroup){
              matchGroup.querySelector('.artist-row').click();
              matchGroup.scrollIntoView({block:'start'});
            }
          }
        }

        var titledCount = credits.filter(function(e){ return e.title_en || e.title_fa; }).length;
        var statEl = document.getElementById('titlesCount');
        if(statEl) statEl.textContent = lang === 'fa' ? faDigits(titledCount) : String(titledCount);
      } else if(page === 'roster'){
        fetch('/data/homepage.json')
          .then(function(r){ return r.json(); })
          .catch(function(){ return []; })
          .then(function(homepage){ renderArtistWall(data, homepage || []); });
      } else if(page === 'releases'){
        var releases = data.filter(function(e){ return onPage(e, 'releases'); }).sort(byOrder);
        renderGrid(releases);

        var artistLink = null, channelLink = null;
        for(var i=0;i<releases.length && (!artistLink || !channelLink);i++){
          artistLink = artistLink || findLink(releases[i].links, RE_SPOTIFY_ARTIST);
          channelLink = channelLink || findLink(releases[i].links, RE_YOUTUBE_CHANNEL);
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
