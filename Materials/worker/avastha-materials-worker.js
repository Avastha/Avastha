/* Avastha Materials worker — auth + R2 asset storage for avastha.info/Materials.
   Same pattern as the cue-counter relay: a Cloudflare Worker that keeps every
   secret OFF the public repo.

   What it does:
   1) AUTH: user registry (salted PBKDF2 password hashes) + session tokens live
      in Cloudflare KV. Login, change-password and logout all verify here —
      the browser never sees a hash. The registry seeds itself on first login
      from the DEFAULT_PASS variable (so no password ever appears in this file).
   2) ASSETS: lists / uploads / deletes objects in the R2 bucket under the four
      category folders — logos/, images/, videos/, artwork/. Listing is public
      (the site needs it to render); upload and delete require a valid session
      token. Files are served to visitors straight from the bucket's public
      r2.dev URL, not through this worker.

   Setup (one time, dash.cloudflare.com):
   A. Storage & Databases → KV → Create namespace → name: avastha-auth
   B. Workers & Pages → Create → Worker → name it exactly: materials
      (that makes the URL https://materials.avastha-music.workers.dev,
      which is what Materials/index.html expects) → paste this whole file
      as the worker code → Deploy.
   C. Worker → Settings → Bindings → Add:
        KV namespace  → Variable name: AUTH_KV          → Namespace: avastha-auth
        R2 bucket     → Variable name: MATERIALS_BUCKET → your public bucket
   D. Worker → Settings → Variables and Secrets → Add:
        DEFAULT_PASS (type Secret) = the initial admin password.
        Used only to create the "avastha" user on the very first login;
        after you change the password on the site it is ignored.
        ALLOW_ORIGIN (optional, plain text) = https://avastha.info  (* if unset)
   E. R2 bucket → Settings → CORS policy → add (lets the site fetch files
      for the download / zip buttons; the bucket is already public-read):
        [
          {
            "AllowedOrigins": ["*"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["*"],
            "MaxAgeSeconds": 3600
          }
        ]

   Forgot the password? Delete the "registry" key in the KV namespace —
   the next login re-seeds it from DEFAULT_PASS.
*/

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv', '.ogv', '.3gp'];
const CATEGORIES = {
  'logos/':   IMAGE_EXTS,
  'images/':  IMAGE_EXTS,
  'videos/':  VIDEO_EXTS,
  'artwork/': IMAGE_EXTS.concat(VIDEO_EXTS)
};
const PBKDF2_ITER = 100000;           // Workers cap PBKDF2 at 100k iterations
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const MAX_UPLOAD = 95 * 1024 * 1024;       // per-request cap (Cloudflare edge limit)
const MAX_TOTAL = 3 * 1024 * 1024 * 1024;  // 3 GB per file via multipart

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };
    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200, headers: { 'Content-Type': 'application/json', ...cors }
    });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      const url = new URL(req.url);

      /* ---------------- public file read: GET /file?key=<category>/name.ext ----------------
         The site's "Download All" zip fetches through here instead of the public
         r2.dev URL, because r2.dev rate-limits bursts of requests. The bucket is
         public-read anyway, so no auth is needed. */
      if (req.method === 'GET' && url.pathname === '/file') {
        if (!env.MATERIALS_BUCKET) return json({ ok: false, message: 'MATERIALS_BUCKET not bound' }, 500);
        const key = url.searchParams.get('key') || '';
        if (!validKey(key)) return json({ ok: false, message: 'bad key' }, 400);
        const obj = await env.MATERIALS_BUCKET.get(key);
        if (!obj) return json({ ok: false, message: 'not found' }, 404);
        return new Response(obj.body, {
          headers: {
            ...cors,
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
            'Content-Length': String(obj.size),
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      if (req.method !== 'POST') return json({ message: 'POST only' }, 405);

      /* ---------------- multipart upload: big files (≤3 GB) arrive in ~50 MB parts ----------------
         POST /mpu/create?key=&size=&type=  →  { uploadId }
         POST /mpu/part?key=&uploadId=&part=N   (raw body)  →  { part, etag }
         POST /mpu/complete?key=&uploadId=      body {parts:[{partNumber,etag}]}
         POST /mpu/abort?key=&uploadId=                                            */
      if (url.pathname.startsWith('/mpu/')) {
        if (!env.MATERIALS_BUCKET) return json({ ok: false, message: 'MATERIALS_BUCKET not bound' }, 500);
        const user = await sessionUser(env, bearerToken(req));
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const key = url.searchParams.get('key') || '';
        if (!validKey(key)) return json({ ok: false, message: 'bad key' }, 400);
        const action = url.pathname.slice(5);
        if (action === 'create') {
          const size = parseInt(url.searchParams.get('size') || '0', 10);
          if (!(size > 0) || size > MAX_TOTAL) return json({ ok: false, message: 'file too large (max 3 GB)' }, 413);
          const mpu = await env.MATERIALS_BUCKET.createMultipartUpload(key, {
            httpMetadata: { contentType: url.searchParams.get('type') || 'application/octet-stream' }
          });
          return json({ ok: true, uploadId: mpu.uploadId });
        }
        const uploadId = url.searchParams.get('uploadId') || '';
        if (!uploadId || uploadId.length > 512) return json({ ok: false, message: 'uploadId required' }, 400);
        const mpu = env.MATERIALS_BUCKET.resumeMultipartUpload(key, uploadId);
        if (action === 'part') {
          const part = parseInt(url.searchParams.get('part') || '0', 10);
          if (!(part >= 1) || part > 1024) return json({ ok: false, message: 'bad part number' }, 400);
          const len = parseInt(req.headers.get('Content-Length') || '0', 10);
          if (len > MAX_UPLOAD) return json({ ok: false, message: 'part too large' }, 413);
          const p = await mpu.uploadPart(part, req.body);
          return json({ ok: true, part: p.partNumber, etag: p.etag });
        }
        if (action === 'complete') {
          let body; try { body = await req.json(); } catch { return json({ ok: false, message: 'bad json' }, 400); }
          const parts = Array.isArray(body && body.parts) ? body.parts : null;
          if (!parts || !parts.length || parts.length > 1024) return json({ ok: false, message: 'bad parts' }, 400);
          await mpu.complete(parts);
          return json({ ok: true, key });
        }
        if (action === 'abort') { try { await mpu.abort(); } catch {} return json({ ok: true }); }
        return json({ ok: false, message: 'bad action' }, 400);
      }

      /* ---------------- binary upload: POST /upload?key=<category>/name.ext ---------------- */
      if (url.pathname === '/upload') {
        if (!env.MATERIALS_BUCKET) return json({ ok: false, message: 'MATERIALS_BUCKET not bound' }, 500);
        const user = await sessionUser(env, bearerToken(req));
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const key = url.searchParams.get('key') || '';
        if (!validKey(key)) return json({ ok: false, message: 'bad key (category folder + matching file type)' }, 400);
        const len = parseInt(req.headers.get('Content-Length') || '0', 10);
        if (len > MAX_UPLOAD) return json({ ok: false, message: 'file too large (max ~95 MB per upload)' }, 413);
        await env.MATERIALS_BUCKET.put(key, req.body, {
          httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' }
        });
        return json({ ok: true, key });
      }

      /* ---------------- JSON ops ---------------- */
      let b;
      try { b = await req.json(); } catch { return json({ message: 'bad json' }, 400); }
      const op = b && b.op;
      const token = bearerToken(req) || String((b && b.token) || '');

      if (op === 'debug') {
        const reg = await getRegistry(env);
        return json({
          version: 'v2.4', hasKV: !!env.AUTH_KV, hasBucket: !!env.MATERIALS_BUCKET,
          hasDefaultPass: !!env.DEFAULT_PASS, seeded: !!reg
        });
      }

      if (op === 'list') {
        if (!env.MATERIALS_BUCKET) return json({ ok: false, message: 'MATERIALS_BUCKET not bound' }, 500);
        let previews = {};
        if (env.AUTH_KV) { try { previews = JSON.parse(await env.AUTH_KV.get('previews')) || {}; } catch {} }
        const categories = {};
        for (const prefix of Object.keys(CATEGORIES)) {
          const exts = CATEGORIES[prefix];
          const files = [];
          let cursor;
          do {
            const page = await env.MATERIALS_BUCKET.list({ prefix, cursor });
            for (const o of page.objects) {
              const name = o.key.slice(prefix.length);
              if (!name || name.includes('/')) continue;
              if (!exts.some(e => name.toLowerCase().endsWith(e))) continue;
              files.push({ key: o.key, name, size: o.size, uploaded: o.uploaded, preview: previews[o.key] });
            }
            cursor = page.truncated ? page.cursor : null;
          } while (cursor);
          files.sort((a, b2) => a.name.localeCompare(b2.name, undefined, { numeric: true }));
          const cat = prefix.slice(0, -1);
          /* apply the admin-saved display order; unknown files keep name order at the end */
          if (env.AUTH_KV) {
            const saved = await env.AUTH_KV.get('order:' + cat);
            if (saved) {
              try {
                const pos = new Map(JSON.parse(saved).map((k, i) => [k, i]));
                files.sort((x, y) => {
                  const px = pos.has(x.key) ? pos.get(x.key) : 1e9;
                  const py = pos.has(y.key) ? pos.get(y.key) : 1e9;
                  return (px - py) || x.name.localeCompare(y.name, undefined, { numeric: true });
                });
              } catch {}
            }
          }
          categories[cat] = files;
        }
        return json({ ok: true, categories });
      }

      if (op === 'setorder') {
        if (!env.AUTH_KV) return json({ ok: false, message: 'AUTH_KV not bound' }, 500);
        const user = await sessionUser(env, token);
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const cat = String(b.cat || '');
        if (!CATEGORIES[cat + '/']) return json({ ok: false, message: 'bad category' }, 400);
        const keys = Array.isArray(b.keys) ? b.keys.filter(k => typeof k === 'string' && validKey(k)) : null;
        if (!keys || keys.length > 500) return json({ ok: false, message: 'bad keys' }, 400);
        await env.AUTH_KV.put('order:' + cat, JSON.stringify(keys));
        return json({ ok: true });
      }

      if (op === 'login') {
        if (!env.AUTH_KV) return json({ ok: false, message: 'AUTH_KV not bound' }, 500);
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        const failKey = 'fail:' + ip;
        const fails = parseInt((await env.AUTH_KV.get(failKey)) || '0', 10);
        if (fails >= 8) return json({ ok: false, message: 'too many attempts — try again in 10 minutes' }, 429);
        const reg = await getOrSeedRegistry(env);
        if (!reg) return json({ ok: false, message: 'not configured: set the DEFAULT_PASS variable' }, 500);
        const id = String(b.user || '').trim().toLowerCase();
        const u = reg.users.find(x => x.id === id);
        if (u && await verifyPass(String(b.pass || ''), u.salt, u.hash, reg)) {
          const tok = await newSession(env, u.id);
          return json({ ok: true, token: tok, user: { id: u.id, label: u.label } });
        }
        await env.AUTH_KV.put(failKey, String(fails + 1), { expirationTtl: 600 });
        return json({ ok: false, message: 'wrong username or password' });
      }

      if (op === 'check') {
        const user = await sessionUser(env, token);
        return json({ ok: !!user, user: user || undefined });
      }

      if (op === 'logout') {
        if (env.AUTH_KV && token) await env.AUTH_KV.delete('token:' + token);
        return json({ ok: true });
      }

      if (op === 'changepass') {
        const user = await sessionUser(env, token);
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const reg = await getRegistry(env);
        const u = reg && reg.users.find(x => x.id === user);
        if (!u || !(await verifyPass(String(b.oldPass || ''), u.salt, u.hash, reg)))
          return json({ ok: false, message: 'current password is incorrect' }, 403);
        const np = String(b.newPass || '');
        if (np.length < 6) return json({ ok: false, message: 'new password too short (min 6 characters)' }, 400);
        const cred = await makeCred(np, reg);
        u.salt = cred.salt; u.hash = cred.hash;
        await putRegistry(env, reg);
        await deleteAllSessions(env);            // sign out every device…
        const tok = await newSession(env, user); // …but keep this one signed in
        return json({ ok: true, token: tok });
      }

      /* admin: choose which moment of a video is its thumbnail frame */
      if (op === 'setpreview') {
        if (!env.AUTH_KV) return json({ ok: false, message: 'AUTH_KV not bound' }, 500);
        const user = await sessionUser(env, token);
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const key = String(b.key || '');
        const t = Number(b.t);
        if (!validKey(key) || !(t >= 0) || t > 86400) return json({ ok: false, message: 'bad request' }, 400);
        let previews = {};
        try { previews = JSON.parse(await env.AUTH_KV.get('previews')) || {}; } catch {}
        previews[key] = Math.round(t * 10) / 10;
        await env.AUTH_KV.put('previews', JSON.stringify(previews));
        return json({ ok: true });
      }

      if (op === 'delete') {
        if (!env.MATERIALS_BUCKET) return json({ ok: false, message: 'MATERIALS_BUCKET not bound' }, 500);
        const user = await sessionUser(env, token);
        if (!user) return json({ ok: false, message: 'unauthorized' }, 401);
        const key = String(b.key || '');
        if (!validKey(key)) return json({ ok: false, message: 'bad key' }, 400);
        await env.MATERIALS_BUCKET.delete(key);
        if (env.AUTH_KV) {
          try {
            const p = JSON.parse(await env.AUTH_KV.get('previews')) || {};
            if (key in p) { delete p[key]; await env.AUTH_KV.put('previews', JSON.stringify(p)); }
          } catch {}
        }
        return json({ ok: true });
      }

      return json({ message: 'bad op' }, 400);
    } catch (e) {
      return json({ message: 'worker error: ' + ((e && e.message) || String(e)) }, 500);
    }
  }
};

/* ---------------- keys ---------------- */
function validKey(k) {
  if (typeof k !== 'string' || k.length > 180) return false;
  const prefix = Object.keys(CATEGORIES).find(p => k.startsWith(p));
  if (!prefix) return false;
  const name = k.slice(prefix.length);
  if (!name || name.includes('/') || name.includes('..')) return false;
  if (!/^[\w .,()&+'\-\[\]]+$/.test(name)) return false;
  return CATEGORIES[prefix].some(e => name.toLowerCase().endsWith(e));
}

/* ---------------- sessions (KV, auto-expiring) ---------------- */
function bearerToken(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function newSession(env, user) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const tok = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  await env.AUTH_KV.put('token:' + tok, JSON.stringify({ user }), { expirationTtl: SESSION_TTL });
  return tok;
}
async function sessionUser(env, token) {
  if (!env.AUTH_KV || !token || token.length < 32) return null;
  const s = await env.AUTH_KV.get('token:' + token);
  if (!s) return null;
  try { return JSON.parse(s).user; } catch { return null; }
}
async function deleteAllSessions(env) {
  let cursor;
  do {
    const page = await env.AUTH_KV.list({ prefix: 'token:', cursor });
    for (const k of page.keys) await env.AUTH_KV.delete(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

/* ---------------- registry (users + hashes in KV) ---------------- */
async function getRegistry(env) {
  if (!env.AUTH_KV) return null;
  const s = await env.AUTH_KV.get('registry');
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function putRegistry(env, reg) { return env.AUTH_KV.put('registry', JSON.stringify(reg)); }
async function getOrSeedRegistry(env) {
  let reg = await getRegistry(env);
  if (reg) return reg;
  if (!env.AUTH_KV || !env.DEFAULT_PASS) return null;
  reg = { kdf: { iterations: PBKDF2_ITER }, users: [] };
  const cred = await makeCred(env.DEFAULT_PASS, reg);
  reg.users.push({ id: 'avastha', label: 'Avastha', admin: true, ...cred });
  await putRegistry(env, reg);
  return reg;
}

/* ---------------- crypto ---------------- */
function iterOf(reg) { return (reg && reg.kdf && reg.kdf.iterations) || PBKDF2_ITER; }
async function verifyPass(pass, saltB64, hashB64, reg) {
  if (typeof pass !== 'string' || !pass || !saltB64 || !hashB64) return false;
  const got = await pbkdf2b64(pass, saltB64, iterOf(reg));
  return timingEq(got, hashB64);
}
async function makeCred(pass, reg) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = btoa(String.fromCharCode(...saltBytes));
  return { salt, hash: await pbkdf2b64(pass, salt, iterOf(reg)) };
}
async function pbkdf2b64(pass, saltB64, iterations) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, km, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
function timingEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
