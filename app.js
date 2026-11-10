import { store, uid } from "./store.js";
import { loadPhoto, rotateCanvas, canvasToBlob, renderCrop, analyze, clampCrop } from "./ocr.js";
import { buildDocx, STATUSES, byQ } from "./docx-builder.js";

const $ = (s) => document.querySelector(s);
const view = $("#view");

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3500);
}

const today = () => new Date().toLocaleDateString("en-CA");
const safeName = (s) => (s || "Test").replace(/[\\/:*?"<>|]+/g, "-").trim();

function saveBlob(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

async function testToDocx(test, canvasFor) {
  return buildDocx(test, async (it) => {
    const src = await canvasFor(it);
    const c = renderCrop(src, it.crop, it.hide ? it.answerBox : null);
    const blob = await canvasToBlob(c, 0.9);
    return { data: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
  });
}

/* ---------------- routing ---------------- */
let cleanup = () => {};
async function route() {
  cleanup();
  cleanup = () => {};
  const hash = location.hash.slice(1) || "/";
  const session = await store.getSession();
  renderNav(session);
  if (!session) return showLogin();
  if (hash === "/new") return showEditor(null);
  const m = hash.match(/^\/test\/(.+)$/);
  if (m) return showEditor(m[1]);
  return showLibrary();
}
window.addEventListener("hashchange", route);

function renderNav(session) {
  const nav = $("#nav");
  nav.replaceChildren();
  if (!session) return;
  if (session.local) nav.append(h("span", { class: "badge", title: "Not signed in: tests are stored in this browser only" }, "this device only"));
  nav.append(h("a", { class: "btn", href: "#/" }, "Library"), h("a", { class: "btn primary", href: "#/new" }, "+ New test"));
  if (store.isCloud)
    nav.append(h("button", { onclick: async () => { await store.signOut(); route(); } }, "Sign out"));
}

/* ---------------- login ---------------- */
function showLogin() {
  const err = h("div", { class: "warn" });
  const email = h("input", { type: "email", placeholder: "Email", required: true, autocomplete: "username" });
  const pw = h("input", { type: "password", placeholder: "Password", required: true, autocomplete: "current-password" });
  const form = h("form", { class: "login", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    try { await store.signIn(email.value.trim(), pw.value); location.hash = "#/"; route(); }
    catch (ex) { err.textContent = ex.message || "Could not sign in"; }
  } }, h("h2", {}, "Sign in"), email, pw, h("button", { class: "primary" }, "Sign in"), err);
  view.replaceChildren(form);
}

/* ---------------- library ---------------- */
async function showLibrary() {
  view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let tests;
  try { tests = await store.listTests(); }
  catch (e) { view.replaceChildren(h("p", { class: "warn" }, "Could not load tests: " + (e.message || e))); return; }

  let filter = "All";
  const draw = () => {
    const subjects = ["All", ...new Set(tests.map((t) => t.subject).filter(Boolean))];
    const chips = h("div", { class: "chips" }, subjects.map((s) =>
      h("button", { class: "chip" + (s === filter ? " on" : ""), onclick: () => { filter = s; draw(); } }, s)));
    const shown = tests.filter((t) => filter === "All" || t.subject === filter);
    const list = h("div", { class: "list" }, shown.length ? shown.map(testRow) :
      h("p", { class: "muted" }, tests.length ? "No tests for this subject." : "No tests yet. Click “+ New test” to make the first one."));
    view.replaceChildren(h("h2", {}, "Previous tests"), tests.length > 0 && chips, list);
  };

  const testRow = (t) => {
    const n = (k) => t.items.filter((i) => i.status === k).length;
    const dl = h("button", { onclick: async () => {
      dl.disabled = true; dl.textContent = "Building…";
      try {
        const full = await store.getTest(t.id);
        const blob = await testToDocx(full, async (it) => loadPhoto(await store.getImage(it.imgPath)));
        saveBlob(blob, safeName(full.title) + ".docx");
      } catch (e) { toast("Could not build: " + (e.message || e)); }
      dl.disabled = false; dl.textContent = "⬇ Word doc";
    } }, "⬇ Word doc");
    return h("div", { class: "test" },
      h("div", {},
        h("h3", {}, t.title),
        h("div", { class: "muted" }, [t.subject, t.date].filter(Boolean).join(" · ")),
        h("div", { class: "counts" }, STATUSES.map((s) => h("span", {}, h("i", { class: "dot " + s.key }), `${s.label} ${n(s.key)}`)))),
      h("div", { class: "row" }, dl,
        h("a", { class: "btn", href: "#/test/" + t.id }, "✎ Open / edit"),
        h("button", { class: "danger", onclick: async () => {
          if (!confirm(`Delete “${t.title}” permanently? This cannot be undone.`)) return;
          try { await store.deleteTest(t.id); tests = tests.filter((x) => x.id !== t.id); draw(); toast("Deleted"); }
          catch (e) { toast("Could not delete: " + (e.message || e)); }
        } }, "Delete")));
  };
  draw();
}

/* ---------------- editor ---------------- */
let st;

function newItem(canvas) {
  return { id: uid(), q: "", status: null, note: "", hide: false, crop: { x: 0, y: 0, w: 1, h: 1 }, answerBox: null,
    canvas, dirty: true, busy: false, thumb: null, noSol: false, imgPath: null };
}

async function showEditor(id) {
  st = { id, title: "", subject: "Chemistry", date: today(), items: [], sel: 0, removedPaths: [], changed: false, saving: false };

  if (id) {
    view.replaceChildren(h("p", { class: "muted" }, "Loading test…"));
    try {
      const t = await store.getTest(id);
      Object.assign(st, { title: t.title, subject: t.subject || "Chemistry", date: t.date || today() });
      for (const it of t.items) {
        const canvas = await loadPhoto(await store.getImage(it.imgPath));
        st.items.push({ ...it, q: it.q ?? "", note: it.note || "", hide: !!it.hide, canvas, dirty: false, busy: false, thumb: null, noSol: false });
      }
    } catch (e) { view.replaceChildren(h("p", { class: "warn" }, "Could not open this test: " + (e.message || e))); return; }
  }

  const title = h("input", { name: "title", placeholder: "Title, e.g. 9 Nov Chem ADV SC P1", value: st.title, oninput: (e) => { st.title = e.target.value; st.changed = true; } });
  const subject = h("select", { onchange: (e) => (st.subject = e.target.value) },
    ["Chemistry", "Maths", "Physics", "Other"].map((s) => h("option", { value: s, selected: s === st.subject }, s)));
  const date = h("input", { type: "date", value: st.date, onchange: (e) => (st.date = e.target.value) });
  const file = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: () => { addFiles([...file.files]); file.value = ""; } });
  const drop = h("div", { class: "drop",
    onclick: () => file.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); },
  }, "📷 Drop the photos here, or click to choose them (any order)");
  const summary = h("div", { class: "summary" });
  const cards = h("div", { class: "cards" });
  st.ui = { cards, summary };

  view.replaceChildren(
    h("h2", {}, id ? "Edit test" : "New test"),
    h("div", { class: "meta" }, title, subject, date),
    drop, file, summary, cards);

  const onKey = (e) => {
    if (!$("#modal").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === "1" || k === "2" || k === "3") { e.preventDefault(); setStatus(st.items[st.sel], STATUSES[+k - 1].key, true); }
    else if (k === "ArrowDown" || k === "ArrowRight") { e.preventDefault(); select(st.sel + 1); }
    else if (k === "ArrowUp" || k === "ArrowLeft") { e.preventDefault(); select(st.sel - 1); }
  };
  const onUnload = (e) => { if (st.changed) { e.preventDefault(); e.returnValue = ""; } };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", onUnload);
  cleanup = () => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onUnload);
    $("#modal").hidden = true;
  };
  renderCards();
}

