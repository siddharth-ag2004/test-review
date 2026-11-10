// One storage interface, two backends:
//  - Supabase (cloud: login + database + file storage) when config.js has keys
//  - IndexedDB (this browser only) otherwise
//
// Test shape: { id, title, subject, date, items: [ { id, q, status, note, hide, crop:{x,y,w,h}, imgPath } ] }
// imgPath is the key of the (already rotated) photo; crop is a fraction of that photo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const BUCKET = "test-images";
const cloud = !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
const sb = cloud ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/* ---------------- IndexedDB backend ---------------- */
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("test-review", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("tests", { keyPath: "id" });
        r.result.createObjectStore("images");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

const local = {
  async listTests() {
    const all = (await tx("tests", "readonly", (s) => s.getAll())) || [];
    return all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },
  async getTest(id) {
    return tx("tests", "readonly", (s) => s.get(id));
  },
  async saveTest(test, blobs) {
    for (const [path, blob] of Object.entries(blobs)) await tx("images", "readwrite", (s) => s.put(blob, path));
    test.updated = Date.now();
    await tx("tests", "readwrite", (s) => s.put(test));
  },
  async deleteTest(id) {
    const t = await this.getTest(id);
    if (t) for (const it of t.items) await tx("images", "readwrite", (s) => s.delete(it.imgPath));
    await tx("tests", "readwrite", (s) => s.delete(id));
  },
  async getImage(path) {
    return tx("images", "readonly", (s) => s.get(path));
  },
  async removeImages(paths) {
    for (const p of paths) await tx("images", "readwrite", (s) => s.delete(p));
  },
};

/* ---------------- Supabase backend ---------------- */
const remote = {
  async listTests() {
    const { data, error } = await sb.from("tests").select("*").order("updated", { ascending: false });
    if (error) throw error;
    return data;
  },
  async getTest(id) {
    const { data, error } = await sb.from("tests").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },
  async saveTest(test, blobs) {
    for (const [path, blob] of Object.entries(blobs)) {
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (error) throw error;
    }
    const { error } = await sb.from("tests").upsert({ ...test, updated: Date.now() });
    if (error) throw error;
  },
  async deleteTest(id) {
    const t = await this.getTest(id);
    if (t && t.items.length) await sb.storage.from(BUCKET).remove(t.items.map((i) => i.imgPath));
    const { error } = await sb.from("tests").delete().eq("id", id);
    if (error) throw error;
  },
  async getImage(path) {
    const { data, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw error;
    return data;
  },
  async removeImages(paths) {
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  },
};

const backend = cloud ? remote : local;

export const store = {
  isCloud: cloud,
  listTests: () => backend.listTests(),
  getTest: (id) => backend.getTest(id),
  saveTest: (t, blobs) => backend.saveTest(t, blobs),
  deleteTest: (id) => backend.deleteTest(id),
  getImage: (p) => backend.getImage(p),
  removeImages: (p) => backend.removeImages(p),

  async getSession() {
    if (!cloud) return { local: true };
    const { data } = await sb.auth.getSession();
    return data.session;
  },
  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signOut() {
    if (cloud) await sb.auth.signOut();
  },
};
