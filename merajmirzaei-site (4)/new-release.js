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
 * - Comments: visitors leave a name + comment on the song that's playing
 *   (the box under the video). They wait for approval on the admin panel,
 *   then float up over the bottom of that song's video, Instagram-Live
 *   style, one after another.
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

  // ---- comments -------------------------------------------------------
  var T = lang === 'fa'
    ? { name: 'اسم شما', text: 'یه کامنت بنویس…', send: 'ارسال', thanks: 'ممنون! کامنتت بعد از تأیید نمایش داده می‌شه.',
        needName: 'لطفاً اسمت رو بنویس.', needText: 'لطفاً کامنتت رو بنویس.', links: 'لینک توی کامنت مجاز نیست.',
        rate: 'یه دقیقه صبر کن و دوباره بفرست.', fail: 'ارسال نشد، دوباره امتحان کن.' }
    : { name: 'Your name', text: 'Add a comment…', send: 'Send', thanks: 'Thanks! Your comment will appear once it’s approved.',
        needName: 'Please write your name.', needText: 'Please write a comment.', links: 'Links aren’t allowed in comments.',
        rate: 'Please wait a minute and try again.', fail: 'Couldn’t send — please try again.' };

  var floatBox = document.createElement('div');
  floatBox.className = 'reelcomments';
  floatBox.setAttribute('aria-live', 'polite');
  stage.appendChild(floatBox);

  var form = document.createElement('form');
  form.className = 'reelform';
  form.setAttribute('autocomplete', 'off');
  form.noValidate = true;   // our own messages, in the page's language
  form.innerHTML =
    '<input class="rf-name" name="name" maxlength="40" required>'
    + '<input class="rf-text" name="text" maxlength="200" required>'
    + '<input class="rf-hp" name="website" tabindex="-1" aria-hidden="true">'
    + '<button type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg></button>';
  var nameIn = form.querySelector('.rf-name');
  var textIn = form.querySelector('.rf-text');
  var sendBtn = form.querySelector('button');
  nameIn.placeholder = T.name; nameIn.setAttribute('aria-label', T.name);
  textIn.placeholder = T.text; textIn.setAttribute('aria-label', T.text);
  sendBtn.setAttribute('aria-label', T.send); sendBtn.title = T.send;
  if(lang === 'fa'){ nameIn.dir = 'auto'; textIn.dir = 'auto'; }
  var formMsg = document.createElement('p');
  formMsg.className = 'reelformmsg';
  reel.insertBefore(form, nav);
  reel.insertBefore(formMsg, nav);
  var formShownAt = Date.now();
  // The song a comment is about is the one playing when the visitor starts
  // typing — not whatever the reel has moved on to by the time they send.
  var composeItem = null;
  textIn.addEventListener('focus', function(){ if(!composeItem) composeItem = items[i]; });
  try{ nameIn.value = localStorage.getItem('mm_comment_name') || ''; }catch(e){}

  var commentCache = {};   // song -> [{name,text}]
  var floatTimer = null, floatIdx = 0, floatSong = null;

  function songKey(it){ return it.release_id ? String(it.release_id) : 'nr:' + String(it.id || ''); }

  function floatOne(c){
    var el = document.createElement('div');
    el.className = 'rc';
    el.dir = 'auto';
    var b = document.createElement('b');
    b.textContent = c.name;
    el.appendChild(b);
    el.appendChild(document.createTextNode(c.text));
    floatBox.appendChild(el);
    while(floatBox.children.length > 4) floatBox.removeChild(floatBox.firstChild);
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 6200);
  }

  function stopFloating(){
    if(floatTimer){ clearTimeout(floatTimer); floatTimer = null; }
    floatBox.innerHTML = '';
  }

  function floatLoop(song){
    var list = commentCache[song] || [];
    if(song !== floatSong || !list.length) return;
    if(floatIdx >= list.length){
      floatIdx = 0;
      floatTimer = setTimeout(function(){ floatLoop(song); }, 5000);  // pause, then go round again
      return;
    }
    floatOne(list[floatIdx++]);
    floatTimer = setTimeout(function(){ floatLoop(song); }, 2600);
  }

  function startComments(it){
    stopFloating();
    var song = songKey(it);
    floatSong = song;
    floatIdx = 0;
    if(commentCache[song]){ floatTimer = setTimeout(function(){ floatLoop(song); }, 1200); return; }
    fetch('/api/comments?song=' + encodeURIComponent(song))
      .then(function(r){ return r.ok ? r.json() : { comments: [] }; })
      .then(function(j){
        commentCache[song] = (j && j.comments) || [];
        if(floatSong === song) floatTimer = setTimeout(function(){ floatLoop(song); }, 1200);
      })
      .catch(function(){ commentCache[song] = []; });
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var it = composeItem || items[i];
    if(!it) return;
    var name = nameIn.value.trim(), text = textIn.value.trim();
    if(!name){ formMsg.textContent = T.needName; nameIn.focus(); return; }
    if(!text){ formMsg.textContent = T.needText; textIn.focus(); return; }
    sendBtn.disabled = true;
    formMsg.textContent = '';
    fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song: songKey(it), name: name, text: text, lang: lang,
        website: form.querySelector('.rf-hp').value, elapsed: Date.now() - formShownAt })
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        sendBtn.disabled = false;
        if(res.ok && res.j.ok){
          try{ localStorage.setItem('mm_comment_name', name); }catch(err){}
          textIn.value = '';
          formMsg.textContent = T.thanks;
          if(songKey(it) === floatSong) floatOne({ name: name, text: text });   // the sender sees it right away
          composeItem = null;
          return;
        }
        var code = res.j && res.j.code;
        formMsg.textContent = code === 'links' ? T.links : code === 'rate' ? T.rate
          : code === 'name' ? T.needName : code === 'text' ? T.needText : T.fail;
      })
      .catch(function(){ sendBtn.disabled = false; formMsg.textContent = T.fail; });
  });

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
    startComments(it);
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