async function addFiles(files) {
  const fresh = [];
  const imgs = files.filter((f) => f.type.startsWith("image/")).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!imgs.length) return;
  toast("Reading photos… the first time can take a minute");
  for (const f of imgs) {
    try { const it = newItem(await loadPhoto(f)); it.busy = true; st.items.push(it); fresh.push(it); }
    catch { toast("Could not open " + f.name); }
  }
  st.changed = true;
  renderCards();
  for (const it of fresh) await runAnalysis(it);
}

async function runAnalysis(it, auto = true) {
  it.busy = true;
  refreshCard(it);
  try {
    const r = await analyze(it.canvas, { autoRotate: auto });
    if (r.canvas !== it.canvas) it.dirty = true;
    it.canvas = r.canvas;
    it.crop = r.crop;
    it.answerBox = r.answerBox;
    it.noSol = !r.foundSolution;
    if (r.q != null && it.q === "") { it.q = String(r.q); it.qGuess = true; }
  } catch (e) { console.error(e); toast("Could not read a photo's text. Adjust its crop by hand."); it.noSol = true; }
  it.busy = false;
  it.thumb = null;
  refreshCard(it);
}

function thumbCanvas(it) {
  if (!it.thumb) {
    const c = renderCrop(it.canvas, it.crop, it.hide ? it.answerBox : null);
    const s = Math.min(1, 560 / c.width);
    const t = document.createElement("canvas");
    t.width = Math.round(c.width * s);
    t.height = Math.round(c.height * s);
    t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
    it.thumb = t;
  }
  return it.thumb;
}

