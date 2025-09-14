/* Poly Track Chatboard – index.js (v40)
   Fixes:
   - Restored admin text glow: single sweep + 1.5s fade (no white flash; aligned to text spans)
   - Stable live updates: debounced WS refresh (coalesces bursts, avoids overlapping loads)
*/

console.log("chatboard.index.js v40");

/* ===== Embed context (client does not hard-block; server enforces) ===== */
const EMBED_HOST_HINT = new URLSearchParams(location.search).get('embedHost') || "";

/* ===== Constants ===== */
const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 7;
const MAX_CHARS     = 2000;
const ADMIN_NICK    = "Poly Track Administrator";

/* ===== Global shimmer driver (for admin username only) ===== */
(function startGlobalShimmer(){
  const durMs = 3200;
  let start = performance.now();
  const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * 2 * t);
  function tick(){
    const now = performance.now();
    const raw = ((now - start) % durMs) / durMs;
    const eased = easeInOut(raw);
    const pos = Math.round(eased * 200); // 0..200%
    document.documentElement.style.setProperty('--shimmer-x', pos + '%');
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

/* ===== Live updates via WebSocket (debounced) ===== */
const __parentRef = EMBED_HOST_HINT || document.referrer || "";
const __ancestor = (document.location && document.location.ancestorOrigins && document.location.ancestorOrigins.length)
  ? document.location.ancestorOrigins[0] : "";

const WS_ENDPOINT =
  WORKER_URL.replace(/^http/i, 'ws').replace(/\/$/, '') +
  '/ws?room=' + encodeURIComponent(PAGE_URL_PATH) +
  '&parent=' + encodeURIComponent(__parentRef) +
  '&ancestor=' + encodeURIComponent(__ancestor) +
  (EMBED_HOST_HINT ? ('&parentHint=' + encodeURIComponent(EMBED_HOST_HINT)) : '');

let ws = null, wsPing = null, wsBackoff = 500;

/* Debounced refresh utility to prevent overlapping loads */
let __refreshTimer = null, __refreshInFlight = false, __refreshQueued = false;
async function runRefresh() {
  if (__refreshInFlight) { __refreshQueued = true; return; }
  __refreshInFlight = true;
  try { await refreshAdminStatus(); } catch {}
  try { await loadLatest(true); } catch {}
  finally {
    __refreshInFlight = false;
    if (__refreshQueued) { __refreshQueued = false; runRefresh(); }
  }
}
function queueRefresh(delay = 120){
  if (__refreshTimer) clearTimeout(__refreshTimer);
  __refreshTimer = setTimeout(runRefresh, delay);
}

function connectWS(){
  try{
    ws = new WebSocket(WS_ENDPOINT);
    ws.onopen = () => {
      wsBackoff = 500;
      if (connEl){ connEl.textContent = "Live: Connected"; connEl.classList.add("ok"); connEl.classList.remove("bad"); }
      wsPing = setInterval(() => { try { ws.send("ping"); } catch {} }, 30000);
      queueRefresh(50);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      if (e.data === 'pong') return;
      try {
        const msg = JSON.parse(e.data);
        if (msg && msg.type === 'new-reply' && msg.rootId) {
          const rid = String(msg.rootId);
          expanded.add(rid);
          const rootMsg = messagesEl && messagesEl.querySelector(`.msg[data-id="${rid}"]`);
          if (rootMsg) {
            const wrap = rootMsg.querySelector(':scope > .bubble > .replies');
            if (wrap) setRepliesVisibility(wrap, true);
          }
          queueRefresh(100);
        } else {
          queueRefresh(150); // new-root / refresh / unknown -> coalesced refresh
        }
      } catch {
        queueRefresh(150);
      }
    };
    ws.onclose = ws.onerror = () => {
      if (connEl){ connEl.textContent = "Live: Reconnecting…"; connEl.classList.remove("ok"); connEl.classList.add("bad"); }
      clearInterval(wsPing);
      setTimeout(connectWS, Math.min(wsBackoff, 8000));
      wsBackoff = Math.min(wsBackoff * 2, 8000);
    };
  }catch{
    if (connEl){ connEl.textContent = "Live: Reconnecting…"; connEl.classList.remove("ok"); connEl.classList.add("bad"); }
    setTimeout(connectWS, Math.min(wsBackoff, 8000));
    wsBackoff = Math.min(wsBackoff * 2, 8000);
  }
}

/* ===== DOM refs ===== */
const $=id=>document.getElementById(id);
const messagesEl=$("messages"), loadMoreBtn=$("loadMore");
const nickEl=$("nick"), textEl=$("text");
const fileEl=$("file"), btnAttach=$("btnAttach"), btnSend=$("btnSend");
const fileInfo=$("fileInfo"), statusEl=$("status"), connEl=$("conn");

const adminPanel=$("adminPanel"), adminPass=$("adminPass"), btnAdminLogin=$("btnAdminLogin"),
      btnAdminLogout=$("btnAdminLogout"), adminLoginRow=$("adminLoginRow"),
      adminControls=$("adminControls"), pinCountEl=$("pinCount"), adminNote=$("adminNote");
const statTotalEl=$("statTotal"), statRepliesEl=$("statReplies"), statTodayEl=$("statToday");
const toggleRepliesEl=$("toggleReplies");
const togglePostsEl=$("togglePosts");
const optNoReplyEl=$("optNoReply"), sendNoReplyEl=$("sendNoReply"),
      optAutoPinEl=$("optAutoPin"), sendAutoPinEl=$("sendAutoPin");

const embedBox=$("embedBox"), embedModeEl=$("embedMode"),
      embedUrlEl=$("embedUrl"), embedHtmlEl=$("embedHtml"), btnEmbedInsert=$("btnEmbedInsert");

const limitMbEl=$("limitMb"), limitChars=$("limitChars"), limitChars2=$("limitChars2"), charCount=$("charCount");
const replyTo=$("replyTo"), replyName=$("replyName"), replyCancel=$("replyCancel");

/* Show admin panel on ?admin=1 at /chatboard/ (and always if logged in) */
const SHOW_ADMIN_PANEL =
  window.location.hostname === "htmlunblockedgames.github.io" &&
  window.location.pathname === "/chatboard/" &&
  new URLSearchParams(window.location.search).get("admin") === "1";
if (adminPanel) adminPanel.style.display = SHOW_ADMIN_PANEL ? "grid" : "none";

/* Ensure WS starts once */
if (!window.__wsStarted) { window.__wsStarted = true; try { connectWS(); } catch {} }

/* ===== State ===== */
let TK_TOKEN = localStorage.getItem('twikoo_access_token') || null;
const state = { all:new Map(), roots:[], childrenByRoot:new Map(), parentOf:new Map() };
let serverCounts = null;
let loading=false;
let replyTarget=null;
const expanded = new Set();
const prevChildCounts = new Map();
let seededChildCounts = false;
let isAdmin = false;
let rateBlockedUntil = 0;
let allowReplies = true;
let allowPosts = true;
const sessionAnimatedPinned = new Set();
const animatedOnce = new Set();
const mustAnimate = new Set();

/* ===== UI helpers ===== */
if (limitMbEl) limitMbEl.textContent=MAX_FILE_MB;
if (limitChars) limitChars.textContent=MAX_CHARS;
if (limitChars2) limitChars2.textContent=MAX_CHARS;

const setStatus=(t,isError=false)=>{
  if(!statusEl) return;
  if(!t){ statusEl.style.display="none"; statusEl.textContent=""; return; }
  statusEl.style.display="inline"; statusEl.textContent=t;
  statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
};
const initialOf = s => (s||"A").trim().charAt(0).toUpperCase();
function truthy(v){ return v === true || v === 1 || v === '1' || v === 'true'; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseRetryAfter(h){ if (!h) return 0; const n = Number(h); if (!Number.isNaN(n)) return Date.now() + n*1000; const d = Date.parse(h); return Number.isNaN(d) ? 0 : d; }
function authorIsAdmin(c){ return String((c && c.nick) || '') === ADMIN_NICK; }

/* Inline confirm helper (two-tap) */
function armConfirmButton(btn, label = 'Are you sure?', ms = 3000){
  if (!btn) return false;
  if (btn.dataset.confirm === '1') {
    const tid = Number(btn.dataset.confirmTimer || 0);
    if (tid) clearTimeout(tid);
    btn.dataset.confirm = '0';
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    btn.style.color = ''; btn.style.borderColor = '';
    return true;
  }
  btn.dataset.confirm = '1';
  if (!btn.dataset.origText) btn.dataset.origText = btn.textContent || '';
  btn.textContent = label;
  btn.style.color = 'var(--danger)'; btn.style.borderColor = 'var(--danger)';
  const tid = setTimeout(() => {
    btn.dataset.confirm = '0';
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    btn.style.color = ''; btn.style.borderColor = '';
  }, ms);
  btn.dataset.confirmTimer = String(tid);
  return false;
}

/* ===== API ===== */
async function api(eventObj){
  const body = { ...eventObj };
  if (body.url == null) body.url = PAGE_URL_PATH;
  if (TK_TOKEN) { body.accessToken = TK_TOKEN; body.token = TK_TOKEN; }
  const headers = { "content-type": "application/json" };
  if (TK_TOKEN) {
    headers["x-access-token"] = TK_TOKEN;
    headers["authorization"] = "Bearer " + TK_TOKEN;
    headers["Authorization"] = "Bearer " + TK_TOKEN;
    headers["access-token"] = TK_TOKEN;
  }
  try {
    headers["x-embed-parent"] = EMBED_HOST_HINT || document.referrer || "";
    if (document.location && document.location.ancestorOrigins && document.location.ancestorOrigins.length) {
      headers["x-embed-ancestor"] = document.location.ancestorOrigins[0];
    }
  } catch {}

  const now = Date.now();
  if (now < rateBlockedUntil) {
    const secs = Math.ceil((rateBlockedUntil - now)/1000);
    throw new Error(`Too Many Requests: wait ${secs}s`);
  }
  const idempotent = ["COMMENT_GET","GET_CONFIG","GET_FUNC_VERSION","GET"].includes(body.event);
  const maxAttempts = idempotent ? 3 : 1; let attempt=0, lastErr;
  while(attempt<maxAttempts){
    attempt++;
    try{
      const res = await fetch(WORKER_URL, { method:"POST", headers, body: JSON.stringify(body) });
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        const until = parseRetryAfter(ra) || (Date.now() + 20000);
        rateBlockedUntil = Math.max(rateBlockedUntil, until);
        if (attempt < maxAttempts) { await sleep(500*Math.pow(2,attempt-1)+Math.random()*200); continue; }
        throw new Error('Too Many Requests');
      }
      const j = await res.json().catch(()=>({}));
      if (eventObj.event === 'LOGIN' && j?.accessToken) { TK_TOKEN = j.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN); }
      if (eventObj.event === 'GET_CONFIG' && j?.accessToken) { TK_TOKEN = j.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN); }
      return j;
    }catch(e){ lastErr=e; if (attempt<maxAttempts){ await sleep(500*Math.pow(2,attempt-1)+Math.random()*200); continue; } throw e; }
  }
  throw lastErr || new Error("Request failed");
}

