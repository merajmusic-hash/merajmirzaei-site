/* Homepage "New Release" player.
 *
 * Plays the videos listed in /data/new-releases.json (edited on the admin
 * panel's "New Release" tab) top to bottom, then loops. Each video is
 * either an uploaded file (video_url, played in a plain <video>) or a
 * YouTube link (youtube_url, played through the YouTube IFrame API, which
 * is only loaded if the list actually contains a YouTube video).
 *
 * - Clicking the video frame opens that song's own page on the Releases
 *   section (/releases/<slug>, /fa/releases/<slug>), picked per video on
 *   the admin panel (release_id = the credits.json id).
 * - The song names under the video switch to that video.
 * - Videos start muted (browsers only allow muted autoplay); the speaker
 *   button in the corner turns sound on/off, and the choice carries over
 *   to the next videos.
 *
 * Markup it expects (see index.html / fa/index.html):
 *   #reel        wrapper (hidden if there is nothing to play)
 *   #reel-stage  the 9:16 frame
 *   #reel-nav    the row of song names
 * and window.__NEW_RELEASE_CONFIG__ = { lang: 'en' | 'fa' }.
 */
(function(){
  var cfg = window.__NEW_RELEASE_CONFIG__ || {};
  var lang = cfg.lang === 'fa' ? 'fa' : 'en';
  var reel = document.getElementById('reel');
  var stage = document.getElementById('reel-stage');
  var nav = document.getElementById('reel-nav');
  if(!reel || !stage || !nav) return;

  var items = [];
  var i = 0;
  var failures = 0;
  var soundOn = false;

  // Native player for uploaded files.
  var video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('preload', 'metadata');
  video.muted = true;
  video.style.display = 'none';
  stage.appendChild(video);
  video.addEventListener('ended', function(){ failures = 0; next(); });
  video.addEventListener('playing', function(){ failures = 0; });
  video.addEventListener('error', function(){
    if(!video.getAttribute('src')) return;
    // A broken file shouldn't stall the player: skip it, but stop once
    // every video in the list has failed in a row.
    failures++;
    if(failures < items.length) setTimeout(next, 800);
  });

  // YouTube player (created on first use).
  var ytBox = document.createElement('div');
  ytBox.style.display = 'none';
  var ytTarget = document.createElement('div');
  ytBox.appendChild(ytTarget);
  stage.appendChild(ytBox);
  var yt = null, ytReady = false, ytRequested = false, pendingYt = null;
  var showingYt = false;

  // Clickable layer over the whole frame -> the playing song's page.
  var link = document.createElement('a');
  link.className = 'reellink';
  link.style.display = 'none';
  stage.appendChild(link);

  // Sound on/off button, above the link layer.
  var ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
  var ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  var LABELS = lang === 'fa'
    ? { on: 'قطع صدا', off: 'پخش صدا' }
    : { on: 'Mute', off: 'Turn sound on' };
  var soundBtn = document.createElement('button');
  soundBtn.type = 'button';
  soundBtn.className = 'reelsound';
  stage.appendChild(soundBtn);

  function paintSoundBtn(){
    soundBtn.innerHTML = soundOn ? ICON_ON : ICON_OFF;
    soundBtn.setAttribute('aria-label', soundOn ? LABELS.on : LABELS.off);
    soundBtn.title = soundOn ? LABELS.on : LABELS.off;
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }

  function applySound(){
    video.muted = !soundOn;
    if(yt && ytReady){
      try{
        if(soundOn){ yt.unMute(); yt.setVolume(100); } else { yt.mute(); }
      }catch(e){}
    }
    paintSoundBtn();
  }

  soundBtn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    soundOn = !soundOn;
    applySound();
    // Turning sound on is a user gesture, so playback may resume with sound.
    if(!showingYt && video.getAttribute('src') && video.paused){
      var p = video.play(); if(p && p.catch) p.catch(function(){});
    }
  });
  paintSoundBtn();

  function youtubeId(url){
    var m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function titleOf(it){
    return (lang === 'fa' ? (it.title_fa || it.title_en) : (it.title_en || it.title_fa)) || '';
  }

  // Same slug rule the Worker uses for recording pages (slugifyName).
  function songHref(it){
    var slug = String(it.release_id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if(!slug) return '';
    return (lang === 'fa' ? '/fa/releases/' : '/releases/') + slug;
  }

  function loadYouTubeApi(){
    if(ytRequested) return;
    ytRequested = true;
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function(){
      if(typeof prev === 'function') try{ prev(); }catch(e){}
      yt = new YT.Player(ytTarget, {
        videoId: pendingYt,
        playerVars: { rel: 0, playsinline: 1, modestbranding: 1, mute: 1, autoplay: 1, controls: 0 },
        events: {
          onReady: function(e){
            ytReady = true;
            applySound();
            if(pendingYt && showingYt) e.target.playVideo();
          },
          onStateChange: function(e){
            if(e.data === YT.PlayerState.PLAYING) failures = 0;
            if(e.data === YT.PlayerState.ENDED) next();
          },
          onError: function(){
            failures++;
            if(failures < items.length) setTimeout(next, 800);
          }
        }
      });
    };
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.head.appendChild(s);
  }

  function playFile(src){
    showingYt = false;
    if(yt && ytReady) try{ yt.stopVideo(); }catch(e){}
    ytBox.style.display = 'none';
    video.style.display = '';
    video.muted = !soundOn;
    video.setAttribute('src', src);
    var p = video.play();
    if(p && p.catch) p.catch(function(){
      // The browser refused to autoplay with sound: fall back to muted.
      if(!video.muted){
        soundOn = false;
        applySound();
        video.play().catch(function(){});
      }
    });
  }

  function playYouTube(id){
    showingYt = true;
    if(video.getAttribute('src')){
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    video.style.display = 'none';
    ytBox.style.display = '';
    pendingYt = id;
    if(yt && ytReady){ yt.loadVideoById(id); applySound(); return; }
    loadYouTubeApi();
  }

  function markOn(){
    var bs = nav.querySelectorAll('button');
    for(var k = 0; k < bs.length; k++) bs[k].className = (k === i ? 'on' : '');
  }

  function go(n){
    if(!items.length) return;
    i = ((n % items.length) + items.length) % items.length;
    var it = items[i];
    if(it.video_url) playFile(it.video_url);
    else playYouTube(youtubeId(it.youtube_url));
    var href = songHref(it);
    if(href){
      link.href = href;
      link.setAttribute('aria-label', titleOf(it));
      link.style.display = '';
    } else {
      link.removeAttribute('href');
      link.style.display = 'none';
    }
    markOn();
  }

  function next(){ go(i + 1); }

  function renderNav(){
    nav.innerHTML = '';
    items.forEach(function(it, k){
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-i', String(k));
      b.textContent = titleOf(it) || String(k + 1);
      nav.appendChild(b);
    });
  }

  nav.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if(!b) return;
    failures = 0;
    go(parseInt(b.getAttribute('data-i'), 10));
  });

  fetch('/data/new-releases.json', { cache: 'no-cache' })
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(list){
      items = (Array.isArray(list) ? list : [])
        .filter(function(it){ return it && (it.video_url || youtubeId(it.youtube_url)); })
        .sort(function(a, b){ return (a.order || 0) - (b.order || 0); });
      if(!items.length){ reel.style.display = 'none'; return; }
      renderNav();
      go(0);
    })
    .catch(function(){ reel.style.display = 'none'; });
})();
