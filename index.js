/* Poly Track Chatboard – index.js (v38)
   Fixes:
   - Show “Replying to …” on replies; nested replies indent under parent.
   - Admin can reply even when global replies are off (and it actually replies).
   - Admin avatar is fixed "</>" (never replaced by message images).
   - Pinned admin messages animate only once per page load, unless a new pin appears.
   - Keeps previous features intact (pin reorder, two-tap confirms, live updates, etc).
*/

console.log("chatboard.index.js v38");

/* ---- Embedding guard (relaxed) ----
   We now rely on CSP (frame-ancestors) and the backend allowlist.
   This guard will NOT block rendering to avoid false negatives inside Google Sites.
*/
(function(){
  try{
    if (window.top !== window.self) {
      let allowed = false;
      const ref = document.referrer || '';

      // Prefer document.referrer
      try{
        const u = new URL(ref);
        if (u.hostname === 'sites.google.com') {
          const p = u.pathname.replace(/\/+$/,'');
          if (p.startsWith('/view/poly-track')) allowed = true;
        }
      }catch{}

      // Fallback: ancestorOrigins (Chrome)
      if (!allowed && document.location && document.location.ancestorOrigins && document.location.ancestorOrigins.length){
        const ao = document.location.ancestorOrigins[0];
        try{
          const a = new URL(ao);
          if (a.hostname === 'sites.google.com') {
            const p = a.pathname.replace(/\/+$/,'');
            if (p.startsWith('/view/poly-track')) allowed = true;
          }
        }catch{}
      }

      if (!allowed) {
        // Do not block; let CSP + server CORS decide.
        console.warn('Embedding referrer not recognized; allowing page to load and deferring to server/CSP.');
      }
    }
  }catch{}
})();

/* ===== Constants ===== */
const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 7;
const MAX_CHARS     = 2000;

/* ===== Global shimmer driver (stable across reflows/resizing) ===== */
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