/* ===== Admin UI & toggles ===== */
function updateSendButtonUI(){
  if (!btnSend) return;
  if (!isAdmin && !allowPosts) { btnSend.disabled = true; btnSend.textContent = "Chat Locked"; btnSend.title = "Only admin can post right now"; }
  else { btnSend.disabled = false; btnSend.textContent = "Send"; btnSend.title = ""; }
}
function updateAdminUI(){
  const counts = serverCounts || {};
  const pinned = typeof counts.pinned === 'number' ? counts.pinned : (state.roots.filter(x => x.top === 1).length);
  const total  = typeof counts.total  === 'number' ? counts.total  : state.all.size;
  const replies= typeof counts.replies=== 'number' ? counts.replies: Math.max(0, state.all.size - state.roots.length);
  const today  = typeof counts.today  === 'number' ? counts.today  : 0;
  if (pinCountEl)  pinCountEl.textContent = String(pinned);
  if (statTotalEl) statTotalEl.textContent = String(total);
  if (statRepliesEl) statRepliesEl.textContent = String(replies);
  if (statTodayEl)  statTodayEl.textContent = String(today);

  if (isAdmin) { adminLoginRow.style.display='none'; adminControls.style.display='flex'; adminNote.textContent='You are logged in as admin'; }
  else { adminLoginRow.style.display='flex'; adminControls.style.display='none'; adminNote.textContent='Login to manage comments'; }

  document.body.classList.toggle('is-admin', !!isAdmin);
  if (adminPanel) adminPanel.style.display = (SHOW_ADMIN_PANEL || isAdmin) ? 'grid' : 'none';
  if (nickEl && nickEl.parentElement) nickEl.parentElement.style.display = isAdmin ? 'none' : 'flex';

  if (toggleRepliesEl){ toggleRepliesEl.checked = !!allowReplies; toggleRepliesEl.disabled = !isAdmin; toggleRepliesEl.parentElement.style.display = isAdmin ? 'inline-flex' : 'none'; }
  if (togglePostsEl){ togglePostsEl.checked = !allowPosts; togglePostsEl.disabled = !isAdmin; togglePostsEl.parentElement.style.display = isAdmin ? 'inline-flex' : 'none'; }

  if (optNoReplyEl){ const show = !!isAdmin && !replyTarget; optNoReplyEl.style.display = show ? 'inline-flex' : 'none'; if (sendNoReplyEl) sendNoReplyEl.disabled = !show || !allowReplies; }
  if (optAutoPinEl){ const show = !!isAdmin && !replyTarget; optAutoPinEl.style.display = show ? 'inline-flex' : 'none'; if (sendAutoPinEl) sendAutoPinEl.disabled = !show; }
  if (embedBox) embedBox.style.display = isAdmin ? 'flex' : 'none';

  if (!allowReplies && !isAdmin) { replyTarget = null; if (replyTo) replyTo.style.display = 'none'; }

  updateSendButtonUI();
  try { renderAllIncremental(); } catch {}
}
async function refreshAdminStatus(){
  const r = await api({event:'GET_CONFIG'});
  if (r && r.accessToken) { TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN); }
  const adminFlag = r && (r.config && (truthy(r.config.IS_ADMIN) || truthy(r.config.is_admin)));
  if (adminFlag) localStorage.setItem('twikoo_is_admin','1'); else localStorage.removeItem('twikoo_is_admin');
  const cached = (localStorage.getItem('twikoo_is_admin') === '1') && !!TK_TOKEN; isAdmin = !!(adminFlag || cached);
  allowReplies = !!(r && r.config && String(r.config.ALLOW_REPLIES).toLowerCase() !== 'false');
  allowPosts   = !!(r && r.config && String(r.config.ALLOW_POSTS).toLowerCase() !== 'false');
  updateAdminUI();
  bindAdminTogglesOnce();
}

