// Decrypts the portfolio on the fly. Every file on the server is AES-GCM ciphertext;
// the key is derived in the page from the access code and stored (non-extractable) in IndexedDB.
const DB = "an-site", STORE = "k";
let keyP = null, siteP = null;
const vids = new Map(); // small in-memory cache of decrypted videos (range requests)

const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async k => { const db = await idb(); return new Promise(res => { const t = db.transaction(STORE).objectStore(STORE).get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); }); };
const idbDel = async k => { const db = await idb(); return new Promise(res => { const t = db.transaction(STORE, "readwrite").objectStore(STORE).delete(k); t.onsuccess = t.onerror = () => res(); }); };

const getKey = () => keyP || (keyP = idbGet("key").then(k => k || null));
const decrypt = async (key, buf) => crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(buf, 0, 12) }, key, new Uint8Array(buf, 12));
const site = key => siteP || (siteP = (async () => {
  const r = await fetch("c/site.bin", { cache: "no-cache" });
  const pt = await decrypt(key, await r.arrayBuffer());
  return JSON.parse(new TextDecoder().decode(pt));
})().catch(e => { siteP = null; throw e; }));

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("message", e => { if (e.data === "reset") { keyP = null; siteP = null; vids.clear(); } });

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const path = url.pathname.replace(/^\//, "");
  if (req.mode === "navigate" && (path === "" || path === "index.html")) { e.respondWith(page(req)); return; }
  if (/^(img|video)\//.test(path)) e.respondWith(asset(req, path));
});

async function page(req) {
  try {
    const key = await getKey(); if (!key) return fetch(req);
    const s = await site(key);
    return new Response(s.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch (_) { keyP = null; siteP = null; await idbDel("key"); return fetch(req); }
}

async function plain(path) {
  const key = await getKey(); if (!key) return null;
  const s = await site(key); const ent = s.map[path]; if (!ent) return null;
  const isVid = ent[1].startsWith("video/");
  if (isVid && vids.has(path)) return [vids.get(path), ent[1]];
  const r = await fetch("c/" + ent[0]); if (!r.ok) return null;
  const pt = await decrypt(key, await r.arrayBuffer());
  if (isVid) { vids.set(path, pt); while (vids.size > 3) vids.delete(vids.keys().next().value); }
  return [pt, ent[1]];
}

async function asset(req, path) {
  let got; try { got = await plain(path); } catch (_) { got = null; }
  if (!got) return new Response("Not found", { status: 404 });
  const [buf, type] = got; const size = buf.byteLength;
  const range = req.headers.get("range"); const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (!m || (m[1] === "" && m[2] === "")) return new Response(buf, { status: 200, headers: { ...base, "content-length": String(size) } });
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
}
