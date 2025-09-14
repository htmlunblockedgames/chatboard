/* Poly Track Chatboard – index.js */
console.log("chatboard.index.js v27");

const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 7;
const MAX_CHARS     = 2000;

/* Global shimmer driver – keeps phase stable across re-renders */
(function startGlobalShimmer(){
  const durMs = 3200; // 3.2s loop
  let start = performance.now();
  const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * 2 * t);
  function tick(){
    const now = performance.now();
    const raw = ((now - start) % durMs) / durMs;
    const eased = easeInOut(raw);
    const pos = Math.round(eased * 200); // 0%..200%
    document.documentElement.style.setProperty('--shimmer-x', pos + '%');
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

/* Live updates via WebSocket */
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
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data === 'pong') return;
        const doRefresh = async () => {
          try { await refreshAdminStatus(); } catch {}
          try { await loadLatest(true); } catch {}   // <-- pass isRealtime=true for WS pushes
        };
        try {
          const msg = JSON.parse(e.data);
          if (msg && msg.type === "refresh") doRefresh();
        } catch {
          doRefresh();
        }
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

/* DOM refs */
const $=id=>document.getElementById(id);
const messagesEl=$("messages"), loadMoreBtn=$("loadMore");
const nickEl=$("nick"), textEl=$("text");
const fileEl=$("file"), btnAttach=$("btnAttach"), btnEmbed=$("btnEmbed"), btnSend=$("btnSend");
const fileInfo=$("fileInfo"), statusEl=$("status"), connEl=$("conn");

const adminPanel=$("adminPanel"), adminPass=$("adminPass"), btnAdminLogin=$("btnAdminLogin"),
      btnAdminLogout=$("btnAdminLogout"), adminLoginRow=$("adminLoginRow"),
      adminControls=$("adminControls"), pinCountEl=$("pinCount"), adminNote=$("adminNote");
const statTotalEl=$("statTotal"), statRepliesEl=$("statReplies"), statTodayEl=$("statToday");
const toggleRepliesEl=$("toggleReplies");
const togglePostsEl=$("togglePosts");
/* Admin-only composer options */
const optNoReplyEl=$("optNoReply"), sendNoReplyEl=$("sendNoReply"),
      optAutoPinEl=$("optAutoPin"), sendAutoPinEl=$("sendAutoPin");

const limitMbEl=$("limitMb"), limitChars=$("limitChars"), limitChars2=$("limitChars2"), charCount=$("charCount");
const replyTo=$("replyTo"), replyName=$("replyName"), replyCancel=$("replyCancel");

/* Show admin panel ONLY at https://htmlunblockedgames.github.io/chatboard/?admin=1 */
const SHOW_ADMIN_PANEL =
  window.location.hostname === "htmlunblockedgames.github.io" &&
  window.location.pathname === "/chatboard/" &&
  new URLSearchParams(window.location.search).get("admin") === "1";
if (adminPanel) adminPanel.style.display = SHOW_ADMIN_PANEL ? "grid" : "none";

/* State */
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
const devAnimStartAt = new Map();
let allowReplies = true; // global toggle
let allowPosts = true;   // when false, only admin may post

/* UI helpers */
limitMbEl.textContent=MAX_FILE_MB;
limitChars.textContent=MAX_CHARS;
limitChars2.textContent=MAX_CHARS;

const initialOf = s => (s||"A").trim().charAt(0).toUpperCase();
const setStatus=(t,isError=false)=>{
  if(!t){ statusEl.style.display="none"; statusEl.textContent=""; return; }
  statusEl.style.display="inline"; statusEl.textContent=t;
  statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
};

// Inline two-step confirmation for admin actions
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

function fileToDataURL(file){ return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onerror=()=>rej(fr.error||new Error("FileReader error")); fr.onload=()=>res(fr.result); fr.readAsDataURL(file); }); }
function insertAtCursor(el,text){ const s=el.selectionStart??el.value.length, e=el.selectionEnd??el.value.length; el.value=el.value.slice(0,s)+text+el.value.slice(e); const pos=s+text.length; el.setSelectionRange(pos,pos); el.focus(); }
function truthy(v){ return v === true || v === 1 || v === '1' || v === 'true'; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseRetryAfter(h){
  if (!h) return 0;
  const n = Number(h);
  if (!Number.isNaN(n)) return Date.now() + n*1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? 0 : d;
}
function authorIsAdmin(c){ return String((c && c.nick) || '') === 'Poly Track Administrator'; }

/* Build actions toolbar (reused for fresh & existing nodes) */
function buildActionsFor(c){
  const actions = document.createElement("div");
  actions.className = "actions";

  const cid = c._id || c.id;
  const rootIdForLock = (c.rid && c.rid !== "") ? c.rid : cid;
  const rootForLock = state.all.get(rootIdForLock);
  const threadLocked = !!(rootForLock && rootForLock.locked);

  // Reply (global replies or admin, and thread not locked)
  if ((allowReplies || isAdmin) && !threadLocked) {
    const replyBtn = document.createElement("span");
    replyBtn.className = "action";
    replyBtn.dataset.action = "reply";
    replyBtn.textContent = "↩ Reply";
    actions.appendChild(replyBtn);
  }

  // Show/Close replies toggle (roots with children)
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

  // Admin controls
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

/* Render-safe content:
   - Everyone: images
   - Links & embeds: admin only (includes general iframes and srcdoc) */
function renderSafeContent(input, opts = {}){
  const allowLinks = !!opts.allowLinks;
  const allowEmbeds = !!opts.allowEmbeds;
  const text = String(input ?? "");
  const tpl = document.createElement('template');
  tpl.innerHTML = text.replace(/\n/g, '<br>');
  const frag = document.createDocumentFragment();
  const pushText = s => frag.appendChild(document.createTextNode(s || ''));
  const isHttp = (u)=> /^https?:\/\//i.test(u||'');
  const isDirectVideo = (u)=> /\.(mp4|webm|ogg)(\?.*)?$/i.test(u||'');

  Array.from(tpl.content.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) return pushText(node.textContent);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') return frag.appendChild(document.createElement('br'));

      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        if (/^data:image\/.+|^https?:\/\//i.test(src)) {
          const img = document.createElement('img');
          img.src = src; img.alt = node.getAttribute('alt') || '';
          img.loading = 'lazy'; img.decoding = 'async';
          return frag.appendChild(img);
        }
        return pushText('[blocked image]');
      }

      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (allowLinks && isHttp(href)) {
          const a = document.createElement('a');
          a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
          a.textContent = node.textContent || href;
          return frag.appendChild(a);
        }
        return pushText(node.textContent || href);
      }

      if (allowEmbeds && tag === 'iframe') {
        const hasSrcdoc = node.hasAttribute('srcdoc');
        const src = node.getAttribute('src') || '';
        if (hasSrcdoc || isHttp(src)) {
          const f = document.createElement('iframe');
          if (hasSrcdoc) {
            f.setAttribute('srcdoc', node.getAttribute('srcdoc') || '');
          } else {
            f.src = src;
          }
          f.loading = 'lazy';
          f.referrerPolicy = 'no-referrer';
          f.title = node.getAttribute('title') || 'Embedded content';
          f.width = node.getAttribute('width') || '560';
          f.height = node.getAttribute('height') || '315';
          f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          return frag.appendChild(f);
        }
        return pushText('[blocked iframe]');
      }

      if (allowEmbeds && tag === 'video') {
        const src = node.getAttribute('src') || '';
        if (isHttp(src) && isDirectVideo(src)) {
          const v = document.createElement('video');
          v.src = src; v.controls = true; v.preload = 'metadata'; v.style.maxWidth = '480px';
          return frag.appendChild(v);
        }
        return pushText('[blocked video]');
      }

      return pushText(node.textContent || '');
    }
  });
  const wrap = document.createElement('div'); wrap.appendChild(frag); return wrap;
}