/* ===== Counters & file attach ===== */
function updateCharCount(){ if (charCount && textEl) charCount.textContent = String(textEl.value.length); }
textEl && !textEl.dataset.boundCount && (textEl.dataset.boundCount='1', textEl.addEventListener('input', updateCharCount));
fileEl && !fileEl.dataset.boundChange && (fileEl.dataset.boundChange='1', fileEl.addEventListener('change', ()=>{
  const f = fileEl.files && fileEl.files[0]; if (!f){ fileInfo && (fileInfo.textContent=''); return; }
  const mb = (f.size/(1024*1024)).toFixed(2); fileInfo && (fileInfo.textContent = `${f.name} · ${mb} MB`);
}));
btnAttach && !btnAttach.dataset.boundClick && (btnAttach.dataset.boundClick='1', btnAttach.addEventListener('click', async()=>{
  const f = fileEl && fileEl.files && fileEl.files[0]; if (!f){ setStatus('Choose an image first'); return; }
  const sizeMB = f.size/(1024*1024); if (sizeMB > MAX_FILE_MB){ setStatus(`Image too large (limit ${MAX_FILE_MB}MB)`, true); return; }
  const existingImgs = (textEl.value.match(/&lt;img\b[^&gt;]*&gt;|<img\b[^>]*>/gi) || []).length;
  if (!isAdmin && existingImgs >= 1) { setStatus('Only one image per message allowed', true); return; }
  setStatus('Uploading image…');
  try{
    const reader = new FileReader();
    const dataURL = await new Promise((resolve,reject)=>{ reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(new Error('Read failed')); reader.readAsDataURL(f); });
    const resp = await api({ event:'UPLOAD_IMAGE', photo:String(dataURL), filename: (f && f.name) ? String(f.name) : '' });
    if (resp && resp.code===0 && resp.data && resp.data.url){
      const url = resp.data.url; const prefix = textEl.value.trim().length ? '\n' : '';
      textEl.value = (textEl.value + `${prefix}<img src="${url}">`).trim(); updateCharCount(); setStatus('Image attached');
      fileEl.value=''; if (fileInfo) fileInfo.textContent='';
    } else { setStatus(resp && resp.message ? resp.message : 'Upload failed', true); }
  }catch(e){ setStatus(e && e.message ? e.message : 'Upload failed', true); }
}));

