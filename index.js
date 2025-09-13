/* Poly Track Chatboard – index.js */
/* Works with the provided index.html structure and Twikoo Worker backend */
console.log("chatboard.index.js v7");

/* ===== Configure if you move host/path ===== */
const WORKER_URL    = "https://twikoo-cloudflare.ertertertet07.workers.dev";
const PAGE_URL_PATH = "/chatboard/";
const PAGE_HREF     = "https://htmlunblockedgames.github.io/chatboard/";
const MAX_FILE_MB   = 5;
const MAX_CHARS     = 2000;

/* DOM */
const $=id=>document.getElementById(id);
const messagesEl=$("messages"), loadMoreBtn=$("loadMore");
const nickEl=$("nick"), textEl=$("text");
const fileEl=$("file"), btnAttach=$("btnAttach"), btnSend=$("btnSend");
const fileInfo=$("fileInfo"), statusEl=$("status"), connEl=$("conn");

/* Admin UI refs */
const adminPanel=$("adminPanel"), adminPass=$("adminPass"), btnAdminLogin=$("btnAdminLogin"),
      btnAdminLogout=$("btnAdminLogout"), adminLoginRow=$("adminLoginRow"),
      adminControls=$("adminControls"), pinCountEl=$("pinCount"), adminNote=$("adminNote");

const limitMbEl=$("limitMb"), limitChars=$("limitChars"), limitChars2=$("limitChars2"), charCount=$("charCount");
const replyTo=$("replyTo"), replyName=$("replyName"), replyCancel=$("replyCancel");

/* State */
let TK_TOKEN = localStorage.getItem('twikoo_access_token') || null;
const state = { all:new Map(), tops:[] }; // id -> comment, plus tops[]
let loading=false;
let earliestMainCreated=null; // smallest created among current top-levels
let replyTarget=null; // {_id, rid, nick}
const expanded = new Set(); // top-level ids with visible replies
let isAdmin = false;
let rateBlockedUntil = 0;   // until timestamp if 429 hit

/* Limits text */
limitMbEl.textContent=MAX_FILE_MB;
limitChars.textContent=MAX_CHARS;
limitChars2.textContent=MAX_CHARS;

/* Helpers */
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

/* Client-side nickname guard */
function isForbiddenNick(nick){
  if (!nick) return false;
  const subs = { '0':'o','1':'i','!':'i','|':'i','l':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s' };
  let s = String(nick).toLowerCase();
  s = s.replace(/[0l1!|3457@$]/g, ch => subs[ch] || ch).replace(/[^a-z]/g,'');
  return s.includes('admin') || s.includes('administrator');
}

/* API with token persistence, idempotent retries, and 429 handling */
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

  const idempotent = body.event === 'COMMENT_GET' || body.event === 'GET_CONFIG' || body.event === 'GET_FUNC_VERSION' || body.event === 'GET';
  const maxAttempts = idempotent ? 3 : 1;

  let attempt = 0, lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetch(WORKER_URL, { method: "POST", headers, body: JSON.stringify(body) });

      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        const until = parseRetryAfter(ra) || (Date.now() + 20000);
        rateBlockedUntil = Math.max(rateBlockedUntil, until);
        if (attempt < maxAttempts) {
          const backoff = Math.min(8000, 500 * Math.pow(2, attempt-1)) + Math.random()*200;
          await sleep(backoff);
          continue;
        }
        throw new Error('Too Many Requests');
      }

      const json = await res.json().catch(() => ({}));

      if (json && (json.code === 1000 || (json.message && /too many requests/i.test(String(json.message))))) {
        const ra = res.headers.get('retry-after');
        let until = parseRetryAfter(ra) || 0;
        if (!until && json.retryAfterSeconds) until = Date.now() + Number(json.retryAfterSeconds) * 1000;
        if (!until && json.retryAfterMs) until = Date.now() + Number(json.retryAfterMs);
        if (!until) until = Date.now() + 20000;
        rateBlockedUntil = Math.max(rateBlockedUntil, until);
        if (attempt < maxAttempts) {
          const backoff = Math.min(8000, 500 * Math.pow(2, attempt-1)) + Math.random()*200;
          await sleep(backoff);
          continue;
        }
        throw new Error('Too Many Requests');
      }

      if (body.event === 'LOGIN' && json && json.accessToken) {
        TK_TOKEN = json.accessToken;
        localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }
      if (body.event === 'GET_CONFIG' && json && json.accessToken) {
        TK_TOKEN = json.accessToken;
        localStorage.setItem('twikoo_access_token', TK_TOKEN);
      }

      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoff = Math.min(8000, 500 * Math.pow(2, attempt-1)) + Math.random()*200;
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Request failed");
}