function cardEl(it) {
  const i = st.items.indexOf(it);
  const card = h("div", { class: `card${i === st.sel ? " sel" : ""} s-${it.status || "none"}`, "data-id": it.id, onpointerdown: () => select(st.items.indexOf(it), false) });
  const thumb = h("div", { class: "thumb", title: "Click to adjust the crop", onclick: () => openCrop(it) }, thumbCanvas(it), it.busy && h("div", { class: "busy" }, "Reading…"));
  const q = h("input", { class: "q", placeholder: "Q#", value: it.q, inputmode: "numeric", onchange: (e) => { it.q = e.target.value.trim(); it.qGuess = false; q.classList.remove("guess"); st.changed = true; updateSummary(); } });
  if (it.qGuess) { q.classList.add("guess"); q.title = "Read automatically. Please check it matches the photo."; }
  const note = h("input", { class: "note", placeholder: "Note (optional), e.g. Surbhi Ans: 3, Correct Ans: 1", value: it.note, onchange: (e) => { it.note = e.target.value; st.changed = true; } });
  const seg = h("div", { class: "seg" }, STATUSES.map((s, n) =>
    h("button", { class: it.status === s.key ? "on" : "", "data-s": s.key, onclick: () => setStatus(it, s.key, true) }, s.label, " ", h("kbd", {}, n + 1))));
  const tools = h("div", { class: "tools" },
    h("button", { title: "Rotate left (90°)", onclick: () => rotateItem(it, 270) }, "⟲ Rotate left"),
    h("button", { title: "Rotate right (90°)", onclick: () => rotateItem(it, 90) }, "⟳ Rotate right"),
    h("button", { title: "Turn upside-down photo the right way up", onclick: () => rotateItem(it, 180) }, "⇅ Flip 180°"),
    h("button", { onclick: () => openCrop(it) }, "✂ Adjust crop"),
    it.answerBox && h("label", { class: "muted" }, h("input", { type: "checkbox", checked: it.hide, onchange: (e) => { it.hide = e.target.checked; it.thumb = null; st.changed = true; refreshCard(it); } }), " hide “Correct answer”"),
    h("button", { class: "danger", onclick: () => removeItem(it) }, "🗑"));
  card.append(thumb, h("div", { class: "ctl" },
    h("div", { class: "qrow" }, h("b", {}, "Q"), q, note),
    seg, tools,
    it.noSol && !it.busy && h("div", { class: "warn" }, "Couldn’t find the word “Solution”. Please check the crop.")));
  return card;
}