/* ===== Inline embed UI (admin only) ===== */
if (embedModeEl && !embedModeEl.dataset.bound){
  embedModeEl.dataset.bound='1';
  embedModeEl.addEventListener('change', ()=>{
    if (embedModeEl.value === 'html'){ embedHtmlEl.style.display='block'; embedUrlEl.style.display='none'; }
    else { embedHtmlEl.style.display='none'; embedUrlEl.style.display='block'; }
  });
}
if (btnEmbedInsert && !btnEmbedInsert.dataset.bound){
  btnEmbedInsert.dataset.bound='1';
  btnEmbedInsert.addEventListener('click', ()=>{
    if (!isAdmin) return;
    const mode = embedModeEl.value;
    if (mode === 'url'){
      const u = (embedUrlEl.value||'').trim();
      if (!/^https?:\/\/.*/i.test(u)) { setStatus('Enter a valid URL (https://…) for embed', true); return; }
      const iframe = `<iframe src="${u}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" width="560" height="315" title="Embedded"></iframe>`;
      textEl.value = (textEl.value.trim() ? (textEl.value+'\n') : '') + iframe;
    }else{
      const html = embedHtmlEl.value || '';
      const srcdoc = html.replace(/<\/script>/gi,'</scr'+'ipt>');
      const iframe = `<iframe srcdoc="${srcdoc.replace(/"/g,'&quot;')}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" width="560" height="315" title="Embedded"></iframe>`;
      textEl.value = (textEl.value.trim() ? (textEl.value+'\n') : '') + iframe;
    }
    updateCharCount();
    setStatus('Embed inserted (sandboxed)');
  });
}

/* ===== Admin toggles (bind once) ===== */
function bindAdminTogglesOnce(){
  if (toggleRepliesEl && !toggleRepliesEl.dataset.bound) {
    toggleRepliesEl.dataset.bound='1';
    toggleRepliesEl.addEventListener('change', async(e)=>{
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const want = !!e.target.checked; allowReplies = want; updateAdminUI(); e.target.disabled = true;
      try{ const r = await api({ event:'SET_CONFIG_FOR_ADMIN', set:{ allowReplies: want } }); allowReplies = String(r?.config?.ALLOW_REPLIES ?? 'true').toLowerCase() !== 'false'; }
      catch(err){ setStatus(err?.message || 'Failed to update replies setting', true); allowReplies = !want; e.target.checked = !!allowReplies; }
      finally{ e.target.disabled=false; updateAdminUI(); }
    });
  }
  if (togglePostsEl && !togglePostsEl.dataset.bound) {
    togglePostsEl.dataset.bound='1';
    togglePostsEl.addEventListener('change', async(e)=>{
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const onlyAdmin = !!e.target.checked; allowPosts = !onlyAdmin; updateAdminUI(); e.target.disabled = true;
      try{ const r = await api({ event:'SET_CONFIG_FOR_ADMIN', set:{ allowPosts: !onlyAdmin } }); allowPosts = String(r?.config?.ALLOW_POSTS ?? 'true').toLowerCase() !== 'false'; }
      catch(err){ setStatus(err?.message || 'Failed to update posting setting', true); allowPosts = !allowPosts; e.target.checked = !allowPosts; }
      finally{ e.target.disabled=false; updateAdminUI(); }
    });
  }
}