/* Admin helpers */
function revealAdminIfRequested(){
  const q = new URLSearchParams(location.search);
  if (q.get('admin') === '1' || location.hash === '#admin') {
    adminPanel.style.display = 'grid';
  }
}
function updateAdminUI(){
  const pinned = state.tops.filter(x => Number(x.top) === 1).length;
  pinCountEl.textContent = String(pinned);
  if (isAdmin) {
    adminLoginRow.style.display = 'none';
    adminControls.style.display = 'flex';
    adminNote.textContent = 'You are logged in as admin';
  } else {
    adminLoginRow.style.display = 'flex';
    adminControls.style.display = 'none';
    adminNote.textContent = 'Login to manage comments';
  }
}
async function refreshAdminStatus(){
  const r = await api({event:'GET_CONFIG'});
  console.debug('GET_CONFIG response', r);

  if (r && r.accessToken) {
    TK_TOKEN = r.accessToken;
    localStorage.setItem('twikoo_access_token', TK_TOKEN);
  }

  const adminFlag = r && (truthy(r.isAdmin) || truthy(r.admin) ||
                          (r.data && (truthy(r.data.isAdmin) || truthy(r.data.admin))) ||
                          (r.config && (truthy(r.config.IS_ADMIN) || truthy(r.config.is_admin))));
  if (adminFlag) localStorage.setItem('twikoo_is_admin','1'); else localStorage.removeItem('twikoo_is_admin');

  const cached = (localStorage.getItem('twikoo_is_admin') === '1') && !!TK_TOKEN;
  isAdmin = !!(adminFlag || cached);
  const q = new URLSearchParams(location.search);
  const requested = (q.get('admin') === '1' || location.hash === '#admin');
  adminPanel.style.display = (isAdmin || requested) ? 'grid' : 'none';
  updateAdminUI();
}

/* Connection indicator */
async function checkConnection(){
  try{
    if (Date.now() < rateBlockedUntil){
      const secs = Math.ceil((rateBlockedUntil - Date.now())/1000);
      connEl.textContent = `Status: Rate limited (${secs}s)`;
      connEl.classList.remove("ok"); connEl.classList.add("bad");
      setStatus(`API rate limit. Wait ${secs}s`, true);
      return false;
    }
    const res = await api({event:"GET_FUNC_VERSION"});
    console.debug('checkConnection GET_FUNC_VERSION response', res);
    connEl.textContent = "Status: Online";
    connEl.classList.remove("bad"); connEl.classList.add("ok");
    setStatus('');
    return true;
  }catch(err){
    const msg = (err && err.message) ? err.message : String(err);
    if (/Too Many Requests/i.test(msg)){
      const m = msg.match(/wait\s*(\d+)s/);
      const secs = m ? m[1] : '';
      connEl.textContent = secs ? `Status: Rate limited (${secs}s)` : 'Status: Rate limited';
      setStatus(`Too many requests. ${secs?secs+'s':''}`, true);
    } else {
      connEl.textContent = "Status: Offline";
      setStatus('Connection error: ' + msg, true);
    }
    connEl.classList.remove("ok"); connEl.classList.add("bad");
    return false;
  }
}