// Manual rotation: apply exactly what was asked (no auto-rotate afterwards), then re-suggest the crop.
async function rotateItem(it, deg, reopenCrop = false) {
  it.canvas = rotateCanvas(it.canvas, deg);
  it.dirty = true;
  it.crop = { x: 0, y: 0, w: 1, h: 1 };
  it.answerBox = null;
  it.hide = false;
  it.thumb = null;
  st.changed = true;
  await runAnalysis(it, false);
  if (reopenCrop) openCrop(it);
}

function refreshCard(it) {
  const old = st.ui.cards.querySelector(`[data-id="${it.id}"]`);
  if (!old) return;
  old.replaceWith(cardEl(it));
  updateSummary();
}

function renderCards() {
  st.ui.cards.replaceChildren(...st.items.map(cardEl));
  updateSummary();
}

function updateSummary() {
  const n = (k) => st.items.filter((i) => i.status === k).length;
  const missing = st.items.filter((i) => !i.status).length;
  const left = h("div", {}, `${st.items.length} photo${st.items.length === 1 ? "" : "s"}  ·  `,
    STATUSES.map((s) => h("span", {}, h("i", { class: "dot " + s.key }), `${s.label} ${n(s.key)}   `)),
    missing > 0 && h("span", { class: "warn" }, `· ${missing} need a status`));
  const dl = h("button", { disabled: !st.items.length, onclick: downloadCurrent }, "⬇ Download Word doc");
  const save = h("button", { class: "primary", disabled: !st.items.length || st.saving, onclick: save_ }, "💾 Save to library");
  st.ui.summary.replaceChildren(left, h("div", { class: "row" }, dl, save));
}

