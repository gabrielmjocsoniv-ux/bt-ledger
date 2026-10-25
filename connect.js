/* Connects the ledger to its own Supabase database, with login, live sync and backups. */
(() => {
  const CFG = window.LEDGER_CONFIG || {};
  const configured = CFG.url && !/HERE/.test(CFG.url) && CFG.anonKey && !/HERE/.test(CFG.anonKey);
  const $ = id => document.getElementById(id);
  const err = (code, message) => Object.assign(new Error(message), { code, message });

  /* ---------- login + account UI ---------- */
  const ui = document.createElement("div");
  ui.innerHTML = `
  <div class="auth" id="authScreen">
    <form class="auth-card" id="authForm" autocomplete="on">
      <div class="auth-mono">B&amp;T</div>
      <h1>Bryle &amp; Tintin</h1>
      <p class="auth-sub">Our household ledger</p>
      <div class="field"><label for="authEmail">Email</label><input id="authEmail" type="email" autocomplete="username" required></div>
      <div class="field"><label for="authPass">Password</label><input id="authPass" type="password" autocomplete="current-password" required></div>
      <button class="btn" type="submit" id="authBtn">Sign in</button>
      <p class="auth-err" id="authErr" hidden></p>
      <p class="auth-note">Private to the two of us. Your data stays in our own database.</p>
    </form>
  </div>
  <button type="button" class="acct-btn" id="acctBtn" aria-label="Account and backups" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg></button>
  <div class="scrim" id="acctScrim" hidden></div>
  <div class="sheet" id="acctSheet" role="dialog" aria-modal="true" aria-labelledby="acctTitle" hidden>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 id="acctTitle">Account</h2><button type="button" class="icon-btn" id="acctClose" aria-label="Close">✕</button></div>
    <div class="stat-list"><div><span>Signed in as</span><b id="acctEmail"></b></div><div><span>Live sync</span><b id="acctLive">Connecting…</b></div><div><span>Stored items</span><b id="acctCount"></b></div></div>
    <div class="actions"><button type="button" class="btn ghost" id="bkExport">Download backup</button><label class="btn ghost" for="bkFile" style="cursor:pointer">Import backup</label><input type="file" id="bkFile" accept="application/json,.json" hidden></div>
    <p class="note" id="bkNote">A backup is a single file with every entry, budget, account and goal. Importing adds or replaces items with the same ID and never deletes anything.</p>
    <div class="actions" style="justify-content:flex-end"><button type="button" class="btn" id="signOut">Sign out</button></div>
  </div>
  <div class="banner empty-banner" id="emptyBanner" hidden><b>Your ledger is empty.</b> Import the backup file from Claude to bring over everything from BT Tracker. <label for="bkFile2" class="btn" style="margin-left:8px;cursor:pointer;display:inline-block;padding:8px 12px">Choose backup file</label><input type="file" id="bkFile2" accept="application/json,.json" hidden></div>`;
  document.body.appendChild(ui);
  const mainIn = document.querySelector(".main-in");
  if (mainIn) mainIn.insertBefore($("emptyBanner"), mainIn.children[1] || null);

  const showErr = m => { const e = $("authErr"); e.textContent = m; e.hidden = !m; };
  if (!configured) { showErr("Setup isn't finished: the database address and key haven't been added to config.js yet."); $("authBtn").disabled = true; }

  /* ---------- store ---------- */
  const sb = configured ? window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
  let resolveReady; const ready = new Promise(r => resolveReady = r);
  const cache = {}, collL = {}, docL = {};
  const coll = c => (cache[c] = cache[c] || new Map());
  const snapDoc = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const qs = c => { const docs = [...coll(c).entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([id, d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
  const emitTimers = {};
  function emit(c, id) {
    (docL[c + "/" + id] || []).forEach(cb => { try { cb(snapDoc(id, coll(c).get(id))); } catch (e) { console.error(e); } });
    clearTimeout(emitTimers[c]); emitTimers[c] = setTimeout(() => (collL[c] || []).forEach(cb => { try { cb(qs(c)); } catch (e) { console.error(e); } }), 16);
  }
  const total = () => Object.values(cache).reduce((a, m) => a + m.size, 0);
  async function loadAll() {
    Object.keys(cache).forEach(k => cache[k].clear());
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("docs").select("collection,id,data").order("collection").order("id").range(from, from + 999);
      if (error) throw err("unavailable", error.message);
      data.forEach(r => coll(r.collection).set(r.id, r.data));
      if (data.length < 1000) break;
    }
  }
  const emitAll = () => { new Set([...Object.keys(cache), ...Object.keys(collL)]).forEach(c => { clearTimeout(emitTimers[c]); (collL[c] || []).forEach(cb => cb(qs(c))); }); Object.keys(docL).forEach(k => { const [c, id] = k.split("/"); docL[k].forEach(cb => cb(snapDoc(id, coll(c).get(id)))); }); };
  let channel = null;
  function live() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("docs-live").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
      if (p.eventType === "DELETE") { const o = p.old || {}; if (o.collection) { coll(o.collection).delete(o.id); emit(o.collection, o.id); } }
      else { const n = p.new; if (n && n.collection) { coll(n.collection).set(n.id, n.data); emit(n.collection, n.id); } }
      refreshAcct();
    }).subscribe(st => { const el = $("acctLive"); if (el) el.textContent = st === "SUBSCRIBED" ? "On" : st === "CLOSED" ? "Off" : "Reconnecting…"; });
  }
  const mapErr = e => err(/row-level security|42501|permission/i.test((e.code || "") + " " + (e.message || "")) ? "invalid_argument" : "unavailable", e.message || "Request failed");
  async function put(c, id, data) {
    const prev = coll(c).get(id); coll(c).set(id, data); emit(c, id);
    const { error } = await sb.from("docs").upsert({ collection: c, id, data, updated_at: new Date().toISOString() });
    if (error) { if (prev === undefined) coll(c).delete(id); else coll(c).set(id, prev); emit(c, id); throw mapErr(error); }
  }
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const merge = (a, b) => { const o = { ...a }; for (const k in b) { if (isObj(b[k]) && b[k].__delete__) delete o[k]; else o[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k]; } return o; };
  const clone = d => JSON.parse(JSON.stringify(d));
  const genId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      get: async () => snapDoc(id, coll(c).get(id)),
      set: async d => put(c, id, clone(d)),
      update: async d => { const cur = coll(c).get(id); if (cur === undefined) throw err("invalid_argument", "That item no longer exists."); return put(c, id, merge(cur, clone(d))); },
      delete: async () => { const prev = coll(c).get(id); coll(c).delete(id); emit(c, id); const { error } = await sb.from("docs").delete().match({ collection: c, id }); if (error) { if (prev !== undefined) { coll(c).set(id, prev); emit(c, id); } throw mapErr(error); } },
      onSnapshot: next => { const k = c + "/" + id; (docL[k] = docL[k] || new Set()).add(next); setTimeout(() => next(snapDoc(id, coll(c).get(id))), 0); return () => docL[k].delete(next); },
      collection: () => { throw new TypeError("Nested collections aren't used in this ledger."); }
    };
  }
  const split = p => { const s = p.split("/"); if (s.length !== 2) throw new TypeError("Path must be collection/id: " + p); return s; };
  const db = {
    doc: p => docRef(...split(p)),
    collection: c => ({
      path: c,
      doc: id => docRef(c, id || genId()),
      add: async d => { const r = docRef(c, genId()); await r.set(d); return r; },
      onSnapshot: next => { (collL[c] = collL[c] || new Set()).add(next); setTimeout(() => next(qs(c)), 0); return () => collL[c].delete(next); },
      get: async () => qs(c), where() { return this; }, orderBy() { return this; }, limit() { return this; }
    })
  };
  const downloads = { save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? "application/json" : /\.csv$/.test(filename) ? "text/csv" : "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return { status: "saved" };
  } };
  window.claude = { use: async n => n === "db" ? (await ready, db) : n === "downloads" ? downloads : null };

  /* ---------- session ---------- */
  let email = "";
  function refreshAcct() { if ($("acctCount")) $("acctCount").textContent = total().toLocaleString(); $("emptyBanner").hidden = total() > 0; }
  async function start(session) {
    email = session.user.email || ""; $("acctEmail").textContent = email;
    $("authBtn").disabled = true; $("authBtn").textContent = "Opening the ledger…";
    try {
      const { data: mem, error: me } = await sb.from("members").select("email").eq("email", email.toLowerCase()).maybeSingle();
      if (me) throw err("unavailable", me.message);
      if (!mem) { await sb.auth.signOut(); throw err("not_member", `${email} isn't on the household list. Add it to the members table in Supabase.`); }
      await loadAll(); live();
      document.documentElement.classList.add("authed");
      $("authScreen").hidden = true; $("acctBtn").hidden = false; refreshAcct();
      resolveReady();
    } catch (e) {
      $("authScreen").hidden = false; showErr(e.code === "not_member" ? e.message : "Couldn't reach the database. Check your connection and try again.");
      $("authBtn").disabled = false; $("authBtn").textContent = "Sign in";
    }
  }
  if (sb) {
    sb.auth.getSession().then(({ data }) => { if (data && data.session) start(data.session); else { $("authScreen").hidden = false; setTimeout(() => $("authEmail").focus(), 50); } });
    sb.auth.onAuthStateChange((ev, session) => { if (ev === "SIGNED_OUT") location.reload(); if (ev === "TOKEN_REFRESHED" && session && channel) sb.realtime.setAuth(session.access_token); });
    document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && document.documentElement.classList.contains("authed")) { try { await loadAll(); emitAll(); refreshAcct(); live(); } catch (e) {} } });
  }
  $("authForm").addEventListener("submit", async e => {
    e.preventDefault(); if (!sb) return; showErr("");
    $("authBtn").disabled = true; $("authBtn").textContent = "Signing in…";
    const { data, error } = await sb.auth.signInWithPassword({ email: $("authEmail").value.trim().toLowerCase(), password: $("authPass").value });
    if (error) { showErr(/invalid/i.test(error.message) ? "That email and password don't match." : error.message); $("authBtn").disabled = false; $("authBtn").textContent = "Sign in"; return; }
    start(data.session);
  });

  /* ---------- account sheet + backups ---------- */
  const openAcct = () => { refreshAcct(); $("acctScrim").hidden = false; $("acctSheet").hidden = false; };
  const closeAcct = () => { $("acctScrim").hidden = true; $("acctSheet").hidden = true; };
  $("acctBtn").onclick = openAcct; $("acctClose").onclick = closeAcct; $("acctScrim").onclick = closeAcct;
  $("signOut").onclick = async () => { await sb.auth.signOut(); };
  $("bkExport").onclick = () => {
    const docs = []; Object.entries(cache).forEach(([c, m]) => m.forEach((data, id) => docs.push({ collection: c, id, data })));
    const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    downloads.save({ filename: `bt-ledger-backup-${stamp}.json`, data: JSON.stringify({ app: "bt-ledger", version: 1, exportedAt: d.toISOString(), docs }) });
  };
  async function importFile(file, noteEl) {
    if (!file) return; const say = m => { noteEl.textContent = m; };
    try {
      const j = JSON.parse(await file.text()); const docs = Array.isArray(j.docs) ? j.docs : null;
      if (!docs || !docs.every(x => x && typeof x.collection === "string" && typeof x.id === "string" && x.data && typeof x.data === "object")) throw new Error("That file isn't a ledger backup.");
      for (let i = 0; i < docs.length; i += 100) {
        say(`Importing ${Math.min(i + 100, docs.length)} of ${docs.length}…`);
        const { error } = await sb.from("docs").upsert(docs.slice(i, i + 100).map(x => ({ collection: x.collection, id: x.id, data: x.data, updated_at: new Date().toISOString() })));
        if (error) throw mapErr(error);
      }
      await loadAll(); emitAll(); refreshAcct(); say(`Imported ${docs.length} items. Everything is in.`);
    } catch (e) { say(e.code === "invalid_argument" ? "This login isn't allowed to save. Check the members list in Supabase." : (e.message || "Import failed.")); }
  }
  $("bkFile").onchange = e => { importFile(e.target.files[0], $("bkNote")); e.target.value = ""; };
  $("bkFile2").onchange = e => { const b = $("emptyBanner"); const n = document.createElement("span"); n.className = "note"; n.style.marginLeft = "8px"; b.appendChild(n); importFile(e.target.files[0], n); e.target.value = ""; };
})();
