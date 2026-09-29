// The /collaborate page's form (both languages). Three "doors" — poet,
// composer, mix & master — each show their own fields of one shared form;
// the page's own markup carries every visible string (data-t-<role> and
// data-ph-<role> attributes for the ones that change per door), and the
// messages below come from the page's #collabMsg JSON block, so this file
// holds no language text of its own. Sends to /api/collab (src/worker.js).
(function(){
  var form = document.getElementById('cform');
  if(!form) return;
  var MSG = {};
  try{ MSG = JSON.parse(document.getElementById('collabMsg').textContent); }catch(e){}
  var LANG = document.documentElement.lang === 'fa' ? 'fa' : 'en';
  var MAX_FILES = 3, MAX_BYTES = 25 * 1000 * 1000;
  var EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|jpe?g|png|webp|gif|heic|heif|pdf|txt|docx?|zip)$/i;
  var openedAt = Date.now();

  var doors = document.querySelectorAll('.door');
  var pick = document.getElementById('pickHint');
  var done = document.getElementById('done');
  var errEl = document.getElementById('ferr');
  var submitBtn = document.getElementById('csubmit');
  var prog = document.getElementById('prog');
  var progBar = prog.querySelector('i');
  var fileIn = document.getElementById('fileIn');
  var drop = document.getElementById('drop');
  var list = document.getElementById('fileList');
  var tgChk = document.getElementById('tgChk');
  var files = [];
  var role = '';
  var service = 'mixmaster';

  function num(n){ return LANG === 'fa' ? Number(n).toLocaleString('fa-IR') : String(n); }
  function size(b){
    return b >= 1000 * 1000 ? num((b / 1000 / 1000).toFixed(1)) + ' MB' : num(Math.max(1, Math.round(b / 1000))) + ' KB';
  }
  function msg(code){
    if(code === 'work') return (MSG.work && MSG.work[role]) || MSG.server;
    return MSG[code] || MSG.server || 'Error';
  }
  function showErr(text, field){
    errEl.textContent = text || '';
    Array.prototype.forEach.call(form.querySelectorAll('.bad'), function(el){ el.classList.remove('bad'); });
    if(field){ field.classList.add('bad'); try{ field.focus({preventScroll:false}); }catch(e){ field.focus(); } }
  }

  // --- doors -------------------------------------------------------------
  function setRole(r, scroll){
    role = r;
    Array.prototype.forEach.call(doors, function(d){ d.setAttribute('aria-pressed', d.getAttribute('data-role') === r ? 'true' : 'false'); });
    Array.prototype.forEach.call(form.querySelectorAll('[data-for]'), function(el){
      el.hidden = el.getAttribute('data-for').split(' ').indexOf(r) === -1;
    });
    Array.prototype.forEach.call(form.querySelectorAll('[data-t-' + r + ']'), function(el){
      el.textContent = el.getAttribute('data-t-' + r);
    });
    Array.prototype.forEach.call(form.querySelectorAll('[data-ph-' + r + ']'), function(el){
      el.setAttribute('placeholder', el.getAttribute('data-ph-' + r));
    });
    form.hidden = false;
    done.hidden = true;
    if(pick) pick.hidden = true;
    showErr('');
    try{ history.replaceState(null, '', '#' + r); }catch(e){}
    if(scroll){
      var y = form.getBoundingClientRect().top + window.pageYOffset - 150;
      if(window.pageYOffset < y - 40) window.scrollTo({ top: y, behavior: 'smooth' });
    }
  }
  Array.prototype.forEach.call(doors, function(d){
    d.addEventListener('click', function(){ setRole(d.getAttribute('data-role'), true); });
  });

  // --- mix: service chips ------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('#svc .chip'), function(c){
    c.addEventListener('click', function(){
      service = c.getAttribute('data-svc');
      Array.prototype.forEach.call(document.querySelectorAll('#svc .chip'), function(o){ o.setAttribute('aria-pressed', o === c ? 'true' : 'false'); });
    });
  });

  // Opening Telegram means they're sending the project there.
  var tgBtn = document.getElementById('tgBtn');
  if(tgBtn) tgBtn.addEventListener('click', function(){ tgChk.checked = true; showErr(''); });

  // --- files ---------------------------------------------------------------
  function renderFiles(){
    list.innerHTML = '';
    files.forEach(function(f, i){
      var li = document.createElement('li');
      var n = document.createElement('span'); n.className = 'fn'; n.dir = 'auto'; n.textContent = f.name;
      var s = document.createElement('span'); s.className = 'fs'; s.textContent = size(f.size);
      var x = document.createElement('button'); x.type = 'button'; x.textContent = '×';
      x.setAttribute('aria-label', MSG.remove || 'Remove');
      x.addEventListener('click', function(){ files.splice(i, 1); renderFiles(); });
      li.appendChild(n); li.appendChild(s); li.appendChild(x);
      list.appendChild(li);
    });
  }
  function addFiles(fl){
    showErr('');
    for(var i = 0; i < fl.length; i++){
      var f = fl[i];
      if(!EXT.test(f.name)){ showErr(msg('file_type')); continue; }
      if(files.length >= MAX_FILES){ showErr(msg('files_count')); break; }
      var total = files.reduce(function(t, x){ return t + x.size; }, 0);
      if(total + f.size > MAX_BYTES){ showErr(msg('size')); continue; }
      files.push(f);
    }
    renderFiles();
  }
  fileIn.addEventListener('change', function(){ addFiles(fileIn.files); fileIn.value = ''; });
  ['dragenter', 'dragover'].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function(ev){
    drop.addEventListener(ev, function(){ drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function(e){
    e.preventDefault();
    if(e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  // --- send ----------------------------------------------------------------
  function val(name){ var el = form.elements[name]; return el ? String(el.value || '').trim() : ''; }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if(!role) return;
    var name = val('name'), email = val('email'), phone = val('phone');
    var lyrics = val('lyrics'), link = val('link');
    var telegram = role === 'mix' && tgChk.checked;
    var hasWork = role === 'poet' ? !!(lyrics || files.length)
      : role === 'composer' ? !!(files.length || link)
      : !!(files.length || link || telegram);
    if(!hasWork) return showErr(msg('work'), role === 'poet' ? form.elements.lyrics : null);
    if(link && !/^(https?:\/\/)?[^\s\/]+\.[^\s]+$/i.test(link)) return showErr(msg('link'), form.elements.link);
    if(!name) return showErr(msg('name'), form.elements.name);
    if(!email && !phone) return showErr(msg('contact'), form.elements.email);
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(msg('email'), form.elements.email);
    if(role === 'mix' && !form.elements.terms.checked) return showErr(msg('terms'), form.elements.terms);
    showErr('');

    var fd = new FormData();
    fd.append('role', role);
    fd.append('lang', LANG);
    fd.append('name', name);
    fd.append('email', email);
    fd.append('phone', phone);
    fd.append('description', val('description'));
    if(role === 'poet') fd.append('lyrics', lyrics);
    if(role !== 'poet') fd.append('link', link);
    if(role === 'mix'){
      fd.append('service', service);
      if(telegram) fd.append('telegram', '1');
      fd.append('terms', '1');
    }
    fd.append('website', val('website'));
    fd.append('elapsed', String(Date.now() - openedAt));
    files.forEach(function(f){ fd.append('files', f, f.name); });

    submitBtn.disabled = true;
    submitBtn.textContent = MSG.sending || '…';
    prog.hidden = !files.length;
    progBar.style.width = '0';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/collab');
    xhr.upload.onprogress = function(ev){
      if(ev.lengthComputable) progBar.style.width = Math.round(ev.loaded / ev.total * 100) + '%';
    };
    xhr.onload = function(){
      var j = {};
      try{ j = JSON.parse(xhr.responseText); }catch(err){}
      finish();
      if(xhr.status >= 200 && xhr.status < 300 && j.ok) return success(telegram);
      showErr(msg(j.code));
    };
    xhr.onerror = function(){ finish(); showErr(msg('server')); };
    xhr.send(fd);
  });

  function finish(){
    submitBtn.disabled = false;
    submitBtn.textContent = submitBtn.getAttribute('data-label');
    prog.hidden = true;
  }

  function success(telegram){
    form.hidden = true;
    done.hidden = false;
    Array.prototype.forEach.call(done.querySelectorAll('[data-t-' + role + ']'), function(el){
      el.textContent = el.getAttribute('data-t-' + role);
    });
    document.getElementById('doneTg').hidden = !telegram;
    form.reset();
    files = []; renderFiles();
    openedAt = Date.now();
    var y = done.getBoundingClientRect().top + window.pageYOffset - 150;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  document.getElementById('again').addEventListener('click', function(){
    Array.prototype.forEach.call(doors, function(d){ d.setAttribute('aria-pressed', 'false'); });
    done.hidden = true;
    form.hidden = true;
    role = '';
    if(pick) pick.hidden = false;
    try{ history.replaceState(null, '', location.pathname); }catch(e){}
    var y = document.getElementById('doors').getBoundingClientRect().top + window.pageYOffset - 150;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  });

  // A link like /collaborate#mix (the Services page's button) opens that door.
  var h = (location.hash || '').slice(1);
  if(h === 'poet' || h === 'composer' || h === 'mix') setRole(h, false);
})();