/* API */
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
      const json = await res.json().catch(()=>({}));
      if (body.event === 'LOGIN' && json?.accessToken) {
        TK_TOKEN = json.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }
      if (body.event === 'GET_CONFIG' && json?.accessToken) {
        TK_TOKEN = json.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }
      return json;
    }catch(e){
      lastErr=e;
      if (attempt<maxAttempts){ await sleep(500*Math.pow(2,attempt-1)+Math.random()*200); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("Request failed");
}

/* Admin UI + toggles */
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

  // Show admin panel whenever signed in (even without ?admin=1)
  if (adminPanel) {
    adminPanel.style.display = (SHOW_ADMIN_PANEL || isAdmin) ? 'grid' : 'none';
  }
  // Hide the nickname input row when admin is composing
  if (nickEl && nickEl.parentElement) {
    nickEl.parentElement.style.display = isAdmin ? 'none' : 'flex';
  }

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

  // Admin-only composer controls (root only)
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
  if (btnEmbed) {
    btnEmbed.style.display = isAdmin ? 'inline-flex' : 'none';
  }

  if (!allowReplies) {
    replyTarget = null;
    replyTo.style.display = 'none';
  }
  updateSendButtonUI();
}

async function refreshAdminStatus(){
  const r = await api({event:'GET_CONFIG'});
  if (r && r.accessToken) {
    TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
  }
  const adminFlag = r && (truthy(r.isAdmin) || truthy(r.admin) ||
                          (r.data && (truthy(r.data.isAdmin) || truthy(r.data.admin))) ||
                          (r.config && (truthy(r.config.IS_ADMIN) || truthy(r.config.is_admin))));
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

/* One-time binder for admin toggles */
function bindAdminTogglesOnce(){
  if (toggleRepliesEl && !toggleRepliesEl.dataset.bound) {
    toggleRepliesEl.dataset.bound = '1';
    toggleRepliesEl.addEventListener('change', async (e) => {
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const want = !!e.target.checked;

      // Optimistic real-time
      allowReplies = want;
      updateAdminUI();
      renderAllIncremental();

      e.target.disabled = true;
      try{
        const r = await api({ event: 'SET_CONFIG_FOR_ADMIN', set: { allowReplies: want } });
        allowReplies = String(r?.config?.ALLOW_REPLIES ?? 'true').toLowerCase() !== 'false';
      }catch(err){
        setStatus(err?.message || 'Failed to update replies setting', true);
        allowReplies = !want;
        e.target.checked = !!allowReplies;
      }finally{
        e.target.disabled = false;
        updateAdminUI();
        renderAllIncremental();
      }
    });
  }
  if (togglePostsEl && !togglePostsEl.dataset.bound) {
    togglePostsEl.dataset.bound = '1';
    togglePostsEl.addEventListener('change', async (e) => {
      if (!isAdmin) { e.preventDefault(); updateAdminUI(); return; }
      const onlyAdmin = !!e.target.checked; // checked = only admin can post

      // Optimistic
      allowPosts = !onlyAdmin;
      updateAdminUI();
      renderAllIncremental();

      e.target.disabled = true;
      try{
        const r = await api({ event: 'SET_CONFIG_FOR_ADMIN', set: { allowPosts: !onlyAdmin } });
        allowPosts = String(r?.config?.ALLOW_POSTS ?? 'true').toLowerCase() !== 'false';
      }catch(err){
        setStatus(err?.message || 'Failed to update posting setting', true);
        allowPosts = !allowPosts;
        e.target.checked = !allowPosts;
      }finally{
        e.target.disabled = false;
        updateAdminUI();
        renderAllIncremental();
      }
    });
  }
}

/* Merge, compute nesting, preserve server root order; track reply counts */
function mergeList(list){
  const temp = new Map();
  const pushItem = (src) => {
    const id = src._id || src.id; if (!id) return;
    temp.set(id, {
      ...src,
      _id: id, id,
      pid: src.pid || "", rid: src.rid || "",
      created: src.created || Date.now(),
      nick: src.nick || "Anonymous",
      avatar: src.avatar || "",
      comment: src.comment || src.content || "",
      depth: 0, parentNick: null, children: [],
      top: Number(src.top ? 1 : 0),
      locked: !!src.locked
    });
  };
  (Array.isArray(list) ? list : []).forEach(pushItem);

  // derive depth/parent + children
  for (const obj of temp.values()){
    if ((obj.rid || "") === "") { obj.depth = 0; obj.parentNick = null; continue; }
    let depth = 1, p = temp.get(obj.pid), seen=new Set([obj._id]);
    while (p && (p.rid || "") !== "") { if (seen.has(p._id)) break; seen.add(p._id); depth++; p = temp.get(p.pid); }
    obj.depth = depth; obj.parentNick = (temp.get(obj.pid)?.nick) || obj.ruser || null;
    let root = obj; while (root && (root.rid || "") !== "") root = temp.get(root.pid); if (root) obj.rid = root._id;
  }
  for (const o of temp.values()) o.children = [];
  for (const o of temp.values()){
    if ((o.rid || "") !== "") { const root=temp.get(o.rid); if (root) root.children.push(o); }
  }
  for (const root of temp.values()){ if (root.children?.length) root.children.sort((a,b)=>(a.created||0)-(b.created||0)); }

  state.all = temp;

  // Preserve server-provided root order
  const rootsInOrder = [];
  const seen = new Set();
  for (const item of (Array.isArray(list)?list:[])) {
    const id = item._id || item.id;
    const obj = temp.get(id);
    if (obj && (obj.rid || "") === "" && !seen.has(id)) { rootsInOrder.push(obj); seen.add(id); }
  }
  if (!rootsInOrder.length) {
    for (const v of temp.values()) if ((v.rid || "") === "") rootsInOrder.push(v);
  }
  state.tops = rootsInOrder;
  state.rootOrder = rootsInOrder.map(x => x._id);
  earliestMainCreated = state.tops.length ? Math.min(...state.tops.map(x=>x.created||Date.now())) : null;
}

/* ===== Glow animation helpers (admin only) ===== */
function createGlowOverlay(bodyEl){
  if (!bodyEl) return null;
  const prev = bodyEl.querySelector('.glow-overlay');
  if (prev) prev.remove();
  const txt = bodyEl.textContent || '';
  if (!txt.trim()) return null;
  bodyEl.style.position = 'relative';

  const ov = document.createElement('span');
  ov.className = 'glow-overlay';
  ov.textContent = txt;
  bodyEl.appendChild(ov);
  ov.style.setProperty('--glow-ol-opacity', '1');
  return ov;
}
function applyOverlayGlowOnce(bodyEl){
  const ov = createGlowOverlay(bodyEl);
  if (!ov) return;
  const fadeTimer = setTimeout(()=> { ov.style.setProperty('--glow-ol-opacity', '0'); }, 2000);
  const cleanupTimer = setTimeout(()=> { ov.remove(); }, 2000 + 1500);
  ov.dataset.fadeTimer = String(fadeTimer);
  ov.dataset.cleanupTimer = String(cleanupTimer);
}
function applyOverlayGlowRemainder(bodyEl, c){
  const ov = createGlowOverlay(bodyEl);
  if (!ov) return;
  const created = Number(c?.created || Date.now());
  const elapsed = Math.max(0, (Date.now() - created) / 1000);
  let remain = Math.max(0, 2 - elapsed);
  if (remain <= 0){
    ov.style.setProperty('--glow-ol-opacity', '0');
  } else {
    setTimeout(()=> { ov.style.setProperty('--glow-ol-opacity', '0'); }, Math.round(remain * 1000));
  }
  setTimeout(()=> { ov.remove(); }, Math.round(remain * 1000) + 1500);
}

/* Render one message */
function renderMsg(c){
  const cid = c._id || c.id;
  const wrap=document.createElement("div"); wrap.className="msg"; wrap.dataset.cid=cid;
  const adminAuthor = authorIsAdmin(c);
  if (adminAuthor) wrap.classList.add("by-admin");

  const avatar=document.createElement("div"); avatar.className="avatar";
  if (adminAuthor){ avatar.classList.add("admin"); avatar.textContent = "</>"; }
  else if (c.avatar){ const img=new Image(); img.src=c.avatar; img.alt=c.nick||"avatar"; avatar.appendChild(img); }
  else { avatar.textContent = initialOf(c.nick); }

  if (adminAuthor) {
    const base = 3.2, jitter = (cid.charCodeAt(0)%10)/20;
    avatar.style.setProperty('--glow-avatar-dur', (base + jitter).toFixed(2) + 's');
  }

  const bubble=document.createElement("div"); bubble.className="bubble";
  const depth = Number(c.depth || 0); bubble.style.marginLeft = (depth * 20) + 'px';

  const meta=document.createElement("div"); meta.className="meta";
  const nick=document.createElement("span"); nick.className="nick"; nick.textContent=c.nick||"Anonymous";
  if (adminAuthor) nick.classList.add("admin-glow");
  const time=document.createElement("span"); time.textContent=new Date(c.created||Date.now()).toLocaleString();
  meta.append(nick,time);

  const content=document.createElement("div"); content.className="content";
  if (c.parentNick) {
    const replyToSpan = document.createElement('div');
    replyToSpan.style.fontSize='12px'; replyToSpan.style.color='var(--muted)';
    replyToSpan.textContent = `↪ Replying to ${c.parentNick}`;
    content.appendChild(replyToSpan);
  }
  const body = renderSafeContent(c.comment || "", { allowLinks: adminAuthor, allowEmbeds: adminAuthor });
  content.appendChild(body);

  if (adminAuthor) {
    const isPinnedRoot = Number(c.top) === 1 && ((c.rid || "") === "");
    if (isPinnedRoot) {
      const key = cid;
      if (!pinAnimPlayed.has(key)) {
        applyOverlayGlowOnce(body);
        pinAnimPlayed.add(key);
      }
    } else {
      const now = Date.now();
      const lastStart = devAnimStartAt.get(cid) || 0;
      if (now - lastStart >= 3000) {
        applyOverlayGlowRemainder(body, c);
        devAnimStartAt.set(cid, now);
      } else {
        applyOverlayGlowRemainder(body, c);
      }
    }
  }

  const actions = buildActionsFor(c);

  wrap.append(avatar,bubble);
  bubble.append(meta,content,actions);
  return wrap;
}

function buildReplies(container, root){
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const child of (root.children || [])){
    const node = renderMsg(child);
    frag.appendChild(node);
  }
  container.appendChild(frag);
}

