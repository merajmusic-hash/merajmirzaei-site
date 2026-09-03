// Renders credits.html / releases.html (both languages) from
// /data/credits.json. Each page sets window.__CREDITS_CONFIG__ = {
//   lang: 'en' | 'fa', page: 'credits' | 'releases', mount: '#id'
// } before loading this script. Markup shape and CSS classes are kept
// identical to the previous hand-written HTML so the existing stylesheet
// applies unchanged; only the data source moved from static HTML to JSON.
//
// Public pages only ever read these fields: artist_en/fa, title_en/fa,
// release_type, links, cover_url. status_* and notes are admin-only and
// are never touched here.
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
  // channel link, and NOT the playable Spotify/YouTube source render as
  // ordinary "extra" buttons/links (e.g. a Telegram download), exactly like
  // the Telegram link already did before this rewrite. All external, so
  // always target=_blank.
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
  function roleLabel(entry){
    var labels = ROLE_LABELS[lang];
    var parts = ROLE_ORDER.filter(function(f){ return !!entry[f]; }).map(function(f){ return labels[f]; });
    if(!parts.length) return '';
    var sep = lang === 'fa' ? ' و ' : ' & ';
    return parts.join(sep);
  }

  function groupByArtist(entries){
    var order = [], byArtist = {};
    entries.forEach(function(e){
      var key = e.artist_en || '';
      if(!byArtist[key]){ byArtist[key] = []; order.push(key); }
      byArtist[key].push(e);
    });
    return order.map(function(key){ return { artist_en: key, entries: byArtist[key] }; });
  }

  // ---------------- credits.html ----------------
  function renderCredits(entries){
    var groups = groupByArtist(entries.filter(function(e){ return (e.artist_en||'').trim().toUpperCase() !== 'MIRAGE'; }));
    var html = '';
    groups.forEach(function(group, gi){
      var first = group.entries[0];
      var artistPrimary = lang === 'fa' ? first.artist_fa : first.artist_en;
      var artistAlt = lang === 'fa' ? first.artist_en : first.artist_fa;
      var artistLink = findLink(first.links, RE_SPOTIFY_ARTIST);
      var chNum = lang === 'fa' ? faDigits(String(gi+1).padStart(2,'0')) : String(gi+1).padStart(2,'0');
      var chLabel = lang === 'fa' ? 'کانال ' + chNum : 'CH ' + chNum;

      var titled = group.entries.filter(function(e){ return e.title_en || e.title_fa; });
      var role = roleLabel(first);

      html += '<div class="channel" id="a'+(gi+1)+'">'
        + '<div class="chline"><span class="ch">'+esc(chLabel)+'</span>'
        + (role ? '<span class="role-tag">'+esc(role)+'</span>' : '')
        + '</div>'
        + (artistLink
            ? '<a class="aname" href="'+esc(artistLink.url)+'" target="_blank" rel="noopener noreferrer">'+esc(artistPrimary)+'</a>'
            : '<span class="aname">'+esc(artistPrimary)+'</span>')
        + '<span class="aalt">'+esc(artistAlt)+'</span>'
        + '<div class="tracks">';

      if(!titled.length){
        html += lang === 'fa'
          ? '<span class="pending">فهرست آثار در حال تأیید است</span>'
          : '<span class="pending">catalogue being verified</span>';
      } else {
        titled.forEach(function(e){
          var isAlbum = e.release_type === 'album track';
          var sp = spotifyPlayable(e.links);
          var primary = lang === 'fa' ? e.title_fa : e.title_en;
          var alt = lang === 'fa' ? e.title_en : e.title_fa;
          var primaryClass = lang === 'fa' ? 't-fa' : 't-main';
          var altClass = lang === 'fa' ? 't-lat' : 't-sub';

          if(sp && sp.kind === 'album'){
            var embed = 'https://open.spotify.com/embed/album/'+sp.id+'?utm_source=generator&theme=0';
            html += '<div class="trackwrap"><button class="track'+(isAlbum?' album':'')+' sp" type="button" '
              + 'data-embed="'+esc(embed)+'" data-uri="spotify:album:'+esc(sp.id)+'" data-h="152" aria-expanded="false">'
              + (e.cover_url ? '<img class="thumb" src="'+esc(e.cover_url)+'" loading="lazy" alt="">' : '')
              + '<span class="'+primaryClass+'">'+esc(primary)+'</span>'
              + '<span class="'+altClass+'">'+esc(alt)+'</span>'
              + '<span class="play">▶</span></button><div class="player"></div></div>';
          } else {
            html += '<span class="track'+(isAlbum?' album':'')+'">'
              + '<span class="'+primaryClass+'">'+esc(primary)+'</span>'
              + '<span class="'+altClass+'">'+esc(alt)+'</span></span>';
          }
        });
      }
      html += '</div></div>';
    });
    mount.innerHTML = html;

    var titledCount = groups.reduce(function(n, g){
      return n + g.entries.filter(function(e){ return e.title_en || e.title_fa; }).length;
    }, 0);
    var statEl = document.getElementById('titlesCount');
    if(statEl) statEl.textContent = lang === 'fa' ? faDigits(titledCount) : String(titledCount);
  }

  // ---------------- releases.html ----------------
  function renderReleases(entries){
    var mirage = entries.filter(function(e){ return (e.artist_en||'').trim().toUpperCase() === 'MIRAGE'; });
    var rowsHtml = '';
    mirage.forEach(function(e){
      var sp = spotifyPlayable(e.links);
      var yt = youtubeId(e.links);
      var extras = extraLinks(e.links);
      var tg = extras[0]; // first non-Spotify/YouTube link (e.g. Telegram)
      var primary = lang === 'fa' ? e.title_fa : e.title_en;
      var alt = lang === 'fa' ? e.title_en : e.title_fa;

      var attrs = '';
      if(sp && sp.kind === 'album'){
        attrs += ' data-embed="'+esc('https://open.spotify.com/embed/album/'+sp.id+'?utm_source=generator&theme=0')+'"'
          + ' data-uri="spotify:album:'+esc(sp.id)+'"';
      }
      attrs += ' data-h="152"';
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

      rowsHtml += '<div class="trackwrap"><button class="rel sp" type="button"'+attrs+' aria-expanded="false">'
        + (e.cover_url ? '<img class="thumb big" src="'+esc(e.cover_url)+'" loading="lazy" alt="">' : '')
        + '<div class="rmeta"><span class="rt">'+esc(primary)+'</span><span class="ra">'+esc(alt)+'</span></div>'
        + '<span class="rm">'+esc(e.year||'')+'</span></button><div class="player"></div></div>';
    });

    var artistLink = null, channelLink = null;
    for(var i=0;i<mirage.length && (!artistLink || !channelLink);i++){
      artistLink = artistLink || findLink(mirage[i].links, RE_SPOTIFY_ARTIST);
      channelLink = channelLink || findLink(mirage[i].links, RE_YOUTUBE_CHANNEL);
    }
    var linkrowHtml = '';
    if(artistLink) linkrowHtml += '<a class="btn" href="'+esc(artistLink.url)+'" target="_blank" rel="noopener noreferrer">Spotify</a>\n  ';
    if(channelLink) linkrowHtml += '<a class="btn" href="'+esc(channelLink.url)+'" target="_blank" rel="noopener noreferrer">YouTube</a>';

    mount.innerHTML = rowsHtml;
    var linkrowMount = document.querySelector(cfg.linkrowMount);
    if(linkrowMount) linkrowMount.innerHTML = linkrowHtml;
  }

  fetch('/data/credits.json')
    .then(function(r){ return r.json(); })
    .then(function(data){
      if(page === 'credits') renderCredits(data);
      else if(page === 'releases') renderReleases(data);
      document.dispatchEvent(new CustomEvent('credits-rendered'));
    })
    .catch(function(err){
      mount.innerHTML = '<p style="color:var(--muted)">Could not load data right now.</p>';
      if (window.console) console.error('credits-render:', err);
    });
})();