function select(i, scroll = true) {
  if (!st.items.length) return;
  st.sel = Math.max(0, Math.min(st.items.length - 1, i));
  st.ui.cards.querySelectorAll(".card").forEach((el, n) => el.classList.toggle("sel", n === st.sel));
  if (scroll) st.ui.cards.children[st.sel]?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function setStatus(it, key, advance = false) {
  if (!it) return;
  it.status = key;
  st.changed = true;
  refreshCard(it);
  if (advance) select(st.items.indexOf(it) + 1);
}

function removeItem(it) {
  if (it.imgPath) st.removedPaths.push(it.imgPath);
  st.items.splice(st.items.indexOf(it), 1);
  st.sel = Math.min(st.sel, Math.max(0, st.items.length - 1));
  st.changed = true;
  renderCards();
}

function confirmMissingQ() {
  const n = st.items.filter((i) => i.q === "" || i.q == null).length;
  return !n || confirm(`${n} photo${n === 1 ? " has" : "s have"} no Q number. They will appear without a number, after the numbered ones. Continue anyway?`);
}

async function downloadCurrent() {
  if (!confirmMissingQ()) return;
  try {
    toast("Building Word doc…");
    const test = { title: st.title || `${st.subject} ${st.date}`, items: st.items };
    const blob = await testToDocx(test, async (it) => it.canvas);
    saveBlob(blob, safeName(test.title) + ".docx");
  } catch (e) { console.error(e); toast("Could not build: " + (e.message || e)); }
}

async function save_() {
  if (st.saving) return;
  const missing = st.items.filter((i) => !i.status).length;
  if (missing) return toast(`${missing} photo(s) still need a status`);
  if (!confirmMissingQ()) return;
  st.saving = true;
  updateSummary();
  try {
    const id = st.id || uid();
    const blobs = {};
    const items = [];
    for (const it of st.items) {
      if (!it.imgPath) it.imgPath = `${id}/${it.id}.jpg`;
      if (it.dirty) blobs[it.imgPath] = await canvasToBlob(it.canvas);
      items.push({ id: it.id, q: it.q, status: it.status, note: it.note, hide: it.hide, crop: it.crop, answerBox: it.answerBox, imgPath: it.imgPath });
    }
    const test = { id, title: st.title.trim() || `${st.subject} ${st.date}`, subject: st.subject, date: st.date, items };
    await store.saveTest(test, blobs);
    if (st.removedPaths.length) await store.removeImages(st.removedPaths);
    st.changed = false;
    toast("Saved");
    location.hash = "#/";
  } catch (e) {
    console.error(e);
    toast("Could not save: " + (e.message || e));
    st.saving = false;
    updateSummary();
  }
}

/* ---------------- crop modal ---------------- */
function openCrop(it) {
  const modal = $("#modal");
  const maxW = Math.min(innerWidth * 0.9, 900);
  const maxH = innerHeight * 0.72;
  const s = Math.min(maxW / it.canvas.width, maxH / it.canvas.height);
  const dw = Math.round(it.canvas.width * s);
  const dh = Math.round(it.canvas.height * s);
  const cv = document.createElement("canvas");
  cv.width = dw; cv.height = dh;
  cv.getContext("2d").drawImage(it.canvas, 0, 0, dw, dh);
  const box = h("div", { class: "cropbox" }, ["t", "b", "l", "r"].map((k) => h("div", { class: "h " + k, "data-k": k })));
  const wrap = h("div", { class: "cropwrap", style: `width:${dw}px;height:${dh}px` }, cv, box);
  let c = { ...it.crop };
  const place = () => Object.assign(box.style, { left: c.x * dw + "px", top: c.y * dh + "px", width: c.w * dw + "px", height: c.h * dh + "px" });
  place();

  let drag = null;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const MIN = 0.02;
  box.addEventListener("pointerdown", (e) => { if (e.target.dataset.k) { drag = e.target.dataset.k; e.preventDefault(); } });
  const move = (e) => {
    if (!drag) return;
    const r = wrap.getBoundingClientRect();
    const fx = clamp01((e.clientX - r.left) / dw);
    const fy = clamp01((e.clientY - r.top) / dh);
    if (drag === "t") { const y = Math.min(fy, c.y + c.h - MIN); c.h += c.y - y; c.y = y; }
    if (drag === "b") c.h = Math.max(MIN, fy - c.y);
    if (drag === "l") { const x = Math.min(fx, c.x + c.w - MIN); c.w += c.x - x; c.x = x; }
    if (drag === "r") c.w = Math.max(MIN, fx - c.x);
    place();
  };
  const up = () => (drag = null);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  const close = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); modal.hidden = true; modal.replaceChildren(); };

  modal.replaceChildren(h("div", { class: "mbox" },
    h("div", { class: "muted" }, "Drag the blue edges. Everything outside the box is removed."),
    wrap,
    h("div", { class: "row" },
      h("button", { onclick: () => { close(); rotateItem(it, 270, true); } }, "⟲ Rotate left"),
      h("button", { onclick: () => { close(); rotateItem(it, 90, true); } }, "⟳ Rotate right"),
      h("button", { onclick: () => { close(); rotateItem(it, 180, true); } }, "⇅ Flip 180°"),
      h("button", { onclick: () => { close(); runAnalysis(it, false); } }, "✨ Auto-crop"),
      h("button", { onclick: () => { c = { x: 0, y: 0, w: 1, h: 1 }; place(); } }, "Whole photo"),
      h("button", { onclick: close }, "Cancel"),
      h("button", { class: "primary", onclick: () => { it.crop = clampCrop(c); it.thumb = null; st.changed = true; close(); refreshCard(it); } }, "Done"))));
  modal.hidden = false;
}

route();