/* ===== Incremental render to avoid killing in-flight animations ===== */
function renderAllIncremental(){
  const existing = new Map();
  messagesEl.querySelectorAll(':scope > .msg').forEach(n => existing.set(n.dataset.cid, n));

  const desired = state.tops.map(c => {
    let node = existing.get(c._id);
    if (!node) {
      node = renderMsg(c);
    } else {
      // Rebuild actions completely (updates reply visibility, lock/unlock, pin labels)
      const oldActions = node.querySelector(".actions");
      if (oldActions) {
        const fresh = buildActionsFor(c);
        oldActions.replaceWith(fresh);
      } else {
        const fresh = buildActionsFor(c);
        (node.querySelector(".bubble") || node).appendChild(fresh);
      }

      // Replies container
      let cont = node.querySelector('#replies-'+c._id);
      if (!cont) {
        cont = document.createElement('div');
        cont.className = 'replies';
        cont.id = 'replies-'+c._id;
        (node.querySelector('.bubble') || node).appendChild(cont);
      }
      const wantOpen = expanded.has(c._id);
      if (wantOpen) {
        const currentMsgs = cont.querySelectorAll(':scope > .msg').length;
        const needRebuild = currentMsgs !== (c.children?.length || 0);
        if (needRebuild) buildReplies(cont, c);
        cont.style.display = 'flex';
      } else {
        cont.style.display = 'none';
      }
    }
    return node;
  });

  const frag = document.createDocumentFragment();
  for (const n of desired) frag.appendChild(n);
  messagesEl.innerHTML = "";
  messagesEl.appendChild(frag);

  if (state.tops.length) { loadMoreBtn.style.display="inline-flex"; loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
  else { loadMoreBtn.style.display="none"; }

  updateAdminUI();
}

/* Loading */
async function loadLatest(isRealtime = false){
  if (loading) return;
  loading=true;
  try{
    const r = await api({ event: 'COMMENT_GET', url: PAGE_URL_PATH, page: 1, pageSize: 100 });
    const comments = r?.data?.comments || [];
    serverCounts = r?.data?.counts || null;
    mergeList(comments);

    // Auto-open only for in-session, real-time updates (not on initial reloads)
    const shouldAutoOpen = !!isRealtime && prevChildCounts.size > 0;
    if (shouldAutoOpen) {
      for (const root of state.tops) {
        const id = root._id || root.id;
        const count = root.children?.length || 0;
        const prev = prevChildCounts.get(id) || 0;
        if (count > prev) expanded.add(id);
      }
    }

    // Always refresh the snapshot
    for (const root of state.tops) {
      const id = root._id || root.id;
      prevChildCounts.set(id, root.children?.length || 0);
    }

    renderAllIncremental();
  }catch(e){
    setStatus(e?.message || 'Failed to load', true);
  }finally{
    loading=false;
  }
}

async function loadOlder(){
  if (loading) return;
  if (!earliestMainCreated) return;
  loading=true;
  loadMoreBtn.disabled=true; loadMoreBtn.textContent="Loading…";
  try{
    const r = await api({ event: 'COMMENT_GET', url: PAGE_URL_PATH, page: 1, pageSize: 100, before: earliestMainCreated });
    const list = r?.data?.comments || [];
    const prevAll = new Map(state.all);
    const prevTopsLen = state.tops.length;
    mergeList([...(list||[]), ...Array.from(prevAll.values())]);

    // Refresh reply-count snapshot (no auto-open on older loads)
    for (const root of state.tops) {
      const id = root._id || root.id;
      prevChildCounts.set(id, root.children?.length || 0);
    }

    renderAllIncremental();
    if (state.tops.length === prevTopsLen) loadMoreBtn.textContent="No more";
    else { loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
  }catch(e){
    setStatus(e?.message || 'Failed to load older', true);
    loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older";
  }finally{
    loading=false;
  }
}

/* Compose & send */
function sanitizeClient(content){
  let s = String(content || "");
  s = s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n"); // collapse blank lines
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS);
  return s;
}

async function sendMessage(){
  const raw = textEl.value;
  const content = sanitizeClient(raw).trim();
  if (!content) return;

  if (!isAdmin && !allowPosts) {
    updateSendButtonUI();
    return;
  }

  const wantNoReply = !!(isAdmin && sendNoReplyEl && sendNoReplyEl.checked && !replyTarget);
  const wantAutoPin = !!(isAdmin && sendAutoPinEl && sendAutoPinEl.checked && !replyTarget);
  if (wantAutoPin) {
    const pinnedCount = getPinnedRootCount();
    if (pinnedCount >= 3) {
      setStatus('You already have 3 pinned messages. Unpin one or disable Auto pin.', true);
      return;
    }
  }

  const nick = (nickEl.value || "Anonymous").trim().slice(0, 10);
  const payload = {
    event: 'COMMENT_CREATE',
    url: PAGE_URL_PATH,
    nick: isAdmin ? "Poly Track Administrator" : (nick || "Anonymous"),
    content,
  };
  if ((allowReplies || isAdmin) && replyTarget && state.all.has(replyTarget)) {
    const p = state.all.get(replyTarget);
    payload.pid = p._id || p.id;
    payload.rid = p.rid || p._id || p.id;
  }

  btnSend.disabled=true;
  try{
    const r = await api(payload);
    if (r && r.code === 0) {
      textEl.value = ""; charCount.textContent = "0";
      const newId = r?.data?.id;

      // If admin chose "No replies" and this is a root message, lock it now
      if (wantNoReply && newId) {
        try {
          await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id: newId, url: PAGE_URL_PATH, lock: true });
        } catch (e) {
          setStatus(e?.message || 'Failed to lock replies for this message', true);
        }
      }
      // Auto-pin newly created root (admin only)
      if (wantAutoPin && newId && !payload.pid && !payload.rid) {
        try {
          const pr = await api({ event:'COMMENT_SET_FOR_ADMIN', id: newId, url: PAGE_URL_PATH, set: { top: true } });
          if (pr?.code !== 0) setStatus(pr?.message || 'Auto pin failed', true);
        } catch (e) {
          setStatus(e?.message || 'Auto pin failed', true);
        }
      }

      if (sendNoReplyEl) sendNoReplyEl.checked = false;
      if (sendAutoPinEl) sendAutoPinEl.checked = false;

      replyTarget = null; replyTo.style.display="none";
      setStatus('Sent!');
      updateAdminUI();
    } else {
      setStatus(r?.message || 'Send failed', true);
    }
  }catch(e){
    setStatus(e?.message || 'Send failed', true);
  }finally{
    btnSend.disabled=false;
    updateSendButtonUI();
  }
}