/* ===== Content rendering ===== */
function setRepliesVisibility(rootWrap, show){
  if (!rootWrap) return;
  rootWrap.style.display = show ? 'flex' : 'none';
  const nested = rootWrap.querySelectorAll('.replies');
  nested.forEach(el => { el.style.display = show ? 'flex' : 'none'; });
}
function renderSafeContent(input, opts = {}){
  const allowLinks = !!opts.allowLinks; const allowEmbeds = !!opts.allowEmbeds; const text = String(input ?? "");
  const tpl = document.createElement('template'); tpl.innerHTML = text.replace(/\\n/g, '<br>');
  const wrap = document.createElement('div'); wrap.style.position = 'relative';
  let textSpan = null;
  const flushTextSpan = () => { if (textSpan && textSpan.childNodes.length) wrap.appendChild(textSpan); textSpan = null; };
  const ensureTextSpan = () => {
    if (!textSpan) {
      textSpan = document.createElement('span');
      textSpan.className = 'glow-target';
      textSpan.style.whiteSpace = 'pre-wrap';
      textSpan.style.position = 'relative';
      textSpan.style.display = 'inline-block';
      textSpan.style.verticalAlign = 'baseline';
      textSpan.style.lineHeight = 'inherit';
    }
    return textSpan;
  };
  const pushText = (s) => { ensureTextSpan().appendChild(document.createTextNode(s || '')); };
  const isHttp = (u)=> /^https?:\/\/.*/i.test(u||''); 
  const isDirectVideo = (u)=> /\.(mp4|webm|ogg)(\?.*)?$/i.test(u||'');

  Array.from(tpl.content.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) { pushText(node.textContent); return; }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') { ensureTextSpan().appendChild(document.createElement('br')); return; }
      if (tag === 'img') { 
        flushTextSpan(); 
        const src = node.getAttribute('src') || ''; 
        if (/^data:image\/.+|^https?:\/\/.*/i.test(src)) { 
          const img = document.createElement('img'); img.src = src; img.alt = node.getAttribute('alt') || ''; img.loading='lazy'; img.decoding='async'; 
          wrap.appendChild(img); 
        } else { pushText('[blocked image]'); flushTextSpan(); } 
        return; 
      }
      if (tag === 'a') { 
        const href = node.getAttribute('href') || ''; const txt = node.textContent || href; 
        if (allowLinks && isHttp(href)) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.textContent = txt; flushTextSpan(); wrap.appendChild(a); } 
        else { pushText(txt); } 
        return; 
      }
      if (allowEmbeds && tag === 'iframe') { 
        flushTextSpan(); 
        const hasSrcdoc = node.hasAttribute('srcdoc'); const src = node.getAttribute('src') || ''; 
        if (hasSrcdoc || isHttp(src)) { 
          const f = document.createElement('iframe'); 
          if (hasSrcdoc) f.setAttribute('srcdoc', node.getAttribute('srcdoc') || ''); else f.src = src; 
          f.loading='lazy'; f.referrerPolicy='no-referrer'; f.title=node.getAttribute('title')||'Embedded content'; 
          f.width=node.getAttribute('width')||'560'; f.height=node.getAttribute('height')||'315'; 
          f.setAttribute('sandbox','allow-scripts allow-same-origin'); 
          wrap.appendChild(f); 
        } else { pushText('[blocked iframe]'); flushTextSpan(); } 
        return; 
      }
      if (allowEmbeds && tag === 'video') { 
        flushTextSpan(); 
        const src = node.getAttribute('src') || ''; 
        if (isHttp(src) && isDirectVideo(src)) { const v = document.createElement('video'); v.src=src; v.controls=true; v.preload='metadata'; v.style.maxWidth='480px'; wrap.appendChild(v); } 
        else { pushText('[blocked video]'); flushTextSpan(); } 
        return; 
      }
      pushText(node.textContent || '');
    }
  });
  flushTextSpan();
  return wrap;
}

/* Glow overlay utilities */
function createGlowOverlayOn(targetEl){
  if (!targetEl) return null;
  const prev = targetEl.querySelector(':scope > .glow-overlay'); if (prev) prev.remove();
  const txt = targetEl.textContent || ''; if (!txt.trim()) return null;
  const ov = document.createElement('span'); ov.className = 'glow-overlay'; ov.textContent = txt;
  const cs = getComputedStyle(targetEl);
  ov.style.font = cs.font;
  ov.style.lineHeight = cs.lineHeight;
  ov.style.whiteSpace = cs.whiteSpace || 'pre-wrap';
  targetEl.appendChild(ov);
  ov.style.setProperty('--glow-ol-opacity', '1');
  return ov;
}