/* ===== Flatten server payload and rebuild threads ===== */
function mergeList(list){
  const temp = new Map();

  const pushItem = (src) => {
    const id = src._id || src.id; if (!id) return;
    temp.set(id, {
      ...src,
      _id: id,
      pid: src.pid || "",
      rid: src.rid || "",
      created: src.created || Date.now(),
      nick: src.nick || "Anonymous",
      avatar: src.avatar || "",
      comment: src.comment || src.content || "",
      depth: 0,
      parentNick: null,
      children: [],
      top: Number(src.top ? 1 : 0)
    });
  };

  (Array.isArray(list) ? list : []).forEach(top => {
    // keep existing rid/pid if provided (don’t force top-level)
    pushItem(top);
    if (Array.isArray(top.replies)) top.replies.forEach(r => pushItem(r));
  });

  for (const obj of temp.values()){
    if ((obj.rid || "") === "") { obj.depth = 0; obj.parentNick = null; continue; }
    let depth = 1;
    let p = temp.get(obj.pid);
    const seen = new Set([obj._id]);
    while (p && (p.rid || "") !== "") {
      if (seen.has(p._id)) break;
      seen.add(p._id);
      depth++;
      p = temp.get(p.pid);
    }
    obj.depth = depth;
    obj.parentNick = (temp.get(obj.pid)?.nick) || obj.ruser || null;

    let root = obj;
    while (root && (root.rid || "") !== "") root = temp.get(root.pid);
    if (root) obj.rid = root._id;
  }

  for (const o of temp.values()) o.children = [];
  for (const o of temp.values()){
    if ((o.rid || "") !== ""){
      const root = temp.get(o.rid);
      if (root) root.children.push(o);
    }
  }
  for (const root of temp.values()){
    if (root.children && root.children.length){
      root.children.sort((a,b)=>(a.created||0)-(b.created||0));
    }
  }

  state.all = temp;
  state.tops = Array.from(temp.values()).filter(x => (x.rid || "") === "");
  state.tops.sort((a,b)=>(b.created||0)-(a.created||0));
  earliestMainCreated = state.tops.length ? Math.min(...state.tops.map(x=>x.created||Date.now())) : null;
}

