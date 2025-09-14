/* Poly Track Chatboard – index.js (v30) */
console.log("chatboard.index.js v30");

const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 7;
const MAX_CHARS     = 2000;

/* ===== Global shimmer driver (keeps phase stable) ===== */
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
        try {
          const msg = JSON.parse(e.data);
          if (msg && msg.type === "refresh") doRefresh();
        } catch { doRefresh(); }
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

const SHOW_ADMIN_PANEL =
  window.location.hostname === "htmlunblockedgames.github.io" &&
  window.location.pathname === "/chatboard/" &&
  new URLSearchParams(window.location.search).get("admin") === "1";
if (adminPanel) adminPanel.style.display = SHOW_ADMIN_PANEL ? "grid" : "none";

/* ===== State ===== */
let TK_TOKEN = localStorage.getItem('twikoo_access_token') || null;
const state = { all:new Map(), tops:[], rootOrder:[] };
let serverCounts = null;
let loading=false;
let earliestMainCreated=null;
let replyTarget=null;
const expanded = new Set();
const prevChildCounts = new Map();
let isAdmin = false;
let rateBlockedUntil = 0;
const pinAnimPlayed = new Set();
let allowReplies = true;
let allowPosts = true;

/* ===== UI helpers ===== */
limitMbEl.textContent=MAX_FILE_MB;
limitChars.textContent=MAX_CHARS;
limitChars2.textContent=MAX_CHARS;