function maybeAnimateMessage(c, bodyEl){
  // Only admins' message bodies glow
  if (!authorIsAdmin(c)) return;

  const forced   = mustAnimate.has(c.id);
  const isPinned = !!c.top;
  const isRecent = (Date.now() - Number(c.created || 0) <= 5000);

  if (isPinned) {
    // Pinned admin messages: once per session unless forced
    if (sessionAnimatedPinned.has(c.id) && !forced) return;
    sessionAnimatedPinned.add(c.id);
  } else if (!(forced || isRecent) || animatedOnce.has(c.id)) {
    // Non‑pinned admin messages: play once if recent (<=5s) or forced
    return;
  } else {
    animatedOnce.add(c.id);
  }

  // Run after layout so overlay aligns perfectly with text baselines
  requestAnimationFrame(() => {
    const targets = bodyEl.querySelectorAll('.glow-target');
    const list = [...targets].filter(el => (el.textContent || '').trim().length);
    if (!list.length) { if (forced) mustAnimate.delete(c.id); return; }

    list.forEach((tgt) => {
      const ov = createGlowOverlayOn(tgt);
      if (!ov) return;
      // Restart sweep reliably
      ov.style.animation = 'none';
      void ov.offsetWidth; // reflow to reset keyframes
      ov.style.animation = 'glowSweep 2s ease-in-out forwards';
      // After sweep, fade the overlay to reveal base text (no flash)
      setTimeout(() => { ov.style.opacity = '0'; }, 2000);
      const cleanup = () => { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); };
      ov.addEventListener('transitionend', cleanup, { once: true });
      setTimeout(cleanup, 3600);
    });

    if (forced) mustAnimate.delete(c.id);
  });
}

/* ===== Build & render ===== */
function buildThread(data){
  state.all.clear(); state.roots = []; state.childrenByRoot.clear(); state.parentOf.clear();
  const arr = Array.isArray(data?.comments) ? data.comments : [];
  for (const c of arr) state.all.set(c.id, c);
  const roots = arr.filter(c => !c.rid);
  state.roots = roots;
  for (const c of arr){
    if (c.rid){
      if (!state.childrenByRoot.has(c.rid)) state.childrenByRoot.set(c.rid, []);
      state.childrenByRoot.get(c.rid).push(c);
    }
    if (c.pid){ state.parentOf.set(c.id, c.pid); }
  }
  for (const list of state.childrenByRoot.values()) list.sort((a,b)=> a.created - b.created);
}