/* ===== Live updates via WebSocket ===== */
const WS_ENDPOINT = WORKER_URL.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws?room=' + encodeURIComponent(PAGE_URL_PATH);
let ws = null, wsPing = null, wsBackoff = 500;
function connectWS(){
  try{
    ws = new WebSocket(WS_ENDPOINT);
    ws.onopen = () => {
      wsBackoff = 500;
      if (connEl){ connEl.textContent = "Live: Connected"; connEl.classList.add("ok"); connEl.classList.remove("bad"); }
      wsPing = setInterval(() => { try { ws.send("ping"); } catch {} }, 30000);
    };
    const doRefresh = async () => {
      try { await refreshAdminStatus(); } catch {}
      try { await loadLatest(true); } catch {}
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data === 'pong') return;
        try { const msg = JSON.parse(e.data); if (msg && msg.type === "refresh") doRefresh(); }
        catch { doRefresh(); }
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
const state = { all:new Map(), roots:[] };
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
function authorIsAdmin(c){ return String((c && c.nick) || '') === 'Poly Track Administrator'; }

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
    const resp = await api({ event:'UPLOAD_IMAGE', photo:String(dataURL) });
    if (resp && resp.code===0 && resp.data && resp.data.url){
      const url = resp.data.url; const prefix = textEl.value.trim().length ? '\n' : '';
      textEl.value = (textEl.value + `${prefix}<img src=\"${url}\">`).trim(); updateCharCount(); setStatus('Image attached');
      fileEl.value=''; fileInfo && (fileInfo.textContent='');
    } else { setStatus(resp && resp.message ? resp.message : 'Upload failed', true); }
  }catch(e){ setStatus(e && e.message ? e.message : 'Upload failed', true); }
}));

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
function renderSafeContent(input, opts = {}){
  const allowLinks = !!opts.allowLinks; const allowEmbeds = !!opts.allowEmbeds; const text = String(input ?? "");
  const tpl = document.createElement('template'); tpl.innerHTML = text.replace(/\n/g, '<br>');
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
    }
    return textSpan;
  };
  const pushText = (s) => { ensureTextSpan().appendChild(document.createTextNode(s || '')); };
  const isHttp = (u)=> /^https?:\/\//i.test(u||''); const isDirectVideo = (u)=> /\.(mp4|webm|ogg)(\?.*)?$/i.test(u||'');
  Array.from(tpl.content.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) { pushText(node.textContent); return; }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') { ensureTextSpan().appendChild(document.createElement('br')); return; }
      if (tag === 'img') { flushTextSpan(); const src = node.getAttribute('src') || ''; if (/^data:image\/.+|^https?:\/\//i.test(src)) { const img = document.createElement('img'); img.src = src; img.alt = node.getAttribute('alt') || ''; img.loading='lazy'; img.decoding='async'; wrap.appendChild(img); } else { pushText('[blocked image]'); flushTextSpan(); } return; }
      if (tag === 'a') { const href = node.getAttribute('href') || ''; const txt = node.textContent || href; if (allowLinks && isHttp(href)) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.textContent = txt; flushTextSpan(); wrap.appendChild(a); } else { pushText(txt); } return; }
      if (allowEmbeds && tag === 'iframe') { flushTextSpan(); const hasSrcdoc = node.hasAttribute('srcdoc'); const src = node.getAttribute('src') || ''; if (hasSrcdoc || isHttp(src)) { const f = document.createElement('iframe'); if (hasSrcdoc) f.setAttribute('srcdoc', node.getAttribute('srcdoc') || ''); else f.src = src; f.loading='lazy'; f.referrerPolicy='no-referrer'; f.title=node.getAttribute('title')||'Embedded content'; f.width=node.getAttribute('width')||'560'; f.height=node.getAttribute('height')||'315'; f.setAttribute('sandbox','allow-scripts allow-same-origin'); wrap.appendChild(f); } else { pushText('[blocked iframe]'); flushTextSpan(); } return; }
      if (allowEmbeds && tag === 'video') { flushTextSpan(); const src = node.getAttribute('src') || ''; if (isHttp(src) && isDirectVideo(src)) { const v = document.createElement('video'); v.src=src; v.controls=true; v.preload='metadata'; v.style.maxWidth='480px'; wrap.appendChild(v); } else { pushText('[blocked video]'); flushTextSpan(); } return; }
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
  ov.style.font = getComputedStyle(targetEl).font;
  targetEl.appendChild(ov); ov.style.setProperty('--glow-ol-opacity', '1'); return ov;
}
function applyOverlayGlowOnce(bodyEl){
  const targets = bodyEl.querySelectorAll('.glow-target'); const list = targets.length ? [...targets] : [bodyEl];
  list.forEach((tgt)=>{ const ov = createGlowOverlayOn(tgt); if (!ov) return; setTimeout(()=> { ov.style.setProperty('--glow-ol-opacity', '0'); }, 2000); setTimeout(()=> { ov.remove(); }, 3500); });
}
function applyOverlayGlowRemainder(bodyEl, c){
  const targets = bodyEl.querySelectorAll('.glow-target');
  const list = targets.length ? [...targets] : [bodyEl];

  const created = Number(c?.created || Date.now());
  const elapsed = Math.max(0, (Date.now() - created) / 1000);
  const remain = Math.max(0, 2 - elapsed);

  list.forEach((tgt) => {
    const ov = createGlowOverlayOn(tgt);
    if (!ov) return;

    if (remain <= 0) {
      ov.style.setProperty('--glow-ol-opacity', '0');
      setTimeout(() => { try{ ov.remove(); } catch {} }, 1600);
    } else {
      setTimeout(() => {
        ov.style.setProperty('--glow-ol-opacity', '0');
      }, Math.round(remain * 1000));
      setTimeout(() => { try{ ov.remove(); } catch {} }, Math.round(remain * 1000) + 1500);
    }
  });
}