function renderAll(){
  messagesEl.innerHTML="";
  const frag=document.createDocumentFragment();
  for (const c of state.tops){
    const node = renderMsg(c);

    // Admin controls for top-level
    if (isAdmin && (c.rid || '') === '') {
      const actions = node.querySelector('.actions');
      if (actions) {
        const pinBtn = document.createElement('span');
        pinBtn.className = 'action';
        pinBtn.dataset.action = 'adminPin';
        pinBtn.dataset.cid = c._id;
        pinBtn.textContent = Number(c.top) === 1 ? 'Unpin' : 'Pin';
        actions.appendChild(pinBtn);

        const delBtn = document.createElement('span');
        delBtn.className = 'action';
        delBtn.dataset.action = 'adminDel';
        delBtn.dataset.cid = c._id;
        delBtn.textContent = 'Delete';
        actions.appendChild(delBtn);
      }
    }

    const count = c.children?.length || 0;
    if (count > 0) {
      const actions = node.querySelector('.actions');
      if (actions) {
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'action';
        toggleBtn.dataset.action = 'toggleReplies';
        toggleBtn.dataset.parent = c._id;
        toggleBtn.textContent = expanded.has(c._id)
          ? (count===1 ? 'Close Reply' : 'Close Replies')
          : (count===1 ? 'Show Reply' : 'Show Replies');
        actions.appendChild(toggleBtn);
      }
    }

    const cont = document.createElement("div");
    cont.className="replies";
    cont.id = "replies-"+c._id;
    if (expanded.has(c._id)) {
      buildReplies(cont, c);
      cont.style.display="flex";
    } else {
      cont.style.display="none";
    }
    const bubbleForReplies = node.querySelector('.bubble');
    (bubbleForReplies || node).appendChild(cont);

    frag.appendChild(node);
  }
  messagesEl.appendChild(frag);

  if (state.tops.length) { loadMoreBtn.style.display="inline-flex"; loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
  else { loadMoreBtn.style.display="none"; }

  updateAdminUI();
}

function renderMsg(c){
  const cid = c._id || c.id;
  const wrap=document.createElement("div"); wrap.className="msg"; wrap.dataset.cid=cid;

  const avatar=document.createElement("div"); avatar.className="avatar";
  if (c.avatar){ const img=new Image(); img.src=c.avatar; img.alt=c.nick||"avatar"; avatar.appendChild(img); }
  else { avatar.textContent = initialOf(c.nick); }

  const bubble=document.createElement("div"); bubble.className="bubble";
  const depth = Number(c.depth || 0);
  bubble.style.marginLeft = (depth * 20) + 'px';

  const meta=document.createElement("div"); meta.className="meta";
  const nick=document.createElement("span"); nick.className="nick"; nick.textContent=c.nick||"Anonymous";
  const time=document.createElement("span"); time.textContent=new Date(c.created||Date.now()).toLocaleString();
  meta.append(nick,time);

  const content=document.createElement("div"); content.className="content";
  if (c.parentNick) {
    const replyToSpan = document.createElement('div');
    replyToSpan.style.fontSize='12px';
    replyToSpan.style.color='var(--muted)';
    replyToSpan.textContent = `↪ Replying to ${c.parentNick}`;
    content.appendChild(replyToSpan);
  }
  const contentBody = document.createElement('div');
  contentBody.textContent = c.comment || "";
  content.appendChild(contentBody);

  const actions=document.createElement("div"); actions.className="actions";
  const replyBtn=document.createElement("span"); replyBtn.className="action"; replyBtn.dataset.action="reply"; replyBtn.textContent="↩ Reply";
  actions.append(replyBtn);

  bubble.append(meta,content,actions);
  wrap.append(avatar,bubble);
  return wrap;
}

function buildReplies(container, parent){
  container.innerHTML="";
  const kids = (parent.children||[]).slice().sort((a,b)=>(a.created||0)-(b.created||0));
  for (const ch of kids) container.appendChild(renderMsg(ch));
}

/* ===== Loading ===== */
async function loadLatest(){
  if (loading) return; loading=true;
  try{
    const r = await api({event:"COMMENT_GET", url: PAGE_URL_PATH, page:1, pageSize:20});
    const raw = Array.isArray(r?.data) ? r.data
               : Array.isArray(r?.data?.comments) ? r.data.comments
               : [];
    const list = raw.map(row => ({
      _id: row._id || row.id,
      id: row.id || row._id,
      url: row.url,
      nick: row.nick || 'Anonymous',
      mail: row.mail || '',
      link: row.link || '',
      comment: row.comment ?? row.content ?? '',
      created: Number(row.created ?? row.created_at ?? Date.now()),
      top: Number(row.top ? 1 : 0),
      pid: row.pid || '',
      rid: row.rid || ''
    }));
    mergeList(list);
    renderAll();
    if (r && r.more === false) { loadMoreBtn.style.display="none"; }
  }catch(e){
    setStatus(prettifyError(e?.message) || "Failed to load messages.", true);
  }finally{ loading=false; }
}

async function loadOlder(){
  if (loading || !earliestMainCreated) return;
  loading=true; loadMoreBtn.disabled=true; loadMoreBtn.textContent="Loading…";
  try{
    const r = await api({event:"COMMENT_GET", url: PAGE_URL_PATH, page:1, pageSize:20, before: earliestMainCreated});
    const raw = Array.isArray(r?.data) ? r.data
               : Array.isArray(r?.data?.comments) ? r.data.comments
               : [];
    const data = raw.map(row => ({
      _id: row._id || row.id,
      id: row.id || row._id,
      url: row.url,
      nick: row.nick || 'Anonymous',
      mail: row.mail || '',
      link: row.link || '',
      comment: row.comment ?? row.content ?? '',
      created: Number(row.created ?? row.created_at ?? Date.now()),
      top: Number(row.top ? 1 : 0),
      pid: row.pid || '',
      rid: row.rid || ''
    }));
    if (data.length){
      const combined = [...Array.from(state.all.values()), ...data];
      mergeList(combined);
      renderAll();
      if (r && r.more === false){ loadMoreBtn.textContent="No more"; loadMoreBtn.disabled=true; }
      else { loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older"; }
    }else{
      loadMoreBtn.textContent="No more"; loadMoreBtn.disabled=true;
    }
  }catch(e){
    setStatus(prettifyError(e?.message) || "Failed loading older.", true);
    loadMoreBtn.disabled=false; loadMoreBtn.textContent="Load older";
  }finally{ loading=false; }
}

/* ===== Actions ===== */
function prettifyError(msg){
  if (!msg) return "Unexpected error";
  const m=String(msg);
  if (m.startsWith("Too Many Requests: wait")) return m;
  if (m.includes("发言频率过高")) return "You're sending too fast. Please wait a little and try again.";
  if (m.includes("评论太火爆")) return "Chat is busy right now — please try again in a moment.";
  if (m.includes("验证码")) return "Captcha check failed.";
  if (m.includes("未配置图片上传服务")) return "Image upload service is not configured.";
  if (m.includes("请先登录")) return "Please sign in first.";
  if (m.includes("密码错误")) return "Incorrect password.";
  if (m.includes("未配置管理密码")) return "Admin password is not set.";
  if (m.includes("数据库无配置")) return "Server configuration is missing.";
  if (m.includes("Too Many Requests")) return "Too many requests. Please slow down.";
  return m;
}

async function sendMessage(){
  const nickRaw = nickEl.value.trim();
  const nick = nickRaw || "Anonymous";
  if (!isAdmin && isForbiddenNick(nick)) { setStatus("Nickname not allowed.", true); return; }

  const html = textEl.value.trim();
  if (!html){ setStatus("Type a message first.", true); return; }
  if (html.length > MAX_CHARS){ setStatus(`Message too long. Max ${MAX_CHARS} characters.`, true); return; }

  let pid, rid;
  if (replyTarget){
    const cid = replyTarget._id || replyTarget.id;
    pid = cid;
    rid = replyTarget.rid && replyTarget.rid !== "" ? replyTarget.rid : cid;
  }

  btnSend.disabled=true; btnSend.textContent="Sending…"; setStatus("Sending…");
  try{
    const payload = {event:"COMMENT_SUBMIT", nick, comment: html, url: PAGE_URL_PATH, href: PAGE_HREF, ua: navigator.userAgent};
    if (pid) payload.pid = pid;
    if (rid) payload.rid = rid;

    const r = await api(payload);
    const newId = (r && (r.id || (r.data && r.data.id))) || null;
    if (newId){
      if (pid){
        const rootToExpand = (rid && rid !== "") ? rid : pid;
        expanded.add(rootToExpand);
      }
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
  const cid = commentEl?.dataset?.cid; if (!cid) return;
  const who = commentEl.querySelector('.nick')?.textContent || "someone";
  const obj = state.all.get(cid);
  const rootId = obj ? ((obj.rid && obj.rid !== "") ? obj.rid : (obj._id || obj.id)) : cid;
  replyTarget = { _id: cid, rid: rootId, nick: who };
  replyName.textContent = who;
  replyTo.style.display = "inline-flex";
  textEl.focus();
}
function clearReplyTarget(){ replyTarget=null; replyName.textContent=""; replyTo.style.display="none"; }

/* Admin actions */
async function adminTogglePin(id){
  try{
    const item = state.all.get(id);
    if (!item) return;
    const currentPinned = state.tops.filter(x => Number(x.top) === 1).length;
    const wantTop = Number(item.top) === 1 ? 0 : 1;
    if (wantTop === 1 && currentPinned >= 3) { setStatus("Pin limit reached (3). Unpin something first.", true); return; }
    const r = await api({event:'COMMENT_SET_FOR_ADMIN', url: PAGE_URL_PATH, id, set:{ top: wantTop }});
    if (r && r.code === 0) await loadLatest();
    else setStatus(r?.message || 'Pin failed', true);
  }catch(e){ setStatus(prettifyError(e?.message) || 'Pin failed', true); }
}
async function adminDelete(id){
  try{
    const r = await api({event:'COMMENT_DELETE_FOR_ADMIN', url: PAGE_URL_PATH, id});
    if (r && r.code === 0) await loadLatest();
    else setStatus(r?.message || 'Delete failed', true);
  }catch(e){ setStatus(prettifyError(e?.message) || 'Delete failed', true); }
}

/* Events */
btnSend.addEventListener("click", sendMessage);
btnAttach.addEventListener("click", attachImage);
loadMoreBtn.addEventListener("click", loadOlder);
replyCancel.addEventListener("click", clearReplyTarget);

if (btnAdminLogin) btnAdminLogin.addEventListener('click', async ()=>{
  const pw = adminPass.value.trim(); if (!pw) { setStatus('Enter password', true); return; }
  const r = await api({event:'LOGIN', password: pw});
  if (r && r.code === 0) {
    isAdmin = true;
    localStorage.setItem('twikoo_is_admin','1');
    adminPanel.style.display = 'grid';
    await refreshAdminStatus();
    await loadLatest();
    setStatus('Admin logged in');
  } else {
    setStatus(r?.message || 'Login failed', true);
  }
});
if (btnAdminLogout) btnAdminLogout.addEventListener('click', async ()=>{
  isAdmin = false;
  localStorage.removeItem('twikoo_is_admin');
  TK_TOKEN = null;
  localStorage.removeItem('twikoo_access_token');
  await refreshAdminStatus();
  setStatus('Logged out');
});

textEl.addEventListener("input", ()=>{
  const n=textEl.value.length; charCount.textContent=String(n);
  if (n>MAX_CHARS) setStatus(`Message too long. Max ${MAX_CHARS} characters.`, true);
  else if (statusEl.textContent.startsWith("Message too long")) setStatus("");
});
fileEl.addEventListener("change", ()=>{
  const f=fileEl.files&&fileEl.files[0];
  fileInfo.textContent = f ? `${f.name} · ${(f.size/1024/1024).toFixed(2)} MB` : "";
});

/* Delegate actions in message list */
messagesEl.addEventListener("click",(e)=>{
  const card = e.target.closest('.msg');
  const btn = e.target.closest('[data-action="reply"]');
  const toggle = e.target.closest('[data-action="toggleReplies"]');
  const pin = e.target.closest('[data-action="adminPin"]');
  const del = e.target.closest('[data-action="adminDel"]');

  if (btn && card){ setReplyTarget(card); return; }

  if (toggle){
    const pid = toggle.dataset.parent;
    if (!pid) return;
    const cont = document.getElementById("replies-"+pid);
    const parent = state.all.get(pid);
    if (!cont || !parent) return;

    if (expanded.has(pid)){
      cont.style.display="none";
      expanded.delete(pid);
    }else{
      if (!cont.childElementCount) buildReplies(cont, parent);
      cont.style.display="flex";
      expanded.add(pid);
    }
    const count = parent.children?.length || 0;
    toggle.textContent = expanded.has(pid)
      ? (count===1 ? 'Close Reply' : 'Close Replies')
      : (count===1 ? 'Show Reply' : 'Show Replies');
    return;
  }

  if (pin) { adminTogglePin(pin.dataset.cid); return; }
  if (del) { if (confirm('Delete this comment?')) adminDelete(del.dataset.cid); return; }
});

/* Drag & drop image onto textarea */
textEl.addEventListener("dragover", e=>{ e.preventDefault(); });
textEl.addEventListener("drop", async e=>{
  e.preventDefault();
  const f=e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")){
    fileEl.files = e.dataTransfer.files;
    fileInfo.textContent = `${f.name} · ${(f.size/1024/1024).toFixed(2)} MB`;
    await attachImage();
  }
});

/* Init */
(async ()=>{
  revealAdminIfRequested();
  await refreshAdminStatus();
  await checkConnection();
  await loadLatest();
})();