const setStatus=(t,isError=false)=>{
  if(!t){ statusEl.style.display="none"; statusEl.textContent=""; return; }
  statusEl.style.display="inline"; statusEl.textContent=t;
  statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
};
const initialOf = s => (s||"A").trim().charAt(0).toUpperCase();
function truthy(v){ return v === true || v === 1 || v === '1' || v === 'true'; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseRetryAfter(h){
  if (!h) return 0; const n = Number(h); if (!Number.isNaN(n)) return Date.now() + n*1000;
  const d = Date.parse(h); return Number.isNaN(d) ? 0 : d;
}
function authorIsAdmin(c){ return String((c && c.nick) || '') === 'Poly Track Administrator'; }

/* Inline confirm helper */
function armConfirmButton(btn, label = 'Are you sure?', ms = 3000){
  if (!btn) return false;
  if (btn.dataset.confirm === '1') {
    const tid = Number(btn.dataset.confirmTimer || 0);
    if (tid) clearTimeout(tid);
    btn.dataset.confirm = '0';
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    btn.style.color = '';
    btn.style.borderColor = '';
    return true;
  }
  btn.dataset.confirm = '1';
  if (!btn.dataset.origText) btn.dataset.origText = btn.textContent || '';
  btn.textContent = label;
  btn.style.color = 'var(--danger)';
  btn.style.borderColor = 'var(--danger)';
  const tid = setTimeout(() => {
    btn.dataset.confirm = '0';
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    btn.style.color = '';
    btn.style.borderColor = '';
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
  const maxAttempts = idempotent ? 3 : 1;
  let attempt=0,lastErr;
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
      if (eventObj.event === 'LOGIN' && j?.accessToken) {
        TK_TOKEN = j.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }
      if (eventObj.event === 'GET_CONFIG' && j?.accessToken) {
        TK_TOKEN = j.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }
      return j;
    }catch(e){
      lastErr=e;
      if (attempt<maxAttempts){ await sleep(500*Math.pow(2,attempt-1)+Math.random()*200); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("Request failed");
}

/* ===== Admin UI & toggles ===== */
function updateSendButtonUI(){
  if (!btnSend) return;
  if (!isAdmin && !allowPosts) {
    btnSend.disabled = true;
    btnSend.textContent = "Chat Locked";
    btnSend.title = "Only admin can post right now";
  } else {
    btnSend.disabled = false;
    btnSend.textContent = "Send";
    btnSend.title = "";
  }
}

function getPinnedRootCount(){
  if (serverCounts && typeof serverCounts.pinned === 'number') return serverCounts.pinned;
  let n=0; for (const r of state.tops) if ((r.rid||'')==='' && Number(r.top)===1) n++;
  return n;
}

function updateAdminUI(){
  const counts = serverCounts;
  const pinned = (counts && typeof counts.pinned === 'number')
    ? counts.pinned : state.tops.filter(x => Number(x.top) === 1 && (x.rid||'')==='').length;
  const total = (counts && typeof counts.total === 'number')
    ? counts.total : state.all.size;
  const replies = (counts && typeof counts.replies === 'number')
    ? counts.replies : Math.max(0, state.all.size - state.tops.length);
  const today = (counts && typeof counts.today === 'number')
    ? counts.today
    : (()=>{ const d=new Date(); d.setHours(0,0,0,0); let t=0; for(const v of state.all.values()) if((v.created||0)>=d.getTime()) t++; return t; })();

  pinCountEl.textContent = String(pinned);
  if (statTotalEl)   statTotalEl.textContent = String(total);
  if (statRepliesEl) statRepliesEl.textContent = String(replies);
  if (statTodayEl)   statTodayEl.textContent = String(today);

  if (isAdmin) {
    adminLoginRow.style.display = 'none';
    adminControls.style.display = 'flex';
    adminNote.textContent = 'You are logged in as admin';
  } else {
    adminLoginRow.style.display = 'flex';
    adminControls.style.display = 'none';
    adminNote.textContent = 'Login to manage comments';
  }

  document.body.classList.toggle('is-admin', !!isAdmin);
  if (adminPanel) adminPanel.style.display = (SHOW_ADMIN_PANEL || isAdmin) ? 'grid' : 'none';
  if (nickEl && nickEl.parentElement) nickEl.parentElement.style.display = isAdmin ? 'none' : 'flex';

  if (toggleRepliesEl) {
    toggleRepliesEl.checked = !!allowReplies;
    toggleRepliesEl.disabled = !isAdmin;
    toggleRepliesEl.parentElement.style.display = isAdmin ? 'inline-flex' : 'none';
  }
  if (togglePostsEl) {
    togglePostsEl.checked = !allowPosts; // checked = only admin can post
    togglePostsEl.disabled = !isAdmin;
    togglePostsEl.parentElement.style.display = isAdmin ? 'inline-flex' : 'none';
  }

  if (optNoReplyEl) {
    const show = !!isAdmin && !replyTarget;
    optNoReplyEl.style.display = show ? 'inline-flex' : 'none';
    if (sendNoReplyEl) sendNoReplyEl.disabled = !show || !allowReplies;
  }
  if (optAutoPinEl) {
    const show = !!isAdmin && !replyTarget;
    optAutoPinEl.style.display = show ? 'inline-flex' : 'none';
    if (sendAutoPinEl) sendAutoPinEl.disabled = !show;
  }

  if (embedBox) embedBox.style.display = isAdmin ? "flex" : "none";

  if (!allowReplies) { replyTarget = null; replyTo.style.display = 'none'; }
  updateSendButtonUI();

  // force buttons to rebuild to reflect toggles immediately
  try { renderAllIncremental(); } catch {}
}

async function refreshAdminStatus(){
  const r = await api({event:'GET_CONFIG'});
  if (r && r.accessToken) {
    TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
  }
  const adminFlag = r && (r.config && (truthy(r.config.IS_ADMIN) || truthy(r.config.is_admin)));
  if (adminFlag) localStorage.setItem('twikoo_is_admin','1'); else localStorage.removeItem('twikoo_is_admin');
  const cached = (localStorage.getItem('twikoo_is_admin') === '1') && !!TK_TOKEN;
  isAdmin = !!(adminFlag || cached);

  allowReplies = !!(r && r.config && String(r.config.ALLOW_REPLIES).toLowerCase() !== 'false');
  allowPosts   = !!(r && r.config && String(r.config.ALLOW_POSTS).toLowerCase() !== 'false');
  updateAdminUI();
  bindAdminTogglesOnce();
}

async function checkConnection(){
  try{
    await api({event:"GET_FUNC_VERSION"});
    if (connEl){ connEl.textContent = "Status: Online"; connEl.classList.remove("bad"); connEl.classList.add("ok"); }
    setStatus('');
    return true;
  }catch{
    if (connEl) { connEl.textContent = "Status: Offline"; connEl.classList.remove("ok"); connEl.classList.add("bad"); }
    setStatus('Connection error', true);
    return false;
  }
}

/* ===== Admin toggles (bind once) ===== */
function bindAdminTogglesOnce(){
  if (toggleRepliesEl && !toggleRepliesEl.dataset.bound) {
    toggleRepliesEl.dataset.bound = '1';
    toggleRepliesEl.addEventListener('change', async (e) => {
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const want = !!e.target.checked;
      allowReplies = want; updateAdminUI();
      e.target.disabled = true;
      try{
        const r = await api({ event: 'SET_CONFIG_FOR_ADMIN', set: { allowReplies: want } });
        allowReplies = String(r?.config?.ALLOW_REPLIES ?? 'true').toLowerCase() !== 'false';
      }catch(err){
        setStatus(err?.message || 'Failed to update replies setting', true);
        allowReplies = !want; e.target.checked = !!allowReplies;
      }finally{
        e.target.disabled = false; updateAdminUI();
      }
    });
  }
  if (togglePostsEl && !togglePostsEl.dataset.bound) {
    togglePostsEl.dataset.bound = '1';
    togglePostsEl.addEventListener('change', async (e) => {
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const onlyAdmin = !!e.target.checked; // checked = only admin can post
      allowPosts = !onlyAdmin; updateAdminUI();
      e.target.disabled = true;
      try{
        const r = await api({ event: 'SET_CONFIG_FOR_ADMIN', set: { allowPosts: !onlyAdmin } });
        allowPosts = String(r?.config?.ALLOW_POSTS ?? 'true').toLowerCase() !== 'false';
      }catch(err){
        setStatus(err?.message || 'Failed to update posting setting', true);
        allowPosts = !allowPosts; e.target.checked = !allowPosts;
      }finally{
        e.target.disabled = false; updateAdminUI();
      }
    });
  }
}

/* ===== Content rendering helpers ===== */
function renderSafeContent(input, opts = {}){
  const allowLinks = !!opts.allowLinks;
  const allowEmbeds = !!opts.allowEmbeds;
  const text = String(input ?? "");

  const tpl = document.createElement('template');
  tpl.innerHTML = text.replace(/\n/g, '<br>');

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';

  let textSpan = null;
  const flushTextSpan = () => {
    if (textSpan && textSpan.childNodes.length) {
      wrap.appendChild(textSpan);
    }
    textSpan = null;
  };
  const ensureTextSpan = () => {
    if (!textSpan) {
      textSpan = document.createElement('span');
      textSpan.className = 'glow-target';
      textSpan.style.whiteSpace = 'pre-wrap';
    }
    return textSpan;
  };
  const pushText = (s) => {
    const span = ensureTextSpan();
    span.appendChild(document.createTextNode(s || ''));
  };

  const isHttp = (u)=> /^https?:\/\//i.test(u||'');
  const isDirectVideo = (u)=> /\.(mp4|webm|ogg)(\?.*)?$/i.test(u||'');

  Array.from(tpl.content.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') { ensureTextSpan().appendChild(document.createElement('br')); return; }

      if (tag === 'img') {
        flushTextSpan();
        const src = node.getAttribute('src') || '';
        if (/^data:image\/.+|^https?:\/\//i.test(src)) {
          const img = document.createElement('img');
          img.src = src; img.alt = node.getAttribute('alt') || '';
          img.loading = 'lazy'; img.decoding = 'async';
          wrap.appendChild(img);
        } else {
          pushText('[blocked image]'); flushTextSpan();
        }
        return;
      }

      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const txt = node.textContent || href;
        if (allowLinks && isHttp(href)) {
          const a = document.createElement('a');
          a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.textContent = txt;
          flushTextSpan(); wrap.appendChild(a);
        } else {
          pushText(txt);
        }
        return;
      }

      if (allowEmbeds && tag === 'iframe') {
        flushTextSpan();
        const hasSrcdoc = node.hasAttribute('srcdoc');
        const src = node.getAttribute('src') || '';
        if (hasSrcdoc || isHttp(src)) {
          const f = document.createElement('iframe');
          if (hasSrcdoc) f.setAttribute('srcdoc', node.getAttribute('srcdoc') || ''); else f.src = src;
          f.loading = 'lazy'; f.referrerPolicy = 'no-referrer'; f.title = node.getAttribute('title') || 'Embedded content';
          f.width = node.getAttribute('width') || '560'; f.height = node.getAttribute('height') || '315';
          f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          wrap.appendChild(f);
        } else {
          pushText('[blocked iframe]'); flushTextSpan();
        }
        return;
      }

      if (allowEmbeds && tag === 'video') {
        flushTextSpan();
        const src = node.getAttribute('src') || '';
        if (isHttp(src) && isDirectVideo(src)) {
          const v = document.createElement('video');
          v.src = src; v.controls = true; v.preload = 'metadata'; v.style.maxWidth = '480px';
          wrap.appendChild(v);
        } else {
          pushText('[blocked video]'); flushTextSpan();
        }
        return;
      }

      // Fallback unknown elements -> plain text
      pushText(node.textContent || '');
    }
  });

  flushTextSpan();
  return wrap;
}

/* Glow overlay that sits on .glow-target text only */
function createGlowOverlayOn(targetEl){
  if (!targetEl) return null;
  const prev = targetEl.querySelector(':scope > .glow-overlay');
  if (prev) prev.remove();
  const txt = targetEl.textContent || '';
  if (!txt.trim()) return null;
  const ov = document.createElement('span');
  ov.className = 'glow-overlay';
  ov.textContent = txt;
  targetEl.appendChild(ov);
  ov.style.setProperty('--glow-ol-opacity', '1');
  return ov;
}
function applyOverlayGlowOnce(bodyEl){
  const targets = bodyEl.querySelectorAll('.glow-target');
  const list = targets.length ? [...targets] : [bodyEl];
  list.forEach((tgt)=>{
    const ov = createGlowOverlayOn(tgt);
    if (!ov) return;
    setTimeout(()=> { ov.style.setProperty('--glow-ol-opacity', '0'); }, 2000);
    setTimeout(()=> { ov.remove(); }, 3500);
  });
}
function applyOverlayGlowRemainder(bodyEl, c){
  const targets = bodyEl.querySelectorAll('.glow-target');
  const list = targets.length ? [...targets] : [bodyEl];
  const created = Number(c?.created || Date.now());
  const elapsed = Math.max(0, (Date.now() - created) / 1000);
  let remain = Math.max(0, 2 - elapsed);
  list.forEach((tgt)=>{
    const ov = createGlowOverlayOn(tgt);
    if (!ov) return;
    if (remain <= 0){
      ov.style.setProperty('--glow-ol-opacity', '0');
      setTimeout(()=> ov.remove(), 400);
    } else {
      setTimeout(()=> { ov.style.setProperty('--glow-ol-opacity', '0'); }, Math.round(remain * 1000));
      setTimeout(()=> { ov.remove(); }, Math.round(remain * 1000) + 1500);
    }
  });
}

/* ===== Build actions (reply/pin/lock/delete/reorder) ===== */
function buildActionsFor(c){
  const actions = document.createElement("div");
  actions.className = "actions";

  const cid = c._id || c.id;
  const rootIdForLock = (c.rid && c.rid !== "") ? c.rid : cid;
  const rootForLock = state.all.get(rootIdForLock);
  const threadLocked = !!(rootForLock && rootForLock.locked);

  if ((allowReplies || isAdmin) && !threadLocked) {
    const replyBtn = document.createElement("span");
    replyBtn.className = "action";
    replyBtn.dataset.action = "reply";
    replyBtn.textContent = "↩ Reply";
    actions.appendChild(replyBtn);
  }

  const count = c.children?.length || 0;
  if ((c.rid || "") === "" && count > 0) {
    const toggleBtn = document.createElement("span");
    toggleBtn.className = "action";
    toggleBtn.dataset.action = "toggleReplies";
    toggleBtn.dataset.parent = cid;
    toggleBtn.textContent = (expanded.has(cid)
      ? (count === 1 ? "Close Reply" : "Close Replies")
      : (count === 1 ? "Show Reply" : "Show Replies"));
    actions.appendChild(toggleBtn);
  }

  if (isAdmin) {
    const delBtn = document.createElement("span");
    delBtn.className = "action";
    delBtn.dataset.action = "adminDel";
    delBtn.dataset.cid = cid;
    delBtn.textContent = "Delete";
    actions.appendChild(delBtn);

    if ((c.rid || "") === "") {
      const pinBtn = document.createElement("span");
      pinBtn.className = "action";
      pinBtn.dataset.action = "adminPin";
      pinBtn.dataset.cid = cid;
      pinBtn.textContent = Number(c.top) === 1 ? "Unpin" : "Pin";
      actions.appendChild(pinBtn);

      // Reorder when pinned
      if (Number(c.top) === 1) {
        const upBtn = document.createElement("span");
        upBtn.className = "action";
        upBtn.dataset.action = "pinUp";
        upBtn.dataset.cid = cid;
        upBtn.textContent = "Pin ↑";
        actions.appendChild(upBtn);

        const downBtn = document.createElement("span");
        downBtn.className = "action";
        downBtn.dataset.action = "pinDown";
        downBtn.dataset.cid = cid;
        downBtn.textContent = "Pin ↓";
        actions.appendChild(downBtn);
      }

      const lockBtn = document.createElement("span");
      lockBtn.className = "action";
      lockBtn.dataset.action = "adminLock";
      lockBtn.dataset.cid = cid;
      lockBtn.textContent = threadLocked ? "Unlock Replies" : "Lock Replies";
      actions.appendChild(lockBtn);
    }
  }

  return actions;
}

/* ===== Pin order helpers ===== */
async function sendPinOrder(orderIds){
  try{
    await api({ event: 'COMMENT_REORDER_PINS_FOR_ADMIN', url: PAGE_URL_PATH, order: orderIds });
    await loadLatest(true);
  }catch(e){
    setStatus(e?.message || 'Failed to reorder pins', true);
  }
}
function currentPinnedOrder(){
  const order = [];
  if (!messagesEl) return order;
  messagesEl.querySelectorAll('.msg[data-root="1"][data-top="1"]').forEach(el=>{
    const id = el.getAttribute('data-id');
    if (id) order.push(id);
  });
  return order;
}
function movePinned(id, dir){
  const order = currentPinnedOrder();
  const i = order.indexOf(id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= order.length) return;
  const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  return sendPinOrder(order);
}

/* ===== Rendering ===== */
function renderMsg(c){
  const cid = c._id || c.id;
  const el = document.createElement('div');
  el.className = 'msg';
  el.setAttribute('data-id', cid);
  el.setAttribute('data-root', ((c.rid || '') === '') ? '1' : '0');
  el.setAttribute('data-top', Number(c.top) === 1 ? '1' : '0');

  const avatar = document.createElement('div');
  avatar.className = 'avatar' + (authorIsAdmin(c) ? ' admin' : '');
  avatar.textContent = initialOf(c.nick);
  el.appendChild(avatar);

  const bubble = document.createElement('div'); bubble.className='bubble';
  const meta = document.createElement('div'); meta.className='meta';
  const nick = document.createElement('span'); nick.className='nick' + (authorIsAdmin(c) ? ' admin-glow' : '');
  nick.textContent = c.nick || 'Anonymous';
  meta.appendChild(nick);
  const time = document.createElement('span'); time.textContent = new Date(c.created || Date.now()).toLocaleString();
  meta.appendChild(time);
  bubble.appendChild(meta);

  const contentWrap = document.createElement('div'); contentWrap.className='content';
  const allowEmb = !!isAdmin;
  const allowLnk = !!isAdmin;
  const body = renderSafeContent(c.content || c.comment || '', { allowEmbeds: allowEmb, allowLinks: allowLnk });
  contentWrap.appendChild(body);
  bubble.appendChild(contentWrap);

  if (authorIsAdmin(c)) {
    if ((Date.now() - (c.created||0)) <= 5000) {
      applyOverlayGlowRemainder(body, c);
    }
  }

  const repliesBox = document.createElement('div'); repliesBox.className='replies'; repliesBox.id = `replies-${cid}`;
  if (c.children && c.children.length && expanded.has(cid)) {
    c.children.forEach(ch => repliesBox.appendChild(renderMsg(ch)));
    repliesBox.style.display = 'flex';
  } else {
    repliesBox.style.display = 'none';
  }

  const actions = buildActionsFor(c);
  bubble.appendChild(actions);
  if ((c.rid || '') === '') bubble.appendChild(repliesBox);
  el.appendChild(bubble);
  return el;
}

function renderAllIncremental(){
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  const roots = [];
  for (const v of state.all.values()) if ((v.rid||'')==='') roots.push(v);
  const pinned = roots.filter(r=>Number(r.top)===1);
  const others = roots.filter(r=>Number(r.top)!==1).sort((a,b)=>(b.created||0)-(a.created||0));
  for (const r of [...pinned, ...others]) {
    messagesEl.appendChild(renderMsg(r));
  }
}

function mergeList(list){
  const temp = new Map();
  (Array.isArray(list)?list:[]).forEach(src=>{
    const id = src._id || src.id; if (!id) return;
    temp.set(id, {
      ...src,
      _id: id, id,
      pid: src.pid || "", rid: src.rid || "",
      created: src.created || Date.now(),
      nick: src.nick || "Anonymous",
      avatar: src.avatar || "",
      comment: src.comment || src.content || "",
      top: Number(src.top ? 1 : 0),
      locked: !!src.locked,
      children: []
    });
  });
  for (const o of temp.values()){
    if ((o.rid||'')!=='') {
      const root = temp.get(o.rid);
      if (root) root.children.push(o);
    }
  }
  for (const root of temp.values()){
    if ((root.rid||'')==='' && root.children.length) {
      root.children.sort((a,b)=>(a.created||0)-(b.created||0));
    }
  }
  state.all = temp;
}

async function loadLatest(force=false){
  if (loading && !force) return;
  loading = true;
  try{
    const r = await api({ event:'COMMENT_GET', url: PAGE_URL_PATH, page: 1, pageSize: 200 });
    const data = r?.data || {};
    serverCounts = data.counts || null;
    mergeList(data.comments || []);
    renderAllIncremental();
  }catch(e){
    setStatus(e?.message || 'Load failed', true);
  }finally{
    loading = false;
  }
}

/* ===== Textarea helpers ===== */
function insertAtCursor(el, text){
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  el.selectionStart = el.selectionEnd = pos;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ===== Send / attach / embed ===== */
function countImgsInHTML(html){ return (String(html||'').match(/<img\b[^>]*>/gi) || []).length; }
function updateAttachAvailability(){
  if (!btnAttach) return;
  if (isAdmin){ btnAttach.disabled = false; return; }
  const n = countImgsInHTML(textEl.value);
  btnAttach.disabled = n >= 1;
}

/* NEW: react when a file is chosen */
if (fileEl){
  // Fallback in case the label's for= doesn't trigger click in some browsers
  const btnChoose = $("btnChoose");
  if (btnChoose && !btnChoose.dataset.bound){
    btnChoose.dataset.bound = '1';
    btnChoose.addEventListener('click', (e)=>{ if (fileEl) fileEl.click(); });
  }

  fileEl.addEventListener('change', ()=>{
    const f = fileEl.files && fileEl.files[0];
    if (!f){
      if (fileInfo) fileInfo.textContent = "";
      return;
    }
    const mb = (f.size/(1024*1024)).toFixed(2);
    if (fileInfo) fileInfo.textContent = `${f.name} — ${mb} MB`;
    if (!/^image\//i.test(f.type)){
      setStatus('Not an image', true);
      return;
    }
    if (f.size > MAX_FILE_MB*1024*1024){
      setStatus(`Image too large (>${MAX_FILE_MB}MB)`, true);
      return;
    }
    setStatus('Ready to attach');
  });
}

async function doSend(){
  const nick = (nickEl?.value || '').trim().slice(0,10) || 'Anonymous';
  let content = (textEl?.value || '').trim();
  if (!content) return setStatus('Nothing to send', true);

  if (!isAdmin && countImgsInHTML(content) > 1) {
    return setStatus('Only one image allowed per message', true);
  }

  const payload = { event:'COMMENT_CREATE', url: PAGE_URL_PATH, nick, content };
  if (replyTarget && replyTarget.rid) {
    payload.pid = replyTarget.pid;
    payload.rid = replyTarget.rid;
  }

  setStatus('Sending…');
  const res = await api(payload);
  if (res?.code === 0) {
    textEl.value = '';
    updateAttachAvailability();
    setStatus('Sent');
    if (isAdmin && sendAutoPinEl && sendAutoPinEl.checked && res?.data?.id) {
      try { await api({ event:'COMMENT_SET_FOR_ADMIN', id: res.data.id, url: PAGE_URL_PATH, set:{ top: true } }); } catch {}
    }
  } else {
    setStatus(res?.message || 'Send failed', true);
  }
}

async function doAttach(){
  const f = fileEl?.files?.[0];
  if (!f) { setStatus('No file selected', true); return; }
  if (!/^image\//i.test(f.type)) return setStatus('Not an image', true);
  const sizeMb = f.size / (1024*1024);
  if (sizeMb > MAX_FILE_MB) return setStatus(`Image too large (>${MAX_FILE_MB}MB)`, true);

  setStatus('Uploading…');
  const dataURL = await new Promise((res,rej)=>{ const fr = new FileReader(); fr.onerror=()=>rej(fr.error); fr.onload=()=>res(fr.result); fr.readAsDataURL(f); });
  const r = await api({ event:'UPLOAD_IMAGE', photo: String(dataURL) });
  if (r?.code === 0 && r?.data?.url) {
    const tag = `<img src="${r.data.url}">`;
    insertAtCursor(textEl, (textEl.value ? '\n' : '') + tag);
    // clear selection so picking same file again still triggers change
    fileEl.value = '';
    if (fileInfo) fileInfo.textContent = '';
    updateAttachAvailability();
    setStatus('Image attached');
  } else {
    setStatus(r?.message || 'Upload failed', true);
  }
}

/* NEW: inline embed UI */
function setEmbedModeUI(){
  if (!embedModeEl) return;
  const m = embedModeEl.value;
  if (embedUrlEl)  embedUrlEl.style.display  = (m === 'url')  ? 'block' : 'none';
  if (embedHtmlEl) embedHtmlEl.style.display = (m === 'html') ? 'block' : 'none';
}
if (embedModeEl && !embedModeEl.dataset.bound){
  embedModeEl.dataset.bound = '1';
  embedModeEl.addEventListener('change', setEmbedModeUI);
  setEmbedModeUI();
}
if (btnEmbedInsert && !btnEmbedInsert.dataset.bound){
  btnEmbedInsert.dataset.bound = '1';
  btnEmbedInsert.addEventListener('click', ()=>{
    if (!isAdmin) { setStatus('Embed is admin-only', true); return; }
    const mode = embedModeEl ? embedModeEl.value : 'url';
    let snippet = '';
    if (mode === 'url') {
      const u = (embedUrlEl?.value || '').trim();
      if (!/^https?:\/\//i.test(u)) { setStatus('Enter a valid URL (http/https)', true); return; }
      snippet =
        `<iframe src="${u}" width="560" height="315" ` +
        `sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" title="Embedded content"></iframe>`;
    } else {
      const raw = embedHtmlEl?.value || '';
      const esc = raw.replace(/<\/(script)/gi, '&lt;/$1'); // basic guard
      snippet =
        `<iframe srcdoc="${esc.replace(/"/g,'&quot;')}" width="560" height="315" ` +
        `sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" title="Embedded HTML"></iframe>`;
    }
    insertAtCursor(textEl, (textEl.value ? '\n' : '') + snippet + '\n');
    setStatus('Embed inserted');
  });
}

/* ===== Events ===== */
if (btnAdminLogin) btnAdminLogin.addEventListener('click', async ()=>{
  const password = adminPass.value || '';
  if (!password) return setStatus("Enter password", true);
  setStatus('Logging in…');
  const r = await api({ event:'LOGIN', password });
  if (r?.accessToken) {
    TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
    await refreshAdminStatus(); await loadLatest(true);
    setStatus('Logged in');
  } else {
    setStatus(r?.message || 'Login failed', true);
  }
});
if (btnAdminLogout) btnAdminLogout.addEventListener('click', ()=>{
  localStorage.removeItem('twikoo_access_token');
  localStorage.removeItem('twikoo_is_admin');
  TK_TOKEN = null; isAdmin = false;
  refreshAdminStatus();
});

if (btnSend) btnSend.addEventListener('click', doSend);
if (btnAttach) btnAttach.addEventListener('click', doAttach);
if (textEl) textEl.addEventListener('input', ()=>{
  const n = (textEl.value||'').length;
  if (charCount) charCount.textContent = String(n);
  updateAttachAvailability();
});

if (replyCancel) replyCancel.addEventListener('click', ()=>{
  replyTarget = null;
  replyTo.style.display='none';
  updateAdminUI();
});

if (messagesEl) messagesEl.addEventListener('click', async (e)=>{
  const t = e.target.closest('.action'); if (!t) return;
  const act = t.dataset.action;

  if (act === 'reply') {
    const msg = t.closest('.msg'); if (!msg) return;
    const id = msg.getAttribute('data-id'); const root = msg.getAttribute('data-root') === '1';
    const c = state.all.get(id); if (!c) return;
    replyTarget = root ? { pid: c.id, rid: c.id, nick: c.nick } : { pid: c.pid, rid: c.rid, nick: c.nick };
    replyName.textContent = replyTarget.nick || 'Anonymous';
    replyTo.style.display='flex';
    updateAdminUI();
    return;
  }

  if (act === 'toggleReplies') {
    const parent = t.dataset.parent;
    if (expanded.has(parent)) expanded.delete(parent); else expanded.add(parent);
    renderAllIncremental();
    return;
  }

  if (act === 'adminPin') {
    if (!isAdmin) return;
    const cid = t.dataset.cid; if (!cid) return;
    const root = state.all.get(cid); if (!root) return;
    const want = !(Number(root.top)===1);
    if (!armConfirmButton(t, want ? 'Pin this?' : 'Unpin this?')) return;
    await api({ event:'COMMENT_SET_FOR_ADMIN', id: cid, url: PAGE_URL_PATH, set:{ top: want } });
    return;
  }

  if (act === 'adminLock') {
    if (!isAdmin) return;
    const cid = t.dataset.cid; if (!cid) return;
    const root = state.all.get(cid); if (!root) return;
    const locked = !!root.locked;
    if (!armConfirmButton(t, locked ? 'Unlock replies?' : 'Lock replies?')) return;
    await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id: cid, url: PAGE_URL_PATH, lock: !locked });
    return;
  }

  if (act === 'adminDel') {
    if (!isAdmin) return;
    const cid = t.dataset.cid; if (!cid) return;
    if (!armConfirmButton(t, 'Delete this?')) return;
    await api({ event:'COMMENT_DELETE_FOR_ADMIN', id: cid, url: PAGE_URL_PATH });
    return;
  }

  if (act === 'pinUp')   { const id = t.dataset.cid; if (id) movePinned(id, -1); return; }
  if (act === 'pinDown') { const id = t.dataset.cid; if (id) movePinned(id, +1); return; }
});

/* ===== Startup ===== */
document.addEventListener('DOMContentLoaded', async () => {
  try { connectWS(); } catch {}
  try { await checkConnection(); } catch {}
  try { await refreshAdminStatus(); } catch {}
  try { await loadLatest(true); } catch {}
  try { updateAttachAvailability(); } catch {}
});