/* ===== Build actions (reply/pin/lock/delete/reorder) ===== */
function buildActionsFor(c){
  const actions = document.createElement('div'); actions.className = 'actions';
  const cid = c.id; const isRoot = (c.rid||'') === '';
  const rootIdForLock = isRoot ? cid : c.rid;
  const rootForLock = state.all.get(rootIdForLock);
  const threadLocked = !!(rootForLock && rootForLock.locked);

  if ((allowReplies || isAdmin) && (!threadLocked || isAdmin)){
    const replyBtn = document.createElement('span'); replyBtn.className='action'; replyBtn.dataset.action='reply'; replyBtn.textContent='↩ Reply'; actions.appendChild(replyBtn);
  }

  const count = c.children?.length || 0;
  if (isRoot && count > 0){
    const toggleBtn = document.createElement('span'); toggleBtn.className='action'; toggleBtn.dataset.action='toggleReplies'; toggleBtn.dataset.parent=cid;
    toggleBtn.textContent = (expanded.has(cid) ? (count===1? 'Close Reply':'Close Replies') : (count===1? 'Show Reply':'Show Replies'));
    actions.appendChild(toggleBtn);
  }

  if (isAdmin){
    const delBtn = document.createElement('span'); delBtn.className='action'; delBtn.dataset.action='adminDel'; delBtn.dataset.cid=cid; delBtn.textContent='Delete'; actions.appendChild(delBtn);

    if (isRoot){
      const pinBtn = document.createElement('span'); pinBtn.className='action'; pinBtn.dataset.action='adminPin'; pinBtn.dataset.cid=cid; pinBtn.textContent = Number(c.top)===1 ? 'Unpin' : 'Pin'; actions.appendChild(pinBtn);

      if (Number(c.top)===1){
        const up = document.createElement('span'); up.className='action'; up.dataset.action='pinUp'; up.dataset.cid=cid; up.textContent='▲'; actions.appendChild(up);
        const down = document.createElement('span'); down.className='action'; down.dataset.action='pinDown'; down.dataset.cid=cid; down.textContent='▼'; actions.appendChild(down);
      }

      const lockBtn = document.createElement('span'); lockBtn.className='action'; lockBtn.dataset.action='lockToggle'; lockBtn.dataset.cid=rootIdForLock; lockBtn.textContent = threadLocked ? 'Unlock replies' : 'Lock replies'; actions.appendChild(lockBtn);
    }
  }
  return actions;
}

/* ===== Build one message node ===== */
function buildMessage(c){
  const wrap = document.createElement('div'); wrap.className='msg'; wrap.dataset.id=c.id; wrap.dataset.rid=c.rid||''; wrap.dataset.top=String(Number(c.top||0));
  if (Number(c.top)===1 && (c.rid||'')===''){ const badge=document.createElement('span'); badge.className='pin-badge'; badge.textContent='Pinned'; wrap.appendChild(badge); }

  const avatar = document.createElement('div'); 
  avatar.className = 'avatar' + (authorIsAdmin(c) ? ' admin' : '');
  if (authorIsAdmin(c)) {
    avatar.textContent = "</>";
  } else {
    avatar.textContent = initialOf(c.nick);
  }

  const bubble = document.createElement('div'); bubble.className='bubble';
  const meta = document.createElement('div'); meta.className='meta';
  const nick = document.createElement('span'); nick.className='nick' + (authorIsAdmin(c) ? ' admin-glow' : ''); nick.textContent = c.nick || 'Anonymous';
  const when = document.createElement('span'); when.textContent = new Date(c.created||Date.now()).toLocaleString();
  meta.appendChild(nick); meta.appendChild(when);

  const body = document.createElement('div'); body.className='content';

  if ((c.rid || '') !== ''){
    const parent = state.all.get(c.pid || c.rid);
    const who = parent ? (parent.nick || 'Anonymous') : 'thread';
    const replyLine = document.createElement('div');
    replyLine.className = 'replying-to';
    replyLine.textContent = `↪ Replying to ${who}`;
    body.appendChild(replyLine);
  }

  const safe = renderSafeContent(c.content, { allowLinks:true, allowEmbeds:isAdmin });
  body.appendChild(safe);

  if (authorIsAdmin(c)){
    if (Number(c.top)===1 && (c.rid||'')===''){
      if (!sessionAnimatedPinned.has(c.id)) { applyOverlayGlowOnce(safe); sessionAnimatedPinned.add(c.id); }
    } else {
      const age = Date.now() - Number(c.created||0);
      if (age <= 5000) applyOverlayGlowRemainder(safe, c);
    }
  }

  bubble.appendChild(meta); bubble.appendChild(body);
  bubble.appendChild(buildActionsFor(c));

  wrap.appendChild(avatar); wrap.appendChild(bubble);

  if ((c.children?.length||0) > 0){
    const rep = document.createElement('div'); rep.className='replies'; rep.dataset.parent=c.id;
    if (expanded.has(c.id)) rep.style.display='flex';
    c.children.forEach(ch => { rep.appendChild(buildMessage(ch)); });
    bubble.appendChild(rep);
  }
  return wrap;
}