function renderOne(c){
  const msg = document.createElement('div'); msg.className = 'msg'; msg.dataset.id = c.id;
  if (c.top) {
    const badge = document.createElement('span'); badge.className='pin-badge'; badge.textContent='PINNED';
    msg.appendChild(badge);
  }

  const av = document.createElement('div'); av.className = 'avatar'; if (authorIsAdmin(c)) { av.classList.add('admin'); av.textContent='</>'; }
  else { av.textContent = initialOf(c.nick); }
  msg.appendChild(av);

  const bubble = document.createElement('div'); bubble.className='bubble';
  const meta = document.createElement('div'); meta.className='meta';
  const nick = document.createElement('span'); nick.className='nick'; nick.textContent = c.nick || 'Anonymous';
  if (authorIsAdmin(c)) nick.classList.add('admin-glow');
  const time = document.createElement('span'); time.textContent = new Date(c.created||Date.now()).toLocaleString();
  meta.appendChild(nick); meta.appendChild(time);
  bubble.appendChild(meta);

  const content = document.createElement('div'); content.className='content';
  const body = renderSafeContent(c.content, { allowLinks:true, allowEmbeds: authorIsAdmin(c) });
  content.appendChild(body);

  if (c.pid){
    const parent = state.all.get(c.pid);
    if (parent){
      const rline = document.createElement('div'); rline.className='replying-to';
      rline.textContent = `↳ in reply to ${parent.nick || 'Anonymous'}`;
      bubble.appendChild(rline);
    }
  }

  bubble.appendChild(content);

  const actions = document.createElement('div'); actions.className='actions';

  const rootLocked = !!(c.rid ? (state.all.get(c.rid)?.locked) : c.locked);
  const canReply = isAdmin ? true : (allowReplies && !rootLocked);

  if (canReply){
    const btnReply = document.createElement('span'); btnReply.className='action'; btnReply.textContent='Reply';
    btnReply.addEventListener('click', ()=>{
      replyTarget = c;
      if (replyTo){ replyTo.style.display='flex'; replyName.textContent = c.nick || 'Anonymous'; }
      const rootId = c.rid || c.id;
      expanded.add(rootId);
      const rootMsg = messagesEl.querySelector(`.msg[data-id="${rootId}"]`);
      if (rootMsg){
        const wrap = rootMsg.querySelector(':scope > .bubble > .replies');
        if (wrap) setRepliesVisibility(wrap, true);
      }
    });
    actions.appendChild(btnReply);
  }

  if (isAdmin && !c.rid){
    const btnLock = document.createElement('span'); btnLock.className='action';
    btnLock.textContent = c.locked ? 'Unlock replies' : 'Lock replies';
    btnLock.addEventListener('click', async()=>{
      if (c.top){ if (!armConfirmButton(btnLock, 'Are you sure?')) return; }
      try{ await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id:c.id, url:PAGE_URL_PATH, lock: !c.locked }); await loadLatest(true); }
      catch(e){ setStatus(e?.message||'Failed to toggle replies', true); }
    });
    actions.appendChild(btnLock);

    const btnPin = document.createElement('span'); btnPin.className='action'; btnPin.textContent = c.top ? 'Unpin' : 'Pin';
    btnPin.addEventListener('click', async()=>{
      if (c.top){ if (!armConfirmButton(btnPin, 'Are you sure?')) return; }
      try{
        if (!c.top){
          const pinnedNow = (serverCounts?.pinned ?? state.roots.filter(x => x.top).length);
          if (pinnedNow >= 3){ setStatus('You already have 3 pins', true); return; }
        }
        await api({ event:'COMMENT_SET_FOR_ADMIN', id:c.id, url:PAGE_URL_PATH, set:{ top: !c.top } });
        await loadLatest(true);
      }catch(e){ setStatus(e?.message||'Failed to toggle pin', true); }
    });
    actions.appendChild(btnPin);

    if (c.top){
      const up = document.createElement('span'); up.className='action'; up.textContent='▲';
      const dn = document.createElement('span'); dn.className='action'; dn.textContent='▼';
      up.addEventListener('click', ()=>reorderPin(c.id, -1));
      dn.addEventListener('click', ()=>reorderPin(c.id, +1));
      actions.appendChild(up); actions.appendChild(dn);
    }

    const del = document.createElement('span'); del.className='action'; del.textContent='Delete';
    del.addEventListener('click', async()=>{
      if (c.top){ if (!armConfirmButton(del, 'Are you sure?')) return; }
      try{ await api({ event:'COMMENT_DELETE_FOR_ADMIN', id:c.id, url:PAGE_URL_PATH }); await loadLatest(true); }
      catch(e){ setStatus(e?.message||'Failed to delete', true); }
    });
    actions.appendChild(del);
  }

  bubble.appendChild(actions);
  msg.appendChild(bubble);

  const repliesWrap = document.createElement('div');
  repliesWrap.className = 'replies';
  if (expanded.has(c.id)) repliesWrap.style.display = 'flex';
  bubble.appendChild(repliesWrap);

  if (!c.rid) {
    const rootId = c.id;
    const computeCount = () => (state.childrenByRoot.get(rootId) || []).length;
    const n = computeCount();
    if (n > 0) {
      const btnToggle = document.createElement('span');
      btnToggle.className = 'action';
      const setLabel = () => {
        btnToggle.textContent = expanded.has(rootId)
          ? 'Hide replies'
          : `Show replies (${n})`;
      };
      setLabel();
      btnToggle.addEventListener('click', () => {
        if (expanded.has(rootId)) {
          expanded.delete(rootId);
          setRepliesVisibility(repliesWrap, false);
        } else {
          expanded.add(rootId);
          setRepliesVisibility(repliesWrap, true);
        }
        setLabel();
      });
      actions.appendChild(btnToggle);
    }
  }

  maybeAnimateMessage(c, body);

  return { el: msg, repliesWrap };
}

async function reorderPin(id, delta){
  try{
    const pinnedIds = [...messagesEl.querySelectorAll('.msg')].map(d=>d.dataset.id).filter(id=>{
      const c = state.all.get(id); return c && !c.rid && c.top;
    });
    const idx = pinnedIds.indexOf(id); if (idx<0) return;
    const j = idx + delta; if (j<0 || j>=pinnedIds.length) return;
    const swap = pinnedIds[j]; pinnedIds[j] = pinnedIds[idx]; pinnedIds[idx] = swap;
    await api({ event:'COMMENT_REORDER_PINS_FOR_ADMIN', url: PAGE_URL_PATH, order: pinnedIds });
    await loadLatest(true);
  }catch(e){ setStatus(e?.message||'Failed to reorder pins', true); }
}

function clearMessages(){
  if (!messagesEl) return;
  while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
}

