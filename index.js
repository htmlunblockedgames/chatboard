/* Poly Track Chatboard – index.js */
console.log("chatboard.index.js v15");

const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 7;
const MAX_CHARS     = 2000;

// WebSocket endpoint derived from the Worker URL
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
        try { const msg = JSON.parse(e.data); if (msg && msg.type === "refresh") loadLatest(); } catch {}
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

const limitMbEl=$("limitMb"), limitChars=$("limitChars"), limitChars2=$("limitChars2"), charCount=$("charCount");
const replyTo=$("replyTo"), replyName=$("replyName"), replyCancel=$("replyCancel");

/* Show admin panel ONLY at https://htmlunblockedgames.github.io/chatboard/?admin=1 */
const SHOW_ADMIN_PANEL =
  window.location.hostname === "htmlunblockedgames.github.io" &&
  window.location.pathname === "/chatboard/" &&
  new URLSearchParams(window.location.search).get("admin") === "1";
if (adminPanel) adminPanel.style.display = SHOW_ADMIN_PANEL ? "grid" : "none";

let TK_TOKEN = localStorage.getItem('twikoo_access_token') || null;
const state = { all:new Map(), tops:[], rootOrder:[] };
let serverCounts = null;
let loading=false;
let earliestMainCreated=null;
let replyTarget=null;
const expanded = new Set();
let isAdmin = false;
let rateBlockedUntil = 0;
const flashedOnce = new Set();
let allowReplies = true; // global toggle
let allowPosts = true;   // when false, only admin may post

limitMbEl.textContent=MAX_FILE_MB;
limitChars.textContent=MAX_CHARS;
limitChars2.textContent=MAX_CHARS;

const initialOf = s => (s||"A").trim().charAt(0).toUpperCase();
const setStatus=(t,isError=false)=>{
  if(!t){ statusEl.style.display="none"; statusEl.textContent=""; return; }
  statusEl.style.display="inline"; statusEl.textContent=t;
  statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
};
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