/* ===== Merge + Render ===== */
function indexById(list){ const m = new Map(); list.forEach(x=>m.set(x.id,x)); return m; }
function asTree(comments){
  const byId = indexById(comments);
  const roots = []; comments.forEach(c=>{ c.children = []; });
  comments.forEach(c=>{ if ((c.rid||'')===''){ roots.push(c); } });
  comments.forEach(c=>{ if ((c.rid||'')!==''){ const r = byId.get(c.rid); if (r) r.children.push(c); } });
  roots.forEach(r=> r.children.sort((a,b)=> a.created - b.created));
  return { byId, roots };
}
function renderAll(){
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  state.roots.forEach(r => { messagesEl.appendChild(buildMessage(r)); });
}
function renderAllIncremental(){ renderAll(); }

/* ===== Loading ===== */
async function loadLatest(force=false){
  if (loading) return; loading=true; setStatus('');
  try{
    const r = await api({ event:'COMMENT_GET', url: PAGE_URL_PATH, page:1, pageSize:50 });
    if (r && r.code===0 && r.data){
      const list = (r.data.comments||[]).map(c=>({
        id:c.id, url:c.url, nick:c.nick, content:c.content, created:Number(c.created||c.created_at||Date.now()),
        top: c.top?1:0, pid: c.pid||'', rid: c.rid||'', locked: !!c.locked
      }));
      const { byId, roots } = asTree(list);
      state.all = byId; state.roots = roots;
      serverCounts = r.data.counts || null;

      if (!seededChildCounts){
        roots.forEach(rt => prevChildCounts.set(rt.id, rt.children.length||0));
        seededChildCounts = true;
      } else {
        const deltas = [];
        roots.forEach(rt => {
          const prev = prevChildCounts.get(rt.id) ?? 0;
          const cur = rt.children.length || 0;
          if (cur > prev) deltas.push(rt.id);
          prevChildCounts.set(rt.id, cur);
        });
        deltas.forEach(id => expanded.add(id));
      }

      updateAdminUI();
    } else {
      setStatus(r && r.message ? r.message : 'Failed to load', true);
    }
  }catch(e){ setStatus(e?.message || 'Load error', true); }
  finally{ loading=false; }
}

/* ===== Send (admin auto pin / no-reply) ===== */
async function sendComment(){
  const nick = isAdmin ? 'Poly Track Administrator' : (nickEl?.value.trim().slice(0,10) || 'Anonymous');
  let content = (textEl?.value || '').trim();
  if (!content){ setStatus('Type a message'); return; }
  if (!isAdmin && !allowPosts){ setStatus('Only admin can post right now', true); return; }

  content = content.replace(/\r\n?/g,'\n').replace(/\n{3,}/g,'\n\n');

  const isReplying = !!replyTarget;
  const pid = isReplying ? (replyTarget.pid || '') : '';
  const rid = isReplying ? (replyTarget.rid || replyTarget.id || '') : '';

  if (isAdmin && !isReplying && sendAutoPinEl && sendAutoPinEl.checked){
    const pinnedNow = (serverCounts && typeof serverCounts.pinned === 'number')
      ? serverCounts.pinned
      : state.roots.filter(r=> Number(r.top)===1).length;
    if (pinnedNow >= 3){
      setStatus('Pin limit reached (3). Unpin a message first.', true);
      return;
    }
  }

  const res = await api({ event:'COMMENT_SUBMIT', url: PAGE_URL_PATH, nick, content, pid, rid });
  if (res && res.code===0){
    const newId = res.data && res.data.id;

    if (isAdmin && !isReplying && newId){
      try{
        if (sendNoReplyEl && sendNoReplyEl.checked){
          await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id: newId, url: PAGE_URL_PATH, lock: true });
        }
        if (sendAutoPinEl && sendAutoPinEl.checked){
          await api({ event:'COMMENT_SET_FOR_ADMIN', id: newId, url: PAGE_URL_PATH, set:{ top: true } });
        }
      }catch(e){
        setStatus(e?.message || 'Post action failed', true);
      }
    }

    textEl.value=''; updateCharCount();
    replyTarget=null; if (replyTo) replyTo.style.display='none';

    await loadLatest(true);
  } else {
    setStatus(res && res.message ? res.message : 'Send failed', true);
  }
}