function renderAllIncremental(){
  if (!messagesEl) return;
  clearMessages();

  for (const r of state.roots){
    const childCount = (state.childrenByRoot.get(r.id)||[]).length;
    prevChildCounts.set(r.id, childCount);
  }
  seededChildCounts = true;

  for (const root of state.roots){
    const { el, repliesWrap } = renderOne(root, 0);
    messagesEl.appendChild(el);

    const children = state.childrenByRoot.get(root.id) || [];
    const kidsOf = new Map(); children.forEach(ch => { const p = ch.pid || root.id; if (!kidsOf.has(p)) kidsOf.set(p, []); kidsOf.get(p).push(ch); });
    const renderSub = (parentId, container) => {
      const arr = kidsOf.get(parentId) || [];
      for (const ch of arr){
        const { el: childEl, repliesWrap: childWrap } = renderOne(ch, 1);
        container.appendChild(childEl);
        renderSub(ch.id, childWrap);
      }
    };
    renderSub(root.id, repliesWrap);

    if (expanded.has(root.id)) setRepliesVisibility(repliesWrap, true);
    else setRepliesVisibility(repliesWrap, false);

    el.addEventListener('click', (evt)=>{
      if (evt.target && evt.target.classList.contains('action') && evt.target.textContent === 'Reply') {
        expanded.add(root.id);
        setRepliesVisibility(repliesWrap, true);
      }
    });
  }
}

/* ===== Loading ===== */
async function loadLatest(){
  if (loading) return; loading = true;
  try{
    const r = await api({ event:'GET', url: PAGE_URL_PATH, page:1, pageSize: 200 });
    serverCounts = r?.data?.counts || null;
    buildThread(r?.data);
    renderAllIncremental();
    updateAdminUI();
  }catch(e){ setStatus(e?.message||'Load failed', true); }
  finally{ loading = false; }
}

/* ===== Auth & send ===== */
btnAdminLogin && btnAdminLogin.addEventListener('click', async()=>{
  const pw = (adminPass && adminPass.value) || "";
  setStatus('Logging in…');
  try{
    const r = await api({ event:'LOGIN', password: pw });
    if (r && r.code===0 && r.accessToken){ TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN); await refreshAdminStatus(); setStatus(''); }
    else setStatus(r?.message || 'Login failed', true);
  }catch(e){ setStatus(e?.message||'Login failed', true); }
});

btnAdminLogout && btnAdminLogout.addEventListener('click', async()=>{
  TK_TOKEN = null; localStorage.removeItem('twikoo_access_token'); localStorage.removeItem('twikoo_is_admin'); isAdmin = false; await refreshAdminStatus();
});

replyCancel && replyCancel.addEventListener('click', ()=>{ replyTarget=null; if (replyTo) replyTo.style.display='none'; updateAdminUI(); });

btnSend && btnSend.addEventListener('click', async()=>{
  let content = (textEl.value || '').trim();
  if (!content){ setStatus('Type something'); return; }
  if (!isAdmin && !allowPosts){ setStatus('Only admin can post right now', true); return; }

  const hasMediaTags = /<(img|iframe|video)\b/i.test(content);
  if (!hasMediaTags && content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS);
  content = content.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');

  if (!isAdmin){
    const imgCount = (content.match(/<img\b[^>]*>/gi) || []).length;
    if (imgCount > 1) { setStatus('Only one image per message allowed', true); return; }
  }

  const nick = isAdmin ? ADMIN_NICK : (nickEl.value || '').trim().slice(0,10) || 'Anonymous';

  if (isAdmin && !replyTarget && sendAutoPinEl && sendAutoPinEl.checked){
    const currentPins = (serverCounts?.pinned ?? state.roots.filter(x=>x.top).length);
    if (currentPins >= 3){ setStatus('You already have 3 pins', true); return; }
  }

  setStatus('Sending…');
  btnSend.disabled = true;

  try{
    const payload = {
      event: 'COMMENT_CREATE',
      url: PAGE_URL_PATH,
      nick,
      content,
      pid: replyTarget ? replyTarget.id : "",
      rid: replyTarget ? (replyTarget.rid || replyTarget.id) : ""
    };
    const r = await api(payload);
    if (r && r.code===0){
      const newId = r.data?.id;
      if (newId) { mustAnimate.add(String(newId)); }

      if (isAdmin && !replyTarget && sendNoReplyEl && sendNoReplyEl.checked){
        try { await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id:newId, url: PAGE_URL_PATH, lock: true }); } catch{}
      }
      if (isAdmin && !replyTarget && sendAutoPinEl && sendAutoPinEl.checked){
        try { await api({ event:'COMMENT_SET_FOR_ADMIN', id:newId, url: PAGE_URL_PATH, set:{ top:true } }); } catch{}
      }

      textEl.value=''; updateCharCount(); fileEl.value=''; if (fileInfo) fileInfo.textContent='';
      replyTarget=null; if (replyTo) replyTo.style.display='none';
      setStatus('');

      await loadLatest(true);
    }else{
      setStatus(r?.message || 'Send failed', true);
    }
  }catch(e){ setStatus(e?.message||'Send failed', true); }
  finally{ btnSend.disabled = false; }
});

/* ===== Init ===== */
(async function init(){
  updateCharCount();
  try { await refreshAdminStatus(); } catch(e){ setStatus(e?.message||'Config failed', true); }
  try { await loadLatest(true); } catch(e){ setStatus(e?.message||'Load failed', true); }
  if (connEl){ connEl.textContent = ws && ws.readyState===1 ? "Live: Connected" : "Live: Connecting…"; }
})();