/* Image attach */
async function attachImage(){
  const f = fileEl.files && fileEl.files[0];
  if (!f) { setStatus('Choose an image first'); return; }
  const mb = f.size/1024/1024;
  if (mb > MAX_FILE_MB) { setStatus(`Image too large (>${MAX_FILE_MB}MB)`, true); return; }
  try{
    setStatus('Uploading…');
    const dataUrl = await fileToDataURL(f);
    const resp = await api({ event:'UPLOAD_IMAGE', photo:dataUrl, url: PAGE_URL_PATH });
    if (resp?.code === 0 && resp?.data?.url) {
      insertAtCursor(textEl, `\n<img src="${resp.data.url}">\n`);
      setStatus('Image attached!');
    } else {
      setStatus(resp?.message || 'Image upload failed', true);
    }
  }catch(e){
    setStatus(e?.message || 'Image upload failed', true);
  }
}

/* General-purpose embed (admin only) */
async function attachEmbed(){
  if (!isAdmin) { setStatus('Only admin can embed content', true); return; }
  const mode = (prompt('Embed mode:\n- Type \"url\" to embed a website by URL\n- Type \"html\" to embed raw HTML (sandboxed)') || '').trim().toLowerCase();
  if (!mode) return;

  if (mode === 'url') {
    const url = (prompt('Enter website URL (https://...)') || '').trim();
    if (!/^https?:\/\//i.test(url)) { setStatus('Please enter a valid http(s) URL', true); return; }
    const html = `\n<iframe src=\"${url}\" width=\"560\" height=\"315\" title=\"Embedded site\" sandbox=\"allow-scripts allow-same-origin\" loading=\"lazy\" referrerpolicy=\"no-referrer\"></iframe>\n`;
    insertAtCursor(textEl, html);
    setStatus('Embed added!');
    return;
  }

  if (mode === 'html') {
    const raw = prompt('Paste raw HTML to embed (will be sandboxed; scripts allowed inside the frame):') || '';
    if (!raw.trim()) return;
    const esc = raw
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/\"/g,'&quot;');
    const html = `\n<iframe srcdoc=\"${esc}\" width=\"560\" height=\"315\" title=\"Embedded HTML\" sandbox=\"allow-scripts allow-same-origin\" loading=\"lazy\" referrerpolicy=\"no-referrer\"></iframe>\n`;
    insertAtCursor(textEl, html);
    setStatus('Embed added!');
    return;
  }

  setStatus('Type \"url\" or \"html\".', true);
}

/* Events */
btnSend.addEventListener('click', sendMessage);
textEl.addEventListener('input', ()=>{
  let v = textEl.value || "";
  if (v.length > MAX_CHARS) { v = v.slice(0, MAX_CHARS); textEl.value = v; }
  charCount.textContent = String(v.length);
});
fileEl.addEventListener('change', ()=>{
  const f = fileEl.files && fileEl.files[0];
  fileInfo.textContent = f ? `${f.name} (${(f.size/1024/1024).toFixed(2)} MB)` : '';
});
btnAttach.addEventListener('click', attachImage);
if (btnEmbed) btnEmbed.addEventListener('click', attachEmbed);

replyCancel.addEventListener('click', ()=>{
  replyTarget=null;
  replyTo.style.display='none';
  updateAdminUI();
});

btnAdminLogin.addEventListener('click', async ()=>{
  const pass = adminPass.value || "";
  if (!pass) return;
  try{
    const r = await api({ event:'LOGIN', password: pass });
    if (r?.accessToken) {
      TK_TOKEN = r.accessToken;
      localStorage.setItem('twikoo_access_token', TK_TOKEN);
      isAdmin = true;
      adminPass.value = "";
      await refreshAdminStatus();
      await loadLatest(false);   // reload — not real-time
    } else {
      setStatus(r?.message || 'Login failed', true);
    }
  }catch(e){
    setStatus(e?.message || 'Login failed', true);
  }
});
btnAdminLogout.addEventListener('click', async ()=>{
  TK_TOKEN = null;
  localStorage.removeItem('twikoo_access_token');
  localStorage.removeItem('twikoo_is_admin');
  isAdmin = false;
  await refreshAdminStatus();
  await loadLatest(false);       // reload — not real-time
});

loadMoreBtn.addEventListener('click', loadOlder);

/* Message action delegation */
messagesEl.addEventListener('click', async (e)=>{
  const t = e.target.closest('.action'); if (!t) return;
  const msgEl = e.target.closest('.msg'); const cid = msgEl?.dataset?.cid;

  if (t.dataset.action === 'reply'){
    if (!(allowReplies || isAdmin)) return;
    replyTarget = cid;
    const c = state.all.get(cid);
    replyName.textContent = c?.nick || 'Anonymous';
    replyTo.style.display = 'flex';
    textEl.focus();
    updateAdminUI();
    return;
  }

  // Everyone can expand/collapse replies
  if (t.dataset.action === 'toggleReplies'){
    const rootId = t.dataset.parent;
    if (!rootId) return;
    if (expanded.has(rootId)) expanded.delete(rootId); else expanded.add(rootId);
    renderAllIncremental();
    return;
  }

  if (!isAdmin) return; // below are admin-only

  if (t.dataset.action === 'adminDel'){
    {
      const c = state.all.get(cid);
      const isPinnedRoot = c && (c.rid || '') === '' && Number(c.top) === 1;
      if (isPinnedRoot) {
        if (!armConfirmButton(t, 'Are you sure?')) return;
      }
    }
    try{
      const r = await api({ event:'COMMENT_DELETE_FOR_ADMIN', id: cid, url: PAGE_URL_PATH });
      if (r?.code === 0) setStatus('Deleted');
      else setStatus(r?.message || 'Delete failed', true);
    }catch(err){ setStatus(err?.message || 'Delete failed', true); }
    return;
  }

  if (t.dataset.action === 'adminPin'){
    try{
      const c = state.all.get(cid);
      const isRoot = c && (c.rid || '') === '';
      const currentlyPinned = Number(c?.top || 0) === 1;
      const wantTop = !currentlyPinned;
      if (currentlyPinned && !wantTop && isRoot) {
        if (!armConfirmButton(t, 'Are you sure?')) return;
      }
      const r = await api({ event:'COMMENT_SET_FOR_ADMIN', id: cid, url: PAGE_URL_PATH, set: { top: wantTop }});
      if (r?.code === 0) setStatus(wantTop ? 'Pinned' : 'Unpinned');
      else setStatus(r?.message || 'Pin failed', true);
    }catch(err){ setStatus(err?.message || 'Pin failed', true); }
    return;
  }

  if (t.dataset.action === 'adminLock'){
    try{
      const c = state.all.get(cid);
      const rootId = (c.rid && c.rid !== "") ? c.rid : cid;
      const rootObj = state.all.get(rootId);
      const wantLock = !(rootObj && rootObj.locked);
      if (!wantLock && rootObj && (rootObj.rid || '') === '' && Number(rootObj.top) === 1) {
        if (!armConfirmButton(t, 'Are you sure?')) return;
      }
      const r = await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', id: rootId, url: PAGE_URL_PATH, lock: wantLock });
      if (r?.code === 0) setStatus(wantLock ? 'Replies locked' : 'Replies unlocked');
      else setStatus(r?.message || 'Lock toggle failed', true);
    }catch(err){ setStatus(err?.message || 'Lock toggle failed', true); }
    return;
  }
});

/* Init */
(async function init(){
  await checkConnection();
  await refreshAdminStatus();
  await loadLatest(false);   // initial load — not real-time
  connectWS();
  updateSendButtonUI();
})();