/* ===== Actions handling ===== */
function nearestMsg(el){ while(el && el!==document.body){ if (el.classList && el.classList.contains('msg')) return el; el = el.parentElement; } return null; }
function parentRootId(c){ return (c.rid||'')===''? c.id : c.rid; }

if (!document.body.dataset.boundActions){
  document.body.dataset.boundActions='1';
  document.body.addEventListener('click', async (e)=>{
    const target = e.target.closest('.action'); if (!target) return;
    const msg = nearestMsg(target); const cid = msg?.dataset?.id; const rid = msg?.dataset?.rid || '';
    const act = target.dataset.action;

    if (act === 'reply'){
      const c = state.all.get(cid); replyTarget = { id: cid, pid: cid, rid: parentRootId(c) };
      if (replyTo){ replyTo.style.display='flex'; replyName.textContent = c?.nick || 'Anonymous'; }
      updateAdminUI();
      return;
    }

    if (act === 'toggleReplies'){
      const pid = target.dataset.parent || cid; if (expanded.has(pid)) expanded.delete(pid); else expanded.add(pid);
      renderAllIncremental();
      return;
    }

    if (act === 'adminDel'){
      if (!isAdmin) return;
      const c = state.all.get(cid) || {};
      const isRoot = (c.rid || '') === '';
      const isPinnedRoot = isRoot && Number(c.top) === 1;
      if (isPinnedRoot){
        if (!armConfirmButton(target, 'Are you sure?', 3000)) return;
      }
      const url = PAGE_URL_PATH;
      const r = await api({ event:'COMMENT_DELETE_FOR_ADMIN', id: c.id, url });
      if (r && r.code===0){ await loadLatest(true); }
      else { setStatus(r && r.message ? r.message : 'Delete failed', true); }
      return;
    }

    if (act === 'adminPin'){
      if (!isAdmin) return;
      const c = state.all.get(cid) || {};
      const isRoot = (c.rid || '') === '';
      const isPinned = Number(c.top) === 1;
      const wantTop = isPinned ? 0 : 1;
      if (isRoot && isPinned && wantTop === 0){
        if (!armConfirmButton(target, 'Are you sure?', 3000)) return;
      }
      const r = await api({ event:'COMMENT_SET_FOR_ADMIN', id: c.id, url: PAGE_URL_PATH, set:{ top: !!wantTop } });
      if (r && r.code===0){ await loadLatest(true); }
      else { setStatus(r && r.message ? r.message : 'Pin toggle failed', true); }
      return;
    }

    if (act === 'pinUp' || act === 'pinDown'){
      if (!isAdmin) return;
      const pinnedEls = [...document.querySelectorAll('.msg[data-top=\"1\"][data-rid=\"\"]')];
      const order = pinnedEls.map(el => el.dataset.id);
      const idx = order.indexOf(cid);
      if (idx === -1) return;
      if (act === 'pinUp' && idx > 0) { [order[idx-1], order[idx]] = [order[idx], order[idx-1]]; }
      if (act === 'pinDown' && idx < order.length-1) { [order[idx+1], order[idx]] = [order[idx], order[idx+1]]; }
      const resp = await api({ event:'COMMENT_REORDER_PINS_FOR_ADMIN', url: PAGE_URL_PATH, order });
      if (resp && resp.code===0){ await loadLatest(true); }
      else { setStatus(resp && resp.message ? resp.message : 'Reorder failed', true); }
      return;
    }

    if (act === 'lockToggle'){
      if (!isAdmin) return;
      const c = state.all.get(cid) || {};
      const rootId = (c.rid || '') === '' ? c.id : c.rid;
      const root = state.all.get(rootId) || {};
      const locked = !!root.locked;
      const isPinnedRoot = ((root.rid || '') === '') && Number(root.top) === 1;
      if (isPinnedRoot && locked){
        if (!armConfirmButton(target, 'Are you sure?', 3000)) return;
      }
      const resp = await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id: rootId, url: PAGE_URL_PATH, lock: !locked });
      if (resp && resp.code===0){ await loadLatest(true); }
      else { setStatus(resp && resp.message ? resp.message : 'Lock toggle failed', true); }
      return;
    }
  });
}