/* Render-safe: turn newlines into <br>, allow http(s) links and data/https images */
function renderSafeContent(input){
  const text = String(input ?? "");
  const tpl = document.createElement('template');
  tpl.innerHTML = text.replace(/\n/g, '<br>');
  const frag = document.createDocumentFragment();
  const pushText = s => frag.appendChild(document.createTextNode(s || ''));
  Array.from(tpl.content.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) return pushText(node.textContent);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') return frag.appendChild(document.createElement('br'));
      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        if (/^data:image\/|^https?:\/\//i.test(src)) {
          const img = document.createElement('img');
          img.src = src; img.alt = node.getAttribute('alt') || '';
          img.loading = 'lazy'; img.decoding = 'async';
          return frag.appendChild(img);
        }
        return pushText('[blocked image]');
      }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const a = document.createElement('a');
        if (/^https?:\/\//i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; }
        a.textContent = node.textContent || href;
        return frag.appendChild(a);
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
function updateAdminUI(){
  const counts = serverCounts;
  const pinned = (counts && typeof counts.pinned === 'number')
    ? counts.pinned : state.tops.filter(x => Number(x.top) === 1).length;
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
  // Disable Send for non-admin when posting is locked
  if (!isAdmin && !allowPosts) {
    btnSend.disabled = true;
    btnSend.title = "Only admin can post right now";
  } else {
    btnSend.disabled = false;
    btnSend.title = "";
  }
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

/* Flatten & render (preserve server root order) */
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
  // Fallback: if none found, build by default rules
  if (!rootsInOrder.length) {
    for (const v of temp.values()) if ((v.rid || "") === "") rootsInOrder.push(v);
  }
  state.tops = rootsInOrder;
  state.rootOrder = rootsInOrder.map(x => x._id);
  earliestMainCreated = state.tops.length ? Math.min(...state.tops.map(x=>x.created||Date.now())) : null;
}

function renderAll(){
  messagesEl.innerHTML="";
  const frag=document.createDocumentFragment();
  for (const c of state.tops){
    const node = renderMsg(c);

    const count = c.children?.length || 0;
    if (count > 0 && allowReplies) {
      const actions = node.querySelector('.actions');
      if (actions) {
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'action';
        toggleBtn.dataset.action = 'toggleReplies';
        toggleBtn.dataset.parent = c._id;
        toggleBtn.textContent = (expanded.has(c._id)
          ? (count===1 ? 'Close Reply' : 'Close Replies')
          : (count===1 ? 'Show Reply' : 'Show Replies'));
        actions.appendChild(toggleBtn);
      }
    }

    const cont = document.createElement("div");
    cont.className="replies";
    cont.id = "replies-"+c._id;
    if (allowReplies && expanded.has(c._id)) {
      buildReplies(cont, c);
      cont.style.display="flex";
    } else {
      cont.style.display="none";
    }
    (node.querySelector('.bubble') || node).appendChild(cont);
    frag.appendChild(node);
  }
  messagesEl.appendChild(frag);

  if (state.tops.length) { loadMoreBtn.style.display="inline-flex"; loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
  else { loadMoreBtn.style.display="none"; }

  updateAdminUI();
}

function applyTextGlowOnce(el){
  if (!el) return;
  // Measure width to compute duration: min 2s for short, linear speed otherwise
  const w = el.scrollWidth || el.getBoundingClientRect().width || 0;
  const pxPerSec = 250; // constant speed for long messages
  const durSec = Math.max(2, w / pxPerSec);
  el.classList.add('glow-text');
  el.style.setProperty('--glow-dur', durSec + 's');
  const done = () => {
    // transition to readable black text smoothly
    el.classList.remove('glow-text');
    el.classList.add('glow-fade');
    el.style.removeProperty('--glow-dur');
    el.removeEventListener('animationend', done);
    // remove the fade helper class after it completes
    setTimeout(() => { try { el.classList.remove('glow-fade'); } catch {} }, 400);
  };
  el.addEventListener('animationend', done);
}
function shouldGlow(c){
  const now = Date.now();
  const isRecent = (now - Number(c.created || 0)) <= 5000; // last 5s
  const isDevPinned = authorIsAdmin(c) && Number(c.top) === 1 && ((c.rid || "") === ""); // admin + pinned root
  return isDevPinned || isRecent;
}


function renderMsg(c){
  const cid = c._id || c.id;
  const wrap=document.createElement("div"); wrap.className="msg"; wrap.dataset.cid=cid;
  const adminAuthor = authorIsAdmin(c);
  if (adminAuthor) wrap.classList.add("by-admin");

  const avatar=document.createElement("div"); avatar.className="avatar";
  if (adminAuthor){ avatar.classList.add("admin"); avatar.textContent = "</>"; }
  else if (c.avatar){ const img=new Image(); img.src=c.avatar; img.alt=c.nick||"avatar"; avatar.appendChild(img); }
  else { avatar.textContent = initialOf(c.nick); }

  // Slightly vary avatar glow duration
  if (adminAuthor) {
    const base = 3.2, jitter = (cid.charCodeAt(0)%10)/20; // 0..0.45s
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
  const body = renderSafeContent(c.comment || "");
  body.classList.add('glow-target');
  content.appendChild(body);

  // Conditionally apply glow (dev pinned always; messages from last 5s)
  if (shouldGlow(c)) applyTextGlowOnce(body);

  if (adminAuthor && !flashedOnce.has(cid)) {
    // relying on text sweep only
    flashedOnce.add(cid);
  }

  const actions=document.createElement("div"); actions.className="actions";
  // Determine if this comment is in a locked thread (lock is stored on the root)
  const rootIdForLock = (c.rid && c.rid !== "") ? c.rid : (c._id || c.id);
  const rootForLock = state.all.get(rootIdForLock);
  const threadLocked = !!(rootForLock && rootForLock.locked);

  if (allowReplies && !threadLocked) {
    const replyBtn = document.createElement("span");
    replyBtn.className = "action";
    replyBtn.dataset.action = "reply";
    replyBtn.textContent = "↩ Reply";
    actions.append(replyBtn);
  }
  if (isAdmin) {
    const delBtn = document.createElement('span');
    delBtn.className = 'action'; delBtn.dataset.action = 'adminDel'; delBtn.dataset.cid = cid; delBtn.textContent = 'Delete';
    actions.appendChild(delBtn);

    if ((c.rid || '') === '') {
      const pinBtn = document.createElement('span');
      pinBtn.className = 'action'; pinBtn.dataset.action = 'adminPin'; pinBtn.dataset.cid = cid; pinBtn.textContent = Number(c.top) === 1 ? 'Unpin' : 'Pin';
      actions.appendChild(pinBtn);

      // per-thread lock/unlock
      const lockBtn = document.createElement('span');
      lockBtn.className = 'action'; lockBtn.dataset.action = 'adminLock'; lockBtn.dataset.cid = cid;
      lockBtn.textContent = c.locked ? 'Unlock Replies' : 'Lock Replies';
      actions.appendChild(lockBtn);

      // Reorder pins – only show for pinned root
      if (Number(c.top) === 1) {
        const upBtn = document.createElement('span');
        upBtn.className = 'action'; upBtn.dataset.action='pinUp'; upBtn.dataset.cid=cid; upBtn.textContent='Move Up';
        const downBtn = document.createElement('span');
        downBtn.className = 'action'; downBtn.dataset.action='pinDown'; downBtn.dataset.cid=cid; downBtn.textContent='Move Down';
        actions.append(upBtn, downBtn);
      }
    }
  }

  bubble.append(meta,content,actions);
  wrap.append(avatar,bubble);
  return wrap;
}

function buildReplies(container, parent){
  container.innerHTML="";
  const kids = (parent.children||[]).slice().sort((a,b)=>(a.created||0)-(b.created||0));
  for (const ch of kids) container.appendChild(renderMsg(ch));
}

/* Newline spam protection (client-side) */
function sanitizeOutgoing(s){
  if (!s) return "";
  s = String(s).replace(/\r\n?/g, "\n");
  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  // Limit total lines
  const MAX_LINES = 30;
  const lines = s.split("\n");
  if (lines.length > MAX_LINES) {
    s = lines.slice(0, MAX_LINES).join("\n") + "\n…";
  }
  return s;
}

/* Loading */
async function loadLatest(){
  if (loading) return; loading=true;
  try{
    const r = await api({event:"COMMENT_GET", url: PAGE_URL_PATH, page:1, pageSize:20});
    const raw = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.comments) ? r.data.comments : [];
    const list = raw.map(row => ({
      _id: row._id || row.id, id: row.id || row._id, url: row.url,
      nick: row.nick || 'Anonymous', mail: row.mail || '', link: row.link || '',
      comment: row.comment ?? row.content ?? '', created: Number(row.created ?? row.created_at ?? Date.now()),
      top: Number(row.top ? 1 : 0), pid: row.pid || '', rid: row.rid || '',
      locked: !!row.locked
    }));
    if (r?.data?.counts) serverCounts = r.data.counts; else if (typeof r?.data?.count === 'number') serverCounts = { total: Number(r.data.count) };
    mergeList(list);
    renderAll();
    if (r && r.more === false) loadMoreBtn.style.display="none";
  }catch(e){ setStatus((e?.message)||"Failed to load messages.", true); }
  finally{ loading=false; }
}

async function loadOlder(){
  if (loading || !earliestMainCreated) return;
  loading=true; loadMoreBtn.disabled=true; loadMoreBtn.textContent="Loading…";
  try{
    const r = await api({event:"COMMENT_GET", url: PAGE_URL_PATH, page:1, pageSize:20, before: earliestMainCreated});
    const raw = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.comments) ? r.data.comments : [];
    const data = raw.map(row => ({
      _id: row._id || row.id, id: row.id || row._id, url: row.url,
      nick: row.nick || 'Anonymous', mail: row.mail || '', link: row.link || '',
      comment: row.comment ?? row.content ?? '', created: Number(row.created ?? row.created_at ?? Date.now()),
      top: Number(row.top ? 1 : 0), pid: row.pid || '', rid: row.rid || '',
      locked: !!row.locked
    }));
    if (r?.data?.counts) serverCounts = r.data.counts; else if (typeof r?.data?.count === 'number') serverCounts = { total: Number(r.data.count) };
    if (data.length){
      const combined = [...Array.from(state.all.values()), ...data];
      mergeList(combined); renderAll();
      if (r && r.more === false){ loadMoreBtn.textContent="No more"; loadMoreBtn.disabled=true; }
      else { loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
    }else{
      loadMoreBtn.textContent="No more"; loadMoreBtn.disabled=true;
    }
  }catch(e){
    setStatus((e?.message)||"Failed loading older.", true);
    loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older";
  }finally{ loading=false; }
}

/* Errors prettifier */
function prettifyError(m){ if(!m) return "Unexpected error"; const s=String(m);
  if (s.includes("未配置图片上传服务")) return "Image upload service is not configured.";
  if (s.includes("请先登录")) return "Please sign in first.";
  if (s.includes("Too Many Requests")) return "Too many requests. Please slow down.";
  return s;
}

/* Actions */
async function sendMessage(){
  const nickRaw = nickEl.value.trim();
  const nick = isAdmin ? "Poly Track Administrator" : (nickRaw || "Anonymous");
  if (!isAdmin && !allowPosts) { setStatus("Only admin can post right now.", true); return; }
  const htmlRaw = textEl.value.trim();
  if (!htmlRaw){ setStatus("Type a message first.", true); return; }
  const html = sanitizeOutgoing(htmlRaw);
  if (html.length > MAX_CHARS){ setStatus(`Message too long. Max ${MAX_CHARS} characters.`, true); return; }

  let pid, rid;
  if (allowReplies && replyTarget){
    const cid = replyTarget._id || replyTarget.id;
    pid = cid;
    rid = replyTarget.rid && replyTarget.rid !== "" ? replyTarget.rid : cid;
  }

  btnSend.disabled=true; btnSend.textContent="Sending…"; setStatus("Sending…");
  try{
    const payload = {event:"COMMENT_SUBMIT", nick, comment: html, url: PAGE_URL_PATH, href: PAGE_HREF, ua: navigator.userAgent};
    if (allowReplies && pid) payload.pid = pid;
    if (allowReplies && rid) payload.rid = rid;

    const r = await api(payload);
    const newId = (r && (r.id || (r.data && r.data.id))) || null;
    if (newId){
      textEl.value=""; charCount.textContent="0"; fileEl.value=""; fileInfo.textContent=""; clearReplyTarget();
      await loadLatest();
      setStatus("");
    }else{
      throw new Error(prettifyError(r?.message || "Unknown error"));
    }
  }catch(e){ setStatus("Send failed: " + e.message, true); }
  finally{ btnSend.disabled=false; btnSend.textContent="Send"; }
}

async function attachImage(){
  const f = fileEl.files && fileEl.files[0];
  if (!f){ setStatus("Choose an image file first.", true); return; }
  if (!/^image\//.test(f.type)){ setStatus("Only image files are allowed.", true); return; }
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  if (f.size > maxBytes){ setStatus(`Image too large (>${MAX_FILE_MB} MB).`, true); return; }

  btnAttach.disabled=true; btnAttach.textContent="Uploading…"; setStatus("Uploading image…");
  try{
    const dataURL = await fileToDataURL(f);
    const r = await api({event:"UPLOAD_IMAGE", photo:dataURL});
    if (r?.code===0 && r?.data?.url){
      insertAtCursor(textEl, `\n<img src="${r.data.url}" alt="">\n`);
      charCount.textContent = String(textEl.value.length);
      setStatus("");
    }else{
      throw new Error(prettifyError(r?.err || r?.message || "Upload failed"));
    }
  }catch(e){ setStatus("Image upload failed: " + e.message, true); }
  finally{ btnAttach.disabled=false; btnAttach.textContent="Attach image"; }
}

function setReplyTarget(commentEl){
  if (!allowReplies) return;
  const cid = commentEl?.dataset?.cid; if (!cid) return;
  const who = commentEl.querySelector('.nick')?.textContent || "someone";
  const obj = state.all.get(cid);
  const rootId = obj ? ((obj.rid && obj.rid !== "") ? obj.rid : (obj._id || obj.id)) : cid;

  // If the root is locked, do not allow replying
  const root = state.all.get(rootId);
  if (root?.locked) { setStatus("Replies are locked for this thread.", true); return; }

  replyTarget = { _id: cid, rid: rootId, nick: who };
  replyName.textContent = who;
  replyTo.style.display = "inline-flex";
  textEl.focus();
}
function clearReplyTarget(){ replyTarget=null; replyName.textContent=""; replyTo.style.display="none"; }

/* Admin operations */
async function adminTogglePin(id){
  try{
    const item = state.all.get(id);
    if (!item) return;
    const currentPinned = state.tops.filter(x => Number(x.top) === 1).length;
    const wantTop = Number(item.top) === 1 ? 0 : 1;
    if (wantTop === 1 && currentPinned >= 3) { setStatus("Pin limit reached (3). Unpin something first.", true); return; }
    const r = await api({event:'COMMENT_SET_FOR_ADMIN', url: PAGE_URL_PATH, id, set:{ top: wantTop }});
    if (r && r.code === 0) await loadLatest(); else setStatus(r?.message || 'Pin failed', true);
  }catch(e){ setStatus((e?.message) || 'Pin failed', true); }
}
async function adminDelete(id){
  try{
    const r = await api({event:'COMMENT_DELETE_FOR_ADMIN', url: PAGE_URL_PATH, id});
    if (r && r.code === 0) await loadLatest(); else setStatus(r?.message || 'Delete failed', true);
  }catch(e){ setStatus((e?.message) || 'Delete failed', true); }
}
async function adminToggleLock(id){
  try{
    const item = state.all.get(id);
    if (!item) return;
    const want = !item.locked;
    const r = await api({ event:'COMMENT_TOGGLE_LOCK_FOR_ADMIN', url: PAGE_URL_PATH, id, lock: want });
    if (r && r.code === 0) { await loadLatest(); }
    else { setStatus(r?.message || 'Lock toggle failed', true); }
  }catch(e){ setStatus((e?.message) || 'Lock toggle failed', true); }
}

/* Reorder pins (Up/Down) */
async function adminReorderPin(id, dir){
  // Build current pinned order from state.tops
  const pinned = state.tops.filter(x => Number(x.top) === 1).map(x => x._id);
  const idx = pinned.indexOf(id);
  if (idx < 0) return;

  if (dir === 'up' && idx > 0) {
    [pinned[idx-1], pinned[idx]] = [pinned[idx], pinned[idx-1]];
  } else if (dir === 'down' && idx < pinned.length - 1) {
    [pinned[idx+1], pinned[idx]] = [pinned[idx], pinned[idx+1]];
  } else {
    return;
  }

  try{
    const r = await api({ event:'COMMENT_REORDER_PINS_FOR_ADMIN', url: PAGE_URL_PATH, order: pinned });
    if (r && r.code === 0) { await loadLatest(); }
    else { setStatus(r?.message || 'Reorder failed', true); }
  }catch(e){ setStatus(e?.message || 'Reorder failed', true); }
}

/* Auth */
async function adminLogin(){
  const pass = (adminPass.value || "").trim();
  if (!pass) { setStatus("Enter admin password.", true); return; }
  setStatus("Signing in…");
  try{
    const r = await api({event:'LOGIN', password: pass});
    if (r && r.accessToken){
      TK_TOKEN = r.accessToken; localStorage.setItem('twikoo_access_token', TK_TOKEN);
      isAdmin = true; localStorage.setItem('twikoo_is_admin','1');
      adminPass.value = "";
      await refreshAdminStatus();
      await loadLatest();
      setStatus("Signed in.");
    }else{
      throw new Error(prettifyError(r?.message || "Login failed"));
    }
  }catch(e){ setStatus(e.message || "Login failed", true); }
}
function adminLogout(){
  TK_TOKEN = null;
  localStorage.removeItem('twikoo_access_token');
  localStorage.removeItem('twikoo_is_admin');
  isAdmin = false;
  updateAdminUI();
  setStatus("Signed out.");
}

/* Global toggles */
async function onToggleRepliesChanged(){
  if (!isAdmin) return;
  const want = !!toggleRepliesEl.checked;
  try{
    const r = await api({ event:'SET_CONFIG_FOR_ADMIN', set:{ allowReplies: want } });
    if (r && r.code === 0){
      allowReplies = String(r.config?.ALLOW_REPLIES).toLowerCase() !== 'false';
      updateAdminUI(); renderAll();
    }else{ setStatus(r?.message || "Failed to update replies setting", true); }
  }catch(e){ setStatus(e.message || "Failed to update replies setting", true); }
}
async function onTogglePostsChanged(){
  if (!isAdmin) return;
  const onlyAdminCanPost = !!togglePostsEl.checked;
  try{
    const r = await api({ event:'SET_CONFIG_FOR_ADMIN', set:{ allowPosts: !onlyAdminCanPost } });
    if (r && r.code === 0){
      allowPosts = String(r.config?.ALLOW_POSTS).toLowerCase() !== 'false';
      updateAdminUI();
    }else{ setStatus(r?.message || "Failed to update posting setting", true); }
  }catch(e){ setStatus(e.message || "Failed to update posting setting", true); }
}

/* Events */
messagesEl.addEventListener('click', (e)=>{
  const t = e.target;
  if (!t || !t.classList.contains('action')) return;
  const msg = t.closest('.msg');
  const cid = msg?.dataset?.cid;
  const act = t.dataset.action;
  if (act === 'reply') { setReplyTarget(msg); return; }
  if (act === 'adminDel' && cid){ adminDelete(cid); return; }
  if (act === 'adminPin' && cid){ adminTogglePin(cid); return; }
  if (act === 'adminLock' && cid){ adminToggleLock(cid); return; }
  if (act === 'toggleReplies'){
    const parent = t.dataset.parent;
    if (!parent) return;
    if (expanded.has(parent)) expanded.delete(parent); else expanded.add(parent);
    renderAll();
    return;
  }
  if (act === 'pinUp' && cid){ adminReorderPin(cid,'up'); return; }
  if (act === 'pinDown' && cid){ adminReorderPin(cid,'down'); return; }
});

btnSend.addEventListener('click', sendMessage);
btnAttach.addEventListener('click', attachImage);
replyCancel.addEventListener('click', (e)=>{ e.preventDefault(); clearReplyTarget(); });
fileEl.addEventListener('change', ()=>{
  const f = fileEl.files && fileEl.files[0];
  fileInfo.textContent = f ? `${f.name} (${Math.round(f.size/1024)} KB)` : '';
});
textEl.addEventListener('input', ()=>{
  const v = textEl.value;
  charCount.textContent = String(v.length);
  if (v.length > MAX_CHARS) charCount.style.color = "var(--danger)"; else charCount.style.color = "var(--muted)";
});

btnAdminLogin?.addEventListener('click', adminLogin);
btnAdminLogout?.addEventListener('click', adminLogout);
toggleRepliesEl?.addEventListener('change', onToggleRepliesChanged);
togglePostsEl?.addEventListener('change', onTogglePostsChanged);
loadMoreBtn.addEventListener('click', loadOlder);

/* Boot */
(async function init(){
  await checkConnection();
  await refreshAdminStatus();
  await loadLatest();
  connectWS();
})();