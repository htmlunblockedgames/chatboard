// twikoo-cloudflare Worker + Durable Object (ChatRoom)
// Allowlist: htmlunblockedgames.github.io (direct) and Google Sites path /view/poly-track (embedded)
// CORS + WS gate match the allowlist. Admin features via hashed token.
// D1 table: comments(id,url,nick,mail,link,content,ip,ua,top,created_at,pid,rid,country,city,region)

export default {
  async fetch(request, env) {
    const urlObj = new URL(request.url);

    // ===== Allowlist helpers =====
    function isPolySites(urlStr) {
      try {
        const u = new URL(urlStr);
        if (u.hostname !== 'sites.google.com') return false;
        const p = (u.pathname || '').replace(/\/+$/,'');
        return p === '/view/poly-track' || p.startsWith('/view/poly-track/');
      } catch { return false; }
    }
    function isGH(host) { return host === 'htmlunblockedgames.github.io'; }
    function getHost(s){ try{ return new URL(s).hostname; }catch{ return ''; } }
    function getPath(s){ try{ return new URL(s).pathname.replace(/\/+$/,''); }catch{ return ''; } }

    function isAllowedBy(origin, referer, parent, ancestor, hint) {
      const oHost = getHost(origin);
      const embedded = !!(parent || ancestor || hint);

      if (isGH(oHost) && !embedded) return true;

      if (embedded) {
        if (isPolySites(parent) || isPolySites(ancestor) || isPolySites(referer) || isPolySites(hint)) return true;
        return false;
      }

      if (!oHost || origin === 'null') {
        if (isPolySites(parent) || isPolySites(ancestor) || isPolySites(referer) || isPolySites(hint)) return true;
        return false;
      }

      if (oHost === 'sites.google.com') {
        const path = getPath(referer);
        if (path === '/view/poly-track' || path.startsWith('/view/poly-track/')) return true;
        return false;
      }

      return false;
    }

    function isAllowedRequest(req, overrides = {}) {
      const origin   = overrides.origin   ?? (req.headers.get('Origin')  || '');
      const referer  = overrides.referer  ?? (req.headers.get('Referer') || '');
      const parent   = overrides.parent   ?? (req.headers.get('x-embed-parent')   || '');
      const ancestor = overrides.ancestor ?? (req.headers.get('x-embed-ancestor') || '');
      const hintHdr  = req.headers.get('x-embed-parent') || '';
      return isAllowedBy(origin, referer, parent, ancestor, hintHdr);
    }

    // ===== WebSocket -> Durable Object (room) =====
    if (request.method === "GET" && urlObj.pathname === "/ws") {
      const parentQS   = urlObj.searchParams.get("parent")     || "";
      const ancestorQS = urlObj.searchParams.get("ancestor")   || "";
      const hintQS     = urlObj.searchParams.get("parentHint") || "";
      const originHdr  = request.headers.get("Origin")  || "";
      const refererHdr = request.headers.get("Referer") || "";
      const ok = isAllowedBy(originHdr, refererHdr, parentQS, ancestorQS, hintQS);
      if (!ok) return new Response("forbidden", { status: 403 });

      const room = urlObj.searchParams.get("room") || "/chatboard/";
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    // ===== CORS =====
    const originHdr = request.headers.get("Origin") || "";
    const reqACRH   = request.headers.get("Access-Control-Request-Headers");
    const isPreflight = request.method === "OPTIONS";

    function hostAllowed(str){
      try {
        const u = new URL(str);
        return (u.hostname === 'htmlunblockedgames.github.io' || u.hostname === 'sites.google.com');
      } catch { return false; }
    }

    let allowed = isPreflight
      ? (originHdr === "null" || (originHdr && hostAllowed(originHdr)))
      : isAllowedRequest(request);

    const allowOrigin = allowed
      ? (originHdr && originHdr !== "null" ? originHdr : "*")
      : "null";

    const CORS = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": reqACRH || "content-type, access-token, x-access-token, authorization, x-embed-parent, x-embed-ancestor",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin, Access-Control-Request-Headers"
    };

    if (isPreflight) {
      if (!allowed) return new Response(null, { status: 403, headers: CORS });
      return new Response(null, { status: 204, headers: CORS });
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json;charset=UTF-8", ...CORS }
      });

    if (!allowed) return json({ code: 403, message: "Forbidden origin" }, 403);

    // ===== Parse body =====
    let body;
    try { body = await request.json(); }
    catch { return json({ code: 400, message: "Bad Request: JSON body required" }, 400); }

    const event = body?.event;

    // ===== helpers =====
    const sha256Hex = async (s) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    };
    const ADMIN_PASS = env.ADMIN_PASSWORD || "";
    const ADMIN_SALT = env.ADMIN_SALT || "twikoo-salt";
    const ADMIN_TOKEN = await sha256Hex(`${ADMIN_PASS}:${ADMIN_SALT}`);

    const headerToken =
      request.headers.get("access-token") ||
      (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const isAdmin = !!headerToken && headerToken === ADMIN_TOKEN;

    async function notifyRoom(roomUrl, payload) {
      try {
        const room = roomUrl || "/chatboard/";
        const id = env.ROOM.idFromName(room);
        const body = payload && typeof payload === 'object' ? payload : { type: "refresh" };
        await env.ROOM.get(id).fetch("https://do/notify", {
          method: "POST",
          headers: { "X-From-Worker": "1", "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      } catch {}
    }

    async function getAllowReplies() {
      try {
        const row = await env.DB
          .prepare(`SELECT content FROM comments WHERE id='cfg:allow_replies' AND url='/__config__' LIMIT 1`)
          .first();
        if (row && String(row.content ?? '').length) {
          const v = String(row.content).toLowerCase();
          return !(v === "0" || v === "false");
        }
      } catch {}
      return String(env.ALLOW_REPLIES || "true").toLowerCase() !== "false";
    }

    async function getAllowPosts() {
      try {
        const row = await env.DB
          .prepare(`SELECT content FROM comments WHERE id='cfg:allow_posts' AND url='/__config__' LIMIT 1`)
          .first();
        if (row && String(row.content ?? '').length) {
          const v = String(row.content).toLowerCase();
          return !(v === "0" || v === "false");
        }
      } catch {}
      return String(env.ALLOW_POSTS || "true").toLowerCase() !== "false";
    }

    async function getPinOrder(url) {
      try{
        const row = await env.DB
          .prepare(`SELECT content FROM comments WHERE id='cfg:pin_order' AND url=?1 LIMIT 1`)
          .bind(url)
          .first();
        if (row && row.content) {
          try { const arr = JSON.parse(String(row.content)); if (Array.isArray(arr)) return arr.map(String); } catch {}
          const csv = String(row.content);
          return csv.split(',').map(s => s.trim()).filter(Boolean);
        }
      }catch{}
      return [];
    }

    async function isThreadLocked(url, rootId) {
      if (!rootId) return false;
      const row = await env.DB
        .prepare(`SELECT 1 AS c FROM comments WHERE url=?1 AND id=?2 LIMIT 1`)
        .bind(url, `cfg:lock:${rootId}`)
        .first();
      return !!row;
    }

    // UPDATED: don't truncate content that includes media tags
    function sanitizeContent(input){
      let s = String(input || "");
      s = s.replace(/\r\n?/g, "\n");
      const hasMedia = /<(img|iframe|video)\b/i.test(s);
      if (!hasMedia && s.length > 2000) s = s.slice(0, 2000);
      s = s.replace(/\n{3,}/g, "\n\n");
      const MAX_LINES = 30;
      const parts = s.split("\n");
      if (!hasMedia && parts.length > MAX_LINES) s = parts.slice(0, MAX_LINES).join("\n") + "\n…";
      return s;
    }

    // ===== helpers: getClientIP =====
    function getClientIP(req) {
      try {
        const h = (name) => req.headers.get(name) || req.headers.get(name.toLowerCase()) || '';
        // Prefer Cloudflare/True-Client-IP/X-Real-IP
        let ip = h('CF-Connecting-IP') || h('True-Client-IP') || h('X-Real-IP') || '';
        // Fallback: first item in X-Forwarded-For
        if (!ip) {
          const xff = h('X-Forwarded-For');
          if (xff) {
            ip = xff.split(',').map(s => s.trim()).find(Boolean) || '';
          }
        }
        // Normalize IPv6-mapped IPv4 format "::ffff:1.2.3.4"
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);
        return ip;
      } catch {
        return '';
      }
    }

    // ===== routes =====
    if (event === "GET_FUNC_VERSION") {
      return json({ code: 0, version: { VERSION: "1.6.41" }, accessToken: await sha256Hex(`${Date.now()}:${Math.random()}`) });
    }

    if (event === "LOGIN") {
      const { password } = body || {};
      if (!password) return json({ code: 400, message: "Password required" }, 400);
      if (password !== ADMIN_PASS) return json({ code: 1024, message: "请先登录" }, 200);
      return json({ code: 0, accessToken: ADMIN_TOKEN });
    }

    if (event === "GET_CONFIG") {
      const allowReplies = await getAllowReplies();
      const allowPosts = await getAllowPosts();
      const res = {
        code: 0,
        config: {
          VERSION: "1.6.41",
          IS_ADMIN: !!isAdmin,
          ALLOW_REPLIES: String(allowReplies),
          ALLOW_POSTS: String(allowPosts),
          SHOW_IMAGE: "true",
          LIGHTBOX: "false",
          SHOW_EMOTION: "true",
          HIGHLIGHT: "true",
          TURNSTILE_SITE_KEY: ""
        }
      };
      if (isAdmin && headerToken) res.accessToken = headerToken;
      return json(res);
    }

    if (event === "SET_CONFIG_FOR_ADMIN") {
      if (!isAdmin) return json({ code: 1024, message: "请先登录" }, 200);
      const updates = (body && body.set) || {};
      try {
        if (Object.prototype.hasOwnProperty.call(updates, 'allowReplies')) {
          const allow = !!updates.allowReplies;
          await env.DB.prepare(
            `REPLACE INTO comments (id,url,nick,mail,link,content,ip,ua,top,created_at,pid,rid)
             VALUES ('cfg:allow_replies','/__config__','','','',?1,'','',0,?2,'','')`
          ).bind(allow ? "1" : "0", Date.now()).run();
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'allowPosts')) {
          const allowP = !!updates.allowPosts;
          await env.DB.prepare(
            `REPLACE INTO comments (id,url,nick,mail,link,content,ip,ua,top,created_at,pid,rid)
             VALUES ('cfg:allow_posts','/__config__','','','',?1,'','',0,?2,'','')`
          ).bind(allowP ? "1" : "0", Date.now()).run();
        }
        await notifyRoom('/chatboard/');
        return json({
          code: 0,
          config: {
            ALLOW_REPLIES: String(await getAllowReplies()),
            ALLOW_POSTS: String(await getAllowPosts())
          }
        });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "COMMENT_TOGGLE_LOCK_FOR_ADMIN") {
      if (!isAdmin) return json({ code: 1024, message: "请先登录" }, 200);
      const { id, url, lock } = body || {};
      if (!id || !url) return json({ code: 400, message: "id and url required" }, 400);
      try {
        if (lock) {
          await env.DB.prepare(
            `REPLACE INTO comments (id,url,nick,mail,link,content,ip,ua,top,created_at,pid,rid)
             VALUES (?1,?2,'','','','1','','',0,?3,'','')`
          ).bind(`cfg:lock:${id}`, url, Date.now()).run();
        } else {
          await env.DB.prepare(`DELETE FROM comments WHERE id=?1 AND url=?2`)
            .bind(`cfg:lock:${id}`, url).run();
        }
        await notifyRoom(url);
        return json({ code: 0 });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "COMMENT_REORDER_PINS_FOR_ADMIN") {
      if (!isAdmin) return json({ code: 1024, message: "请先登录" }, 200);
      const { url, order } = body || {};
      if (!url || !Array.isArray(order)) return json({ code: 400, message: "url and order[] required" }, 400);
      try{
        const payload = JSON.stringify(order.map(String));
        await env.DB.prepare(
          `REPLACE INTO comments (id,url,nick,mail,link,content,ip,ua,top,created_at,pid,rid)
           VALUES ('cfg:pin_order', ?1, '', '', '', ?2, '', '', 0, ?3, '', '')`
        ).bind(url, payload, Date.now()).run();
        await notifyRoom(url);
        return json({ code: 0 });
      }catch(e){
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "COMMENT_DELETE_FOR_ADMIN") {
      if (!isAdmin) return json({ code: 1024, message: "请先登录" }, 200);
      const { id, url } = body || {};
      if (!id || !url) return json({ code: 400, message: "id and url required" }, 400);
      try {
        await env.DB.prepare(`DELETE FROM comments WHERE (id=?1 AND url=?2) OR (rid=?1 AND url=?2) OR (pid=?1 AND url=?2)`)
          .bind(id, url).run();
        await env.DB.prepare(`DELETE FROM comments WHERE id=?1 AND url=?2`).bind(`cfg:lock:${id}`, url).run();
        const row = await env.DB.prepare(`SELECT content FROM comments WHERE id='cfg:pin_order' AND url=?1`).bind(url).first();
        if (row && row.content) {
          let arr = [];
          try { arr = JSON.parse(String(row.content)); if (!Array.isArray(arr)) arr=[]; } catch { arr=[]; }
          const next = arr.filter(x => String(x) !== String(id));
          await env.DB.prepare(
            `REPLACE INTO comments (id,url,content,top,created_at) VALUES ('cfg:pin_order',?1,?2,0,?3)`
          ).bind(url, JSON.stringify(next), Date.now()).run();
        }
        await notifyRoom(url);
        return json({ code: 0 });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "COMMENT_SET_FOR_ADMIN") {
      if (!isAdmin) return json({ code: 1024, message: "请先登录" }, 200);
      const { id, url, set } = body || {};
      if (!id || !url || !set) return json({ code: 400, message: "id, url, set required" }, 400);
      const top = Number(set.top ? 1 : 0);

      try {
        await env.DB.prepare(
          `UPDATE comments
              SET top = ?1
            WHERE id = ?2
              AND url = ?3
              AND (rid = '' OR rid IS NULL)`
        ).bind(top, id, url).run();
        await notifyRoom(url);
        return json({ code: 0 });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "COMMENT_CREATE" || event === "COMMENT_SUBMIT") {
      const allowReplies = await getAllowReplies();
      const allowPosts = await getAllowPosts();
      const { url, nick = "", mail = "", link = "", pid = "", rid = "" } = body || {};
      const nickRaw = String(nick || "");
      const nickFinal = isAdmin ? "Poly Track Administrator" : (nickRaw.trim().slice(0, 10) || "Anonymous");
      let content = (body && (body.content ?? body.comment ?? "")) || "";
      content = sanitizeContent(content);

      // Non-admin: only 1 image (server-side)
      if (!isAdmin) {
        const imgCount = (content.match(/<img\b[^>]*>/gi) || []).length;
        if (imgCount > 1) {
          return json({ code: 400, message: "Only one image per message allowed" }, 200);
        }
      }

      if (!url || !content) return json({ code: 400, message: "url and content required" }, 400);
      if (!isAdmin && !allowPosts) return json({ code: 1029, message: "Only admin can post right now" }, 200);

      // replies control
      let pidFinal = "", ridFinal = "";
      if ((isAdmin || allowReplies) && (pid || rid)) {
        const rootId = rid || pid;
        const locked = await isThreadLocked(url, rootId);
        if (!locked || isAdmin) { pidFinal = pid || ""; ridFinal = rid || ""; }
      }

      const id = await sha256Hex(`${Date.now()}:${crypto.getRandomValues(new Uint32Array(4)).join("-")}`);
      const createdAt = Date.now();
      const ua = request.headers.get("user-agent") || "";
      const ip = getClientIP(request);

      // NEW: capture geo
      const cf = request.cf || {};
      const country = (cf.country || request.headers.get("cf-ipcountry") || "") || null;
      const city = cf.city || null;
      const region = cf.region || cf.regionCode || null;

      try {
        await env.DB.prepare(
          `INSERT INTO comments (id, url, nick, mail, link, content, ip, ua, top, created_at, pid, rid, country, city, region)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(id, url, nickFinal, mail, link, content, ip, ua, createdAt, pidFinal, ridFinal, country, city, region)
        .run();
        const rootIdForBroadcast = ridFinal || pidFinal || "";
        if (rootIdForBroadcast) {
          await notifyRoom(url, { type: "new-reply", rootId: rootIdForBroadcast, id });
        } else {
          await notifyRoom(url, { type: "new-root", id });
        }
        return json({ code: 0, data: { id } });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "GET" || event === "COMMENT_GET") {
      const { url, page = 1, pageSize = 60 } = body || {};
      if (!url) return json({ code: 400, message: "url required" }, 400);

      const ROOT_LIMIT = Math.max(1, Math.min(100, Number(pageSize) || 60));

      try {
        const pinnedRows = await env.DB.prepare(`
          SELECT id, url, nick, COALESCE(mail,'') AS mail, COALESCE(link,'') AS link,
                 content, created_at, COALESCE(top,0) AS top,
                 '' AS pid, '' AS rid,
                 COALESCE(ip,'') AS ip,
                 COALESCE(country,'') AS country,
                 COALESCE(city,'') AS city,
                 COALESCE(region,'') AS region
            FROM comments
           WHERE url = ?1
             AND id NOT LIKE 'cfg:%'
             AND (rid = '' OR rid IS NULL)
             AND top = 1
        ORDER BY created_at DESC, id DESC
        `).bind(url).all();

        const othersRows = await env.DB.prepare(`
          SELECT id, url, nick, COALESCE(mail,'') AS mail, COALESCE(link,'') AS link,
                 content, created_at, COALESCE(top,0) AS top,
                 '' AS pid, '' AS rid,
                 COALESCE(ip,'') AS ip,
                 COALESCE(country,'') AS country,
                 COALESCE(city,'') AS city,
                 COALESCE(region,'') AS region
            FROM comments
           WHERE url = ?1
             AND id NOT LIKE 'cfg:%'
             AND (rid = '' OR rid IS NULL)
             AND (top = 0 OR top IS NULL)
        ORDER BY created_at DESC, id DESC
           LIMIT ${ROOT_LIMIT}
        `).bind(url).all();

        const desiredOrder = await getPinOrder(url);
        const orderIndex = new Map();
        desiredOrder.forEach((id, i) => orderIndex.set(String(id), i));

        const pinnedRoots = (pinnedRows?.results || []).map(r => ({
          id: r.id, url: r.url, nick: r.nick || "Anonymous", mail: r.mail || "", link: r.link || "",
          content: r.content, created: Number(r.created_at), top: true, status: "approved",
          pid: "", rid: "", locked: false,
          ip: r.ip || "", country: r.country || "", city: r.city || "", region: r.region || ""
        }));
        pinnedRoots.sort((a,b) => {
          const ia = orderIndex.has(a.id) ? orderIndex.get(a.id) : Number.POSITIVE_INFINITY;
          const ib = orderIndex.has(b.id) ? orderIndex.get(b.id) : Number.POSITIVE_INFINITY;
          if (ia !== ib) return ia - ib;
          if (b.created !== a.created) return b.created - a.created;
          return a.id < b.id ? 1 : -1;
        });

        const otherRoots = (othersRows?.results || []).map(r => ({
          id: r.id, url: r.url, nick: r.nick || "Anonymous", mail: r.mail || "", link: r.link || "",
          content: r.content, created: Number(r.created_at), top: !!r.top, status: "approved",
          pid: "", rid: "", locked: false,
          ip: r.ip || "", country: r.country || "", city: r.city || "", region: r.region || ""
        }));

        const roots = [...pinnedRoots, ...otherRoots];

        let replies = [];
        if (roots.length) {
          const rootIds = roots.map(r => String(r.id));
          const placeholders = rootIds.map((_, i) => `?${i + 2}`).join(",");
          const repliesRows = await env.DB.prepare(`
            SELECT id, url, nick, COALESCE(mail,'') AS mail, COALESCE(link,'') AS link,
                   content, created_at, COALESCE(top,0) AS top,
                   COALESCE(pid,'') AS pid, COALESCE(rid,'') AS rid,
                   COALESCE(ip,'') AS ip,
                   COALESCE(country,'') AS country,
                   COALESCE(city,'') AS city,
                   COALESCE(region,'') AS region
              FROM comments
             WHERE url = ?1
               AND id NOT LIKE 'cfg:%'
               AND rid IN (${placeholders})
          ORDER BY created_at ASC, id ASC
          `).bind(url, ...rootIds).all();

          replies = (repliesRows?.results || []).map(r => ({
            id: r.id, url: r.url, nick: r.nick || "Anonymous", mail: r.mail || "", link: r.link || "",
            content: r.content, created: Number(r.created_at), top: !!r.top, status: "approved",
            pid: r.pid || "", rid: r.rid || "", locked: false,
            ip: r.ip || "", country: r.country || "", city: r.city || "", region: r.region || ""
          }));
        }

        const lockedRows = await env.DB.prepare(
          `SELECT substr(id, 10) AS cid FROM comments WHERE url=?1 AND id LIKE 'cfg:lock:%'`
        ).bind(url).all();
        const lockedSet = new Set((lockedRows?.results || []).map(r => String(r.cid)));
        for (const r of roots) r.locked = lockedSet.has(r.id);

        const comments = [...roots, ...replies];

        const totalRow = await env.DB.prepare(
          `SELECT COUNT(*) AS c
             FROM comments
            WHERE url = ?1
              AND id NOT LIKE 'cfg:%'`
        ).bind(url).first();

        const rootsRow = await env.DB.prepare(
          `SELECT COUNT(*) AS c
             FROM comments
            WHERE url = ?1
              AND id NOT LIKE 'cfg:%'
              AND (rid = '' OR rid IS NULL)`
        ).bind(url).first();

        const pinnedRow = await env.DB.prepare(
          `SELECT COUNT(*) AS c
             FROM comments
            WHERE url = ?1
              AND id NOT LIKE 'cfg:%'
              AND top = 1
              AND (rid = '' OR rid IS NULL)`
        ).bind(url).first();

        const start = new Date(); start.setHours(0,0,0,0);
        const todayRow = await env.DB.prepare(
          `SELECT COUNT(*) AS c
             FROM comments
            WHERE url = ?1
              AND id NOT LIKE 'cfg:%'
              AND created_at >= ?2`
        ).bind(url, start.getTime()).first();

        const total = Number(totalRow?.c || 0);
        const rootsCount = Number(rootsRow?.c || 0);
        const counts = {
          total,
          tops: rootsCount,
          replies: Math.max(0, total - rootsCount),
          pinned: Number(pinnedRow?.c || 0),
          today: Number(todayRow?.c || 0)
        };

        return json({
          code: 0,
          data: {
            comments,
            hotComments: [],
            count: total,
            counts,
            page: Number(page) || 1,
            pageSize: ROOT_LIMIT
          }
        });
      } catch (e) {
        return json({ code: 500, message: `D1_ERROR: ${e.message || e}` }, 200);
      }
    }

    if (event === "UPLOAD_IMAGE") {
      const { photo, filename = "" } = body || {};
      if (typeof photo !== 'string' || !photo.startsWith('data:image/')) {
        return json({ code: 400, message: "Invalid image data" }, 400);
      }

      const IMGBB_KEY = env.IMGBB_KEY || "";
      if (!IMGBB_KEY) {
        return json({ code: 500, message: "Image hosting not configured (IMGBB_KEY missing)" }, 200);
      }

      // Strip "data:image/*;base64," prefix to get pure base64
      const base64 = photo.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
      // Compute decoded byte length safely from base64 length
      const padding = (base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0));
      const bytes = Math.floor((base64.length * 3) / 4) - padding;

      const MAX_BYTES = 7 * 1024 * 1024; // 7 MB
      if (bytes > MAX_BYTES) {
        return json({ code: 400, message: "Image too large (limit 7MB)" }, 200);
      }

      // Upload to ImgBB using server-side fetch (do NOT expose keys to client)
      try {
        const form = new FormData();
        form.append("image", base64);
        if (filename) form.append("name", String(filename).slice(0, 100));

        const resp = await fetch("https://api.imgbb.com/1/upload?key=" + encodeURIComponent(IMGBB_KEY), {
          method: "POST",
          body: form
        });

        const data = await resp.json().catch(() => null);

        if (!resp.ok || !data || !data.data || (!data.data.display_url && !data.data.url)) {
          const errMsg =
            (data && (data.error?.message || data.error?.title)) ||
            ("ImgBB upload failed with status " + resp.status);
          return json({ code: 500, message: "Image upload failed: " + errMsg }, 200);
        }

        const hostedUrl = data.data.display_url || data.data.url;
        return json({ code: 0, data: { url: hostedUrl } });
      } catch (e) {
        return json({ code: 500, message: "Image upload failed: " + (e && e.message ? e.message : e) }, 200);
      }
    }

    return json({ code: 400, message: "Unknown event" }, 400);
  }
}

/* ===== Durable Object: ChatRoom ===== */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // id -> WebSocket
    this.visitorCounts = new Map(); // vid -> open tab count
    this.socketVid = new Map();     // socket id -> vid
  }

  countTabs() {
    return this.sockets.size;
  }

  incVisitor(vid) {
    if (!vid) return;
    const cur = this.visitorCounts.get(vid) || 0;
    this.visitorCounts.set(vid, cur + 1);
  }

  decVisitor(vid) {
    if (!vid) return;
    const cur = this.visitorCounts.get(vid) || 0;
    if (cur <= 1) this.visitorCounts.delete(vid);
    else this.visitorCounts.set(vid, cur - 1);
  }

  broadcastPresence() {
    const users = this.visitorCounts.size;
    const tabs = this.countTabs();
    const payload = JSON.stringify({ type: 'presence', users, tabs });
    this.broadcast(payload);
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/notify') {
      const msg = await request.json().catch(()=>({ type:'refresh' }));
      this.broadcast(JSON.stringify(msg || { type:'refresh' }));
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      const id = Math.random().toString(36).slice(2);
      this.sockets.set(id, server);

      try {
        const users = this.visitorCounts.size;
        const tabs = this.countTabs();
        server.send(JSON.stringify({ type: 'hello', users, tabs }));
      } catch {}

      server.addEventListener('message', evt => {
        try {
          const raw = evt.data;
          const d = typeof raw === 'string' ? raw : String(raw || '');
          if (d === 'ping') { try { server.send('pong'); } catch {} return; }
          let msg = null;
          try { msg = JSON.parse(d); } catch { msg = null; }
          if (msg && msg.type === 'join' && typeof msg.vid === 'string' && msg.vid) {
            this.socketVid.set(id, msg.vid);
            this.incVisitor(msg.vid);
            this.broadcastPresence();
            return;
          }
          if (msg && msg.type === 'leave') {
            const vid = (typeof msg.vid === 'string' && msg.vid) ? msg.vid : this.socketVid.get(id);
            if (vid) {
              this.decVisitor(vid);
              this.socketVid.delete(id);
              this.broadcastPresence();
            }
            return;
          }
        } catch {}
      });

      const cleanup = () => {
        this.sockets.delete(id);
        const vid = this.socketVid.get(id);
        if (vid) {
          this.socketVid.delete(id);
          this.decVisitor(vid);
          this.broadcastPresence();
        }
      };
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  broadcast(payload) {
    for (const [id, ws] of this.sockets) {
      try { ws.send(payload); } catch { this.sockets.delete(id); }
    }
  }
}