/* ===== Login / Logout ===== */
btnAdminLogin && btnAdminLogin.addEventListener('click', async ()=>{
  const password = adminPass?.value || '';
  const r = await api({ event:'LOGIN', password });
  if (r && r.code===0 && r.accessToken){ TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN); await refreshAdminStatus(); await loadLatest(true); }
  else { setStatus(r && r.message ? r.message : 'Login failed', true); }
});
btnAdminLogout && btnAdminLogout.addEventListener('click', async ()=>{
  TK_TOKEN = null; localStorage.removeItem('twikoo_access_token'); localStorage.removeItem('twikoo_is_admin'); await refreshAdminStatus(); await loadLatest(true);
});

/* ===== Reply UI ===== */
replyCancel && replyCancel.addEventListener('click', ()=>{ replyTarget=null; if (replyTo) replyTo.style.display='none'; updateAdminUI(); });

/* ===== Send button ===== */
btnSend && btnSend.addEventListener('click', ()=>{ sendComment().catch(e=> setStatus(e?.message||'Send error', true)); });

/* ===== Embed UI (inline, admin only) ===== */
if (embedModeEl && !embedModeEl.dataset.bound){
  embedModeEl.dataset.bound='1';
  embedModeEl.addEventListener('change', ()=>{
    if (!embedUrlEl || !embedHtmlEl) return;
    if (embedModeEl.value === 'url'){ embedUrlEl.style.display='block'; embedHtmlEl.style.display='none'; }
    else { embedUrlEl.style.display='none'; embedHtmlEl.style.display='block'; }
  });
}
if (btnEmbedInsert && !btnEmbedInsert.dataset.bound){
  btnEmbedInsert.dataset.bound='1';
  btnEmbedInsert.addEventListener('click', ()=>{
    if (!isAdmin){ setStatus('Embeds are admin-only', true); return; }
    if (!textEl) return;
    const mode = embedModeEl?.value || 'url';
    if (mode === 'url'){
      const u = (embedUrlEl?.value||'').trim(); if (!u){ setStatus('Enter a URL to embed'); return; }
      const html = `<iframe src=\"${u.replace(/\"/g,'&quot;')}\" width=\"560\" height=\"315\" sandbox=\"allow-scripts allow-same-origin\" referrerpolicy=\"no-referrer\"></iframe>`;
      textEl.value = (textEl.value + (textEl.value?'\n':'') + html).trim();
    } else {
      const raw = (embedHtmlEl?.value||'').trim(); if (!raw){ setStatus('Enter HTML to embed'); return; }
      const srcdoc = raw.replace(/\"/g,'&quot;');
      const html = `<iframe srcdoc=\"${srcdoc}\" width=\"560\" height=\"315\" sandbox=\"allow-scripts allow-same-origin\" referrerpolicy=\"no-referrer\"></iframe>`;
      textEl.value = (textEl.value + (textEl.value?'\n':'') + html).trim();
    }
    updateCharCount(); setStatus('Embed inserted');
  });
}

/* ===== Init ===== */
(async function init(){
  try{ await refreshAdminStatus(); } catch {}
  try{ await loadLatest(true); } catch {}
  try{ if (!window.__wsStarted) connectWS(); } catch {}
  try{ updateCharCount(); } catch {}
})();