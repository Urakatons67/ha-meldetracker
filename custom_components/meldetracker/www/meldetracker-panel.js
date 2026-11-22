// Melde-Tracker – Seite „Melden“ (Erfassen, Woche, Verlauf, Einstellungen)
const DAYS = ["Mo", "Di", "Mi", "Do", "Fr"];
const DAY_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const COLORS = ["#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#00897b", "#f4511e", "#3949ab", "#c0ca33", "#6d4c41", "#d81b60", "#546e7a"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const weekday = (d) => (d.getDay() + 6) % 7; // 0 = Montag
const monday = (d) => addDays(d, -weekday(d));
const de = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, dig = 1) => (v == null || Number.isNaN(v) ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: dig, minimumFractionDigits: dig }));
function schoolDay(d, dir) { // nächster Schultag in Richtung dir (Wochenende überspringen)
  let x = addDays(d, dir);
  while (weekday(x) > 4) x = addDays(x, dir);
  return x;
}
function defaultDate() {
  const t = new Date();
  return weekday(t) > 4 ? iso(schoolDay(t, -1)) : iso(t);
}
const clone = (o) => JSON.parse(JSON.stringify(o));

class MeldetrackerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "erfassen";
    this._date = defaultDate();
    this._week = iso(monday(new Date()));
    this._range = 8;
    this._mode = "sum";
    this._ttDay = 0;
    this._data = null;
    this._draft = null;
    this._dirty = false;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
  }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (this._menu) this._menu.hass = h;
    if (first) this._load();
  }
  set narrow(n) { this._narrow = n; if (this._menu) this._menu.narrow = n; }
  set panel(p) {}

  async _load() {
    try {
      const req = { type: "meldetracker/get" };
      if (this._profile) req.profile = this._profile;
      this._data = await this._hass.callWS(req);
      this._profile = this._data.profile;
      this._err = null;
    } catch (e) {
      this._err = e.message || String(e);
    }
    this._resetDrafts();
    this._render();
  }

  // Alle Aufrufe gehen an das gerade gewählte Profil (der Server prüft die Rechte)
  _ws(msg) { return this._hass.callWS(this._profile ? { ...msg, profile: this._profile } : msg); }

  get _isParent() { return !!this._data && (this._data.role === "admin" || this._data.role === "parent"); }

  async _switchProfile(pid) {
    if (pid === this._profile) return;
    if (this._dirty && !confirm("Nicht gespeicherte Eingaben verwerfen?")) return;
    this._profile = pid;
    this._data = null;
    this._render();
    await this._load();
  }

  _resetDrafts() {
    this._draft = null;
    this._dirty = false;
    if (this._data) {
      this._parentsDraft = [...(this._data.parents || [])];
      this._profDraft = clone(this._data.profiles || []);
      this._newProf = { name: "", user_id: "", copy: "" };
      this._subjDraft = clone(this._data.subjects);
      this._ttDraft = clone(this._data.timetable);
      this._periodsDraft = this._data.periods || 8;
      this._celDraft = clone(this._data.celebrate || {});
      this._goalEdit = null;
      this._goalDraft = null;
    }
  }

  _goalsFor(monIso) {
    let cur = {};
    for (const g of [...(this._data.goals || [])].sort((a, b) => (a.from < b.from ? -1 : 1))) {
      if (g.from <= monIso) cur = g.goals;
    }
    return cur;
  }

  _subj(id) { return (this._data.subjects || []).find((s) => s.id === id) || { name: "(gelöschtes Fach)", color: "#999" }; }

  _toast(msg) {
    this._msg = msg;
    this._render();
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this._msg = ""; this._render(); }, 2500);
  }

  // ---------- Daten-Auswertung ----------
  _lessonsFor(dateIso) {
    const saved = this._data.days[dateIso];
    if (saved) return { saved: true, entries: clone(saved.entries) };
    const wd = weekday(parse(dateIso));
    const entries = (this._data.timetable || [])
      .filter((t) => t.day === wd)
      .sort((a, b) => a.period - b.period)
      .map((t) => ({ period: t.period, subject_id: t.subject_id, length: t.length, count: 0, cancelled: false }));
    return { saved: false, entries };
  }

  _weekStats(monIso) {
    const mon = parse(monIso);
    const by = {};
    let entered = 0;
    for (let i = 0; i < 5; i++) {
      const day = this._data.days[iso(addDays(mon, i))];
      if (!day) continue;
      entered++;
      for (const e of day.entries) {
        const s = (by[e.subject_id] ||= { sum: 0, units: 0, cells: [null, null, null, null, null], cancelled: [0, 0, 0, 0, 0] });
        if (e.cancelled) { s.cancelled[i]++; continue; }
        s.sum += e.count;
        s.units += e.length;
        s.cells[i] = (s.cells[i] || 0) + e.count;
      }
    }
    let sum = 0, units = 0;
    for (const s of Object.values(by)) { sum += s.sum; units += s.units; }
    return { by, entered, sum, units };
  }

  _orderedSubjects(ids) {
    const order = (this._data.subjects || []).map((s) => s.id);
    return [...ids].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  // ---------- Ereignisse ----------
  async _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "button")) return;
    const act = el.dataset.act;
    const i = Number(el.dataset.i);
    switch (act) {
      case "tab": this._tab = el.dataset.tab; this._render(); break;
      case "profile": await this._switchProfile(el.dataset.pid); break;
      case "profsave": {
        const p = this._profDraft[i];
        if (!(p.name || "").trim()) { this._toast("Bitte einen Namen eingeben"); return; }
        try {
          await this._hass.callWS({ type: "meldetracker/profile/save", profile_id: p.id, name: p.name.trim(), user_id: p.user_id || null });
          this._toast("Profil gespeichert ✓");
          await this._load();
        } catch (err) { this._toast("Fehler: " + (err.message || err)); }
        break;
      }
      case "profadd": {
        const n = this._newProf;
        if (!(n.name || "").trim()) { this._toast("Bitte einen Namen eingeben"); return; }
        try {
          const r = await this._hass.callWS({ type: "meldetracker/profile/save", name: n.name.trim(), user_id: n.user_id || null, copy_subjects_from: n.copy || null });
          this._profile = r.profile_id;
          this._toast("Profil angelegt ✓");
          await this._load();
        } catch (err) { this._toast("Fehler: " + (err.message || err)); }
        break;
      }
      case "profdel": {
        const p = this._profDraft[i];
        if (!confirm(`Profil „${p.name}“ mit ALLEN Einträgen, Zielen und Erfolgen löschen? Das kann nicht rückgängig gemacht werden.`)) return;
        const typed = prompt(`Zur Bestätigung den Namen „${p.name}“ eintippen:`);
        if (typed == null) return;
        try {
          await this._hass.callWS({ type: "meldetracker/profile/delete", profile_id: p.id, confirm_name: typed });
          if (this._profile === p.id) this._profile = null;
          this._toast("Profil gelöscht");
          await this._load();
        } catch (err) { this._toast("Fehler: " + (err.message || err)); }
        break;
      }
      case "saveparents":
        try {
          const r = await this._hass.callWS({ type: "meldetracker/parents/save", parents: this._parentsDraft });
          this._data.parents = r.parents;
          this._parentsDraft = [...r.parents];
          this._toast("Eltern gespeichert ✓");
        } catch (err) { this._toast("Fehler: " + (err.message || err)); }
        break;
      case "prevday": this._setDate(iso(schoolDay(parse(this._date), -1))); break;
      case "nextday": this._setDate(iso(schoolDay(parse(this._date), 1))); break;
      case "today": this._setDate(defaultDate()); break;
      case "inc": this._draft.entries[i].count = Math.min(99, this._draft.entries[i].count + 1); this._dirty = true; this._render(); break;
      case "dec": this._draft.entries[i].count = Math.max(0, this._draft.entries[i].count - 1); this._dirty = true; this._render(); break;
      case "rmextra": this._draft.entries.splice(i, 1); this._dirty = true; this._render(); break;
      case "addextra": {
        const sel = this.shadowRoot.querySelector("#extra");
        if (!sel || !sel.value) return;
        this._draft.entries.push({ period: 0, subject_id: sel.value, length: 1, count: 0, cancelled: false });
        this._dirty = true;
        this._render();
        break;
      }
      case "saveday": await this._saveDay(); break;
      case "clearday": await this._saveDay(true); break;
      case "prevweek": this._week = iso(addDays(parse(this._week), -7)); this._render(); break;
      case "nextweek": this._week = iso(addDays(parse(this._week), 7)); this._render(); break;
      case "mode": this._mode = el.dataset.mode; this._render(); break;
      case "range": this._range = Number(el.dataset.range); this._render(); break;
      case "addsubj": {
        const used = new Set(this._subjDraft.map((s) => s.color));
        this._subjDraft.push({ id: null, name: "", color: COLORS.find((c) => !used.has(c)) || COLORS[0], active: true });
        this._render();
        break;
      }
      case "delsubj": {
        const s = this._subjDraft[i];
        const usedInDays = s.id && Object.values(this._data.days).some((d) => d.entries.some((x) => x.subject_id === s.id));
        if (usedInDays) { this._toast("Fach hat schon Meldungen – bitte stattdessen „aktiv“ ausschalten"); return; }
        this._subjDraft.splice(i, 1);
        this._render();
        break;
      }
      case "savesubj": await this._saveSubjects(); break;
      case "ttday": this._ttDay = Number(el.dataset.day); this._render(); break;
      case "savett": await this._saveTimetable(); break;
      case "goaledit": {
        const m = el.dataset.week;
        const cur = this._goalsFor(m);
        this._goalEdit = m;
        this._goalDraft = Object.keys(cur).length ? { ...cur } : { ...(this._data.summary.suggest || {}) };
        this._render();
        break;
      }
      case "goalinc": case "goaldec": {
        const sid = el.dataset.sid;
        const v = (this._goalDraft[sid] || 0) + (act === "goalinc" ? 1 : -1);
        this._goalDraft[sid] = Math.max(0, Math.min(99, v));
        this._render();
        break;
      }
      case "goalsuggest": this._goalDraft = { ...(this._data.summary.suggest || {}) }; this._render(); break;
      case "goalcancel": this._goalEdit = null; this._goalDraft = null; this._render(); break;
      case "savegoals": await this._saveGoals(); break;
      case "celrm": this._celDraft[el.dataset.field].splice(i, 1); this._render(); break;
      case "savecel": await this._saveCelebrate(); break;
      case "testcel":
        try {
          await this._ws({ type: "meldetracker/celebrate/test" });
          this._toast("Test-Feier gestartet 🎉 (gespeicherte Einstellungen)");
        } catch (err) { this._toast("Fehler: " + (err.message || err)); }
        break;
    }
  }

  _onChange(e) {
    const el = e.target;
    const act = el.dataset.act;
    const i = Number(el.dataset.i);
    if (act === "date" && el.value) {
      const d = parse(el.value);
      this._setDate(weekday(d) > 4 ? iso(schoolDay(d, -1)) : el.value);
    } else if (act === "cancel") {
      this._draft.entries[i].cancelled = el.checked;
      this._dirty = true;
      this._render();
    } else if (act === "count") {
      const v = parseInt(el.value, 10);
      this._draft.entries[i].count = Number.isNaN(v) ? 0 : Math.max(0, Math.min(99, v));
      this._dirty = true;
      this._render();
    } else if (act === "celadd" && el.value) {
      const f = el.dataset.field;
      this._celDraft[f] = [...(this._celDraft[f] || [])];
      if (!this._celDraft[f].includes(el.value)) this._celDraft[f].push(el.value);
      this._render();
    } else if (act === "pname") this._profDraft[i].name = el.value;
    else if (act === "puser") this._profDraft[i].user_id = el.value;
    else if (act === "nname") this._newProf.name = el.value;
    else if (act === "nuser") this._newProf.user_id = el.value;
    else if (act === "ncopy") this._newProf.copy = el.value;
    else if (act === "parent") {
      const id = el.dataset.uid;
      this._parentsDraft = this._parentsDraft.filter((x) => x !== id);
      if (el.checked) this._parentsDraft.push(id);
    } else if (act === "celtoggle") this._celDraft[el.dataset.field] = el.checked;
    else if (act === "celtext") this._celDraft[el.dataset.field] = el.value;
    else if (act === "sname") this._subjDraft[i].name = el.value;
    else if (act === "scolor") this._subjDraft[i].color = el.value;
    else if (act === "sactive") this._subjDraft[i].active = el.checked;
    else if (act === "periods") { this._periodsDraft = Number(el.value); this._ttDraft = this._ttDraft.filter((t) => t.period + t.length - 1 <= this._periodsDraft); this._render(); }
    else if (act === "ttsubj" || act === "ttdouble") {
      const p = Number(el.dataset.p);
      const day = this._ttDay;
      const cur = this._ttDraft.find((t) => t.day === day && t.period === p);
      if (act === "ttsubj") {
        this._ttDraft = this._ttDraft.filter((t) => !(t.day === day && t.period === p));
        if (el.value) this._ttDraft.push({ day, period: p, subject_id: el.value, length: cur ? cur.length : 1 });
      } else if (cur) {
        cur.length = el.checked ? 2 : 1;
        if (el.checked) this._ttDraft = this._ttDraft.filter((t) => !(t.day === day && t.period === p + 1));
      }
      this._render();
    }
  }

  _setDate(d) {
    if (this._dirty && !confirm("Nicht gespeicherte Eingaben verwerfen?")) { this._render(); return; }
    this._date = d;
    this._draft = null;
    this._dirty = false;
    this._render();
  }

  async _saveDay(clear = false) {
    if (clear && !confirm("Einträge dieses Tages löschen?")) return;
    try {
      const entries = clear ? [] : this._draft.entries;
      const r = await this._ws({ type: "meldetracker/day/save", date: this._date, entries });
      if (r.day) this._data.days[this._date] = r.day; else delete this._data.days[this._date];
      if (r.summary) this._data.summary = r.summary;
      this._draft = null;
      this._dirty = false;
      this._toast(clear ? "Tag gelöscht" : r.new ? `Gespeichert ✓ – 🎉 ${r.new} neue${r.new === 1 ? "r" : ""} Erfolg${r.new === 1 ? "" : "e"}!` : "Gespeichert ✓");
    } catch (e) { this._toast("Fehler: " + (e.message || e)); }
  }

  async _saveGoals() {
    try {
      const goals = {};
      for (const [k, v] of Object.entries(this._goalDraft || {})) if (v > 0) goals[k] = v;
      const r = await this._ws({ type: "meldetracker/goals/save", from: this._goalEdit, goals });
      this._data.goals = r.goals;
      this._data.summary = r.summary;
      this._goalEdit = null;
      this._goalDraft = null;
      this._toast(r.new ? `Ziele gespeichert ✓ – 🎉 ${r.new} neue Erfolge!` : "Ziele gespeichert ✓");
    } catch (e) { this._toast("Fehler: " + (e.message || e)); }
  }

  async _saveCelebrate() {
    try {
      const c = this._celDraft;
      const config = {
        name: c.name || "", lights: c.lights || [], speakers: c.speakers || [], push_kid: c.push_kid || [],
        push_parent: c.push_parent || [], quiet_start: c.quiet_start || "21:00", quiet_end: c.quiet_end || "07:00",
        enable_light: !!c.enable_light, enable_voice: !!c.enable_voice, enable_push: !!c.enable_push, enable_parent: !!c.enable_parent,
      };
      const r = await this._ws({ type: "meldetracker/celebrate/save", config });
      this._data.celebrate = r.celebrate;
      this._celDraft = clone(r.celebrate);
      this._toast("Feier-Einstellungen gespeichert ✓");
    } catch (e) { this._toast("Fehler: " + (e.message || e)); }
  }

  async _saveSubjects() {
    const subjects = this._subjDraft.map((s) => ({ ...s, name: (s.name || "").trim() }));
    if (subjects.some((s) => !s.name)) { this._toast("Bitte jedem Fach einen Namen geben"); return; }
    try {
      const r = await this._ws({ type: "meldetracker/subjects/save", subjects: subjects.map((s) => (s.id ? s : { name: s.name, color: s.color, active: s.active })) });
      this._data.subjects = r.subjects;
      this._data.timetable = r.timetable;
      this._subjDraft = clone(r.subjects);
      this._ttDraft = clone(r.timetable);
      this._toast("Fächer gespeichert ✓");
    } catch (e) { this._toast("Fehler: " + (e.message || e)); }
  }

  async _saveTimetable() {
    try {
      const r = await this._ws({ type: "meldetracker/timetable/save", timetable: this._ttDraft, periods: this._periodsDraft });
      this._data.timetable = r.timetable;
      this._data.periods = r.periods;
      this._ttDraft = clone(r.timetable);
      this._draft = null;
      this._toast("Stundenplan gespeichert ✓");
    } catch (e) { this._toast("Fehler: " + (e.message || e)); }
  }

  // ---------- Darstellung ----------
  _render() {
    const root = this.shadowRoot;
    let body;
    if (this._err) body = `<div class="card err">Fehler beim Laden: ${esc(this._err)}</div>`;
    else if (!this._data) body = `<div class="card">Lade …</div>`;
    else body = { erfassen: () => this._rErfassen(), woche: () => this._rWoche(), verlauf: () => this._rVerlauf(), erfolge: () => this._rErfolge(), einst: () => this._rEinst() }[this._tab]();
    const tabs = [["erfassen", "Eintragen"], ["woche", "Woche"], ["verlauf", "Verlauf"], ["erfolge", "Erfolge"], ["einst", "Einstellungen"]]
      .map(([k, l]) => `<button class="tab ${this._tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}</button>`).join("");
    const profs = (this._data && this._data.profiles) || [];
    const switcher = profs.length > 1
      ? `<div class="pswitch">${profs.map((p) => `<button class="${p.id === this._profile ? "on" : ""}" data-act="profile" data-pid="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div>`
      : "";
    root.innerHTML = `<style>${CSS}</style>
      <header><span id="menu"></span><h1>Melden</h1>${switcher}</header>
      <nav>${tabs}</nav>
      <main>${body}</main>
      ${this._msg ? `<div class="toast">${esc(this._msg)}</div>` : ""}`;
    if (!this._menu) {
      this._menu = document.createElement("ha-menu-button");
      this._menu.hass = this._hass;
      this._menu.narrow = this._narrow;
    }
    root.querySelector("#menu").appendChild(this._menu);
  }

  _rErfassen() {
    if (!this._data.timetable.length && !Object.keys(this._data.days).length) {
      return `<div class="card">Noch kein Stundenplan. Bitte zuerst unter <b>Einstellungen</b> Fächer und Stundenplan anlegen.</div>`;
    }
    if (!this._draft) this._draft = this._lessonsFor(this._date);
    const d = parse(this._date);
    const saved = this._data.days[this._date];
    const status = saved
      ? `<span class="ok">gespeichert ✓</span>`
      : `<span class="muted">noch nicht eingetragen</span>`;
    const lessons = this._draft.entries.map((e, i) => {
      const s = this._subj(e.subject_id);
      const when = e.period === 0 ? "Zusatzstunde" : e.length === 2 ? `${e.period}.–${e.period + 1}. Stunde · Doppelstunde` : `${e.period}. Stunde`;
      return `<div class="lesson ${e.cancelled ? "cx" : ""}" style="--c:${esc(s.color)}">
        <div class="info">
          <div class="name">${esc(s.name)}</div>
          <div class="meta">${when}</div>
          <label class="small"><input type="checkbox" data-act="cancel" data-i="${i}" ${e.cancelled ? "checked" : ""}> fiel aus</label>
          ${e.period === 0 ? `<button class="link" data-act="rmextra" data-i="${i}">entfernen</button>` : ""}
        </div>
        <div class="stepper">
          <button data-act="dec" data-i="${i}" ${e.cancelled ? "disabled" : ""}>−</button>
          <input type="number" inputmode="numeric" min="0" max="99" value="${e.count}" data-act="count" data-i="${i}" ${e.cancelled ? "disabled" : ""}>
          <button data-act="inc" data-i="${i}" ${e.cancelled ? "disabled" : ""}>+</button>
        </div>
      </div>`;
    }).join("") || `<div class="card muted">Für ${DAY_LONG[weekday(d)]} steht nichts im Stundenplan.</div>`;
    const total = this._draft.entries.filter((e) => !e.cancelled).reduce((a, e) => a + e.count, 0);
    const opts = this._data.subjects.filter((s) => s.active !== false).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    return `
      <div class="datebar">
        <button data-act="prevday">◀</button>
        <input type="date" value="${this._date}" data-act="date">
        <button data-act="nextday">▶</button>
        <button class="link" data-act="today">heute</button>
      </div>
      <div class="sub">${DAY_LONG[weekday(d)]}, ${de(d)}${d.getFullYear()} · KW ${isoWeek(d)} · ${status}</div>
      <p class="hint">Striche von der Strichliste übertragen: pro Stunde mit + zählen oder die Zahl eintippen.</p>
      ${lessons}
      <div class="row extra"><select id="extra"><option value="">Vertretung/Zusatzstunde …</option>${opts}</select><button data-act="addextra">+ hinzufügen</button></div>
      <div class="sum">Meldungen heute: <b>${total}</b></div>
      <button class="primary" data-act="saveday">${this._dirty || !saved ? "Speichern" : "Erneut speichern"}</button>
      ${saved ? `<button class="link danger" data-act="clearday">Tag löschen</button>` : ""}`;
  }

  _rWoche() {
    const mon = parse(this._week);
    const st = this._weekStats(this._week);
    const ttIds = new Set(this._data.timetable.map((t) => t.subject_id));
    const ids = this._orderedSubjects(new Set([...ttIds, ...Object.keys(st.by)]));
    const head = DAYS.map((d, i) => `<th>${d}<br><span class="muted">${de(addDays(mon, i))}</span></th>`).join("");
    const entered = [0, 1, 2, 3, 4].map((i) => !!this._data.days[iso(addDays(mon, i))]);
    const rows = ids.map((id) => {
      const s = this._subj(id);
      const b = st.by[id];
      const cells = [0, 1, 2, 3, 4].map((i) => {
        if (!entered[i]) return `<td class="muted">·</td>`;
        if (!b) return `<td class="muted"></td>`;
        if (b.cells[i] != null) return `<td>${b.cells[i]}</td>`;
        return b.cancelled[i] ? `<td class="muted">A</td>` : `<td class="muted"></td>`;
      }).join("");
      return `<tr><td class="fach"><i style="background:${esc(s.color)}"></i>${esc(s.name)}</td>${cells}<td class="b">${b ? b.sum : "–"}</td><td>${b && b.units ? fmt(b.sum / b.units) : "–"}</td></tr>`;
    }).join("");
    return `
      <div class="datebar">
        <button data-act="prevweek">◀</button>
        <div class="wk">KW ${isoWeek(mon)} · ${de(mon)}–${de(addDays(mon, 4))}${addDays(mon, 4).getFullYear()}</div>
        <button data-act="nextweek">▶</button>
      </div>
      ${this._rGoals(this._week, st)}
      <div class="scroll"><table>
        <thead><tr><th>Fach</th>${head}<th>Σ</th><th>ø/Std</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="muted">Keine Fächer</td></tr>`}</tbody>
        <tfoot><tr><td class="b">Gesamt</td>${[0, 1, 2, 3, 4].map((i) => {
          if (!entered[i]) return `<td class="muted">·</td>`;
          const v = Object.values(st.by).reduce((a, b) => a + (b.cells[i] || 0), 0);
          return `<td class="b">${v}</td>`;
        }).join("")}<td class="b">${st.sum}</td><td class="b">${st.units ? fmt(st.sum / st.units) : "–"}</td></tr></tfoot>
      </table></div>
      <p class="hint">· = noch nicht eingetragen · A = Stunde fiel aus · ø/Std = Meldungen je Unterrichtsstunde (45 min, Doppelstunde zählt 2)</p>`;
  }

  _rGoals(monIso, st) {
    const sm = this._data.summary || {};
    const editable = monIso >= (sm.this_monday || "");
    const ids = this._orderedSubjects(new Set(this._data.timetable.map((t) => t.subject_id)));
    if (!ids.length) return "";
    if (this._goalEdit === monIso) {
      const sug = sm.suggest || {};
      const rows = ids.map((id) => {
        const s = this._subj(id);
        const v = this._goalDraft[id] || 0;
        return `<div class="grow" style="--c:${esc(s.color)}">
          <div class="gname"><i style="background:${esc(s.color)}"></i>${esc(s.name)}<div class="meta">Vorschlag: ${sug[id] ?? "–"}</div></div>
          <div class="stepper sm"><button data-act="goaldec" data-sid="${esc(id)}">−</button><span class="gv">${v || "–"}</span><button data-act="goalinc" data-sid="${esc(id)}">+</button></div>
        </div>`;
      }).join("");
      return `<div class="card"><h2>🎯 Wochenziele festlegen</h2>
        <p class="hint">Wie oft willst du dich diese Woche pro Fach melden? Der Vorschlag liegt etwas über deinem bisherigen Schnitt. Du entscheidest! 0 = kein Ziel. Die Ziele gelten ab dieser Woche, bis du sie wieder änderst.</p>
        ${rows}
        <div class="row"><button data-act="goalsuggest">Vorschläge übernehmen</button><button data-act="goalcancel">Abbrechen</button><button class="primary" data-act="savegoals">Ziele speichern</button></div></div>`;
    }
    const goals = this._goalsFor(monIso);
    const wk = (sm.weeks || {})[monIso];
    const withGoal = ids.filter((id) => goals[id]);
    if (!withGoal.length) {
      return editable
        ? `<div class="card"><h2>🎯 Wochenziele</h2><p class="muted">Noch keine Ziele für diese Woche.</p><button class="primary" data-act="goaledit" data-week="${monIso}">Ziele festlegen</button></div>`
        : "";
    }
    let nOk = 0;
    const rows = withGoal.map((id) => {
      const s = this._subj(id);
      const g = goals[id];
      const v = (st.by[id] || {}).sum || 0;
      const ok = (wk && wk.reached && wk.reached[id]) || v >= g;
      if (ok) nOk++;
      const pct = Math.min(100, Math.round((v / g) * 100));
      return `<div class="goal">
        <div class="gname"><i style="background:${esc(s.color)}"></i>${esc(s.name)}</div>
        <div class="bar"><div style="width:${pct}%;background:${esc(s.color)}"></div></div>
        <div class="gnum">${v}/${g} ${ok ? "⭐" : ""}</div>
      </div>`;
    }).join("");
    const need = Math.ceil(withGoal.length * 0.6);
    const head = (wk && wk.weekstar) || nOk >= need
      ? `<div class="star">🌟 Wochenstern geschafft!</div>`
      : `<div class="hint">🌟 Wochenstern ab ${need} von ${withGoal.length} Zielen – noch ${need - nOk}</div>`;
    return `<div class="card"><h2>🎯 Wochenziele</h2>${head}${rows}
      ${editable ? `<button class="link" data-act="goaledit" data-week="${monIso}">Ziele ändern</button>` : ""}</div>`;
  }

  _rErfolge() {
    const s = this._data.summary;
    if (!s) return `<div class="card">Lade …</div>`;
    const lv = s.level;
    const pct = lv.next_at ? Math.min(100, Math.round((s.total / lv.next_at) * 100)) : 100;
    const badges = s.badges.map((b) => `<div class="badge ${b.date ? "" : "locked"}">
        <div class="bi">${b.icon}</div><div class="bt">${esc(b.title)}</div>
        <div class="bd">${b.date ? de(parse(b.date)) + parse(b.date).getFullYear() : esc(b.desc)}</div></div>`).join("");
    const recent = (s.recent || []).map((r) => `<div class="rec"><span class="ri">${r.icon || "⭐"}</span><span>${esc(r.title)}</span><span class="muted">${de(parse(r.date))}</span></div>`).join("");
    return `
      <div class="card lvl">
        <div class="li">${lv.icon}</div>
        <div class="lt">Stufe: <b>${esc(lv.name)}</b></div>
        <div class="bar big"><div style="width:${pct}%"></div></div>
        <div class="hint">${lv.next_at ? `${s.total} Meldungen · noch ${lv.next_at - s.total} bis „${esc(lv.next_name)}“` : `${s.total} Meldungen – höchste Stufe erreicht!`}</div>
      </div>
      <div class="tiles">
        <div class="tile"><div class="tv">⭐ ${s.stars}</div><div class="tl">Sterne</div></div>
        <div class="tile"><div class="tv">🌟 ${s.weekstars}</div><div class="tl">Wochensterne</div></div>
        <div class="tile"><div class="tv">🔥 ${s.streak}</div><div class="tl">Serie (Rekord ${s.best_streak})</div></div>
      </div>
      <div class="card"><h2>Abzeichen</h2><div class="badges">${badges}</div></div>
      <div class="card"><h2>Zuletzt geschafft</h2>${recent || `<p class="muted">Noch nichts – trag deine erste Strichliste ein!</p>`}</div>
      <p class="hint">⭐ = Wochenziel in einem Fach geschafft · 🌟 = Wochenstern (mind. 60 % der Wochenziele) · 🔥 = Wochensterne hintereinander (Ferienwochen ohne Einträge unterbrechen die Serie nicht).</p>`;
  }

  _rFeiern() {
    const c = this._celDraft || {};
    const ch = this._data.choices || { lights: [], speakers: [], push: [] };
    const pushList = (ch.push || []).map((p) => ({ id: p, name: p.replace("notify.", "") }));
    const multi = (field, list, label) => {
      const sel = c[field] || [];
      const nameOf = (id) => (list.find((x) => x.id === id) || { name: id }).name;
      const chips = sel.map((v, i) => `<span class="chip">${esc(nameOf(v))}<button class="x" data-act="celrm" data-field="${field}" data-i="${i}">✕</button></span>`).join("");
      const opts = list.filter((o) => !sel.includes(o.id)).map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("");
      return `<div class="ms"><div class="lbl">${label}</div><div class="chips">${chips || `<span class="muted">nichts ausgewählt</span>`}</div>
        <select data-act="celadd" data-field="${field}"><option value="">+ hinzufügen …</option>${opts}</select></div>`;
    };
    const tog = (f, l) => `<label class="small"><input type="checkbox" data-act="celtoggle" data-field="${f}" ${c[f] ? "checked" : ""}> ${l}</label>`;
    return `<div class="card">
      <h2>🎉 Feiern</h2>
      <div class="ms"><div class="lbl">Name für die Texte</div><input type="text" class="txt" value="${esc(c.name || "")}" data-act="celtext" data-field="name" maxlength="30"></div>
      <div class="row">${tog("enable_light", "Licht")}${tog("enable_voice", "Sprachausgabe")}${tog("enable_push", "Push ans Kind")}${tog("enable_parent", "Lob-Push an Eltern")}</div>
      ${multi("lights", ch.lights, "Lichter für die Licht-Show")}
      ${multi("speakers", ch.speakers, "Sprachausgabe (Echo / Notify-Entitäten)")}
      ${multi("push_kid", pushList, "Push ans Kind")}
      ${multi("push_parent", pushList, "Lob-Push an Eltern")}
      <div class="row"><label class="small">Ruhezeit von <input type="time" value="${esc(c.quiet_start || "21:00")}" data-act="celtext" data-field="quiet_start"></label>
        <label class="small">bis <input type="time" value="${esc(c.quiet_end || "07:00")}" data-act="celtext" data-field="quiet_end"></label></div>
      <p class="hint">In der Ruhezeit gibt es nur Push, kein Licht und keine Sprachausgabe.</p>
      <div class="row"><button data-act="testcel">Feier testen</button><button class="primary" data-act="savecel">Speichern</button></div>
    </div>`;
  }

  _history() {
    const cur = monday(new Date());
    const weeks = [];
    for (let k = this._range - 1; k >= 0; k--) {
      const m = addDays(cur, -7 * k);
      weeks.push({ mon: m, st: this._weekStats(iso(m)) });
    }
    const ids = new Set();
    weeks.forEach((w) => Object.keys(w.st.by).forEach((id) => ids.add(id)));
    return { weeks, ids: this._orderedSubjects(ids) };
  }

  _val(st, id) {
    const b = id ? st.by[id] : { sum: st.sum, units: st.units };
    if (!b || !st.entered) return null;
    if (this._mode === "sum") return b.sum;
    return b.units ? b.sum / b.units : null;
  }

  _rVerlauf() {
    const { weeks, ids } = this._history();
    const dig = this._mode === "sum" ? 0 : 1;
    const mode = [["sum", "Summe"], ["rate", "pro Stunde"]].map(([k, l]) => `<button class="seg ${this._mode === k ? "on" : ""}" data-act="mode" data-mode="${k}">${l}</button>`).join("");
    const range = [4, 8, 12, 26].map((r) => `<button class="seg ${this._range === r ? "on" : ""}" data-act="range" data-range="${r}">${r} W</button>`).join("");
    if (!ids.length) return `<div class="row">${mode}</div><div class="row">${range}</div><div class="card muted">In diesem Zeitraum gibt es noch keine Einträge.</div>`;
    const head = ids.map((id) => { const s = this._subj(id); return `<th><i style="background:${esc(s.color)}"></i>${esc(s.name)}</th>`; }).join("");
    const rows = [...weeks].reverse().map((w) => `<tr><td class="fach">KW ${isoWeek(w.mon)}<br><span class="muted">${de(w.mon)}</span></td>${ids.map((id) => `<td>${fmt(this._val(w.st, id), dig)}</td>`).join("")}<td class="b">${fmt(this._val(w.st, null), dig)}</td></tr>`).join("");
    return `
      <div class="row">${mode}</div>
      <div class="row">${range}</div>
      <div class="card chart">${this._chart(weeks, ids)}</div>
      <div class="legend">${ids.map((id) => { const s = this._subj(id); return `<span><i style="background:${esc(s.color)}"></i>${esc(s.name)}</span>`; }).join("")}</div>
      <div class="scroll"><table>
        <thead><tr><th>Woche</th>${head}<th>Gesamt</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="hint">${this._mode === "sum" ? "Summe der Meldungen pro Woche." : "Meldungen je Unterrichtsstunde – Ausfälle, Ferien und Doppelstunden verfälschen den Vergleich so nicht."} „–“ = keine Einträge.</p>`;
  }

  _chart(weeks, ids) {
    const W = 640, H = 260, L = 36, R = 10, T = 12, B = 28;
    const n = weeks.length;
    const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
    let max = 0;
    for (const w of weeks) for (const id of ids) max = Math.max(max, this._val(w.st, id) || 0);
    max = max <= 0 ? 1 : max * 1.1;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const dig = this._mode === "sum" ? 0 : 1;
    let svg = "";
    for (let g = 0; g <= 4; g++) {
      const v = (max * g) / 4;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 4}" class="ax" text-anchor="end">${fmt(v, dig)}</text>`;
    }
    const step = Math.ceil(n / 8);
    weeks.forEach((w, i) => { if (i % step === 0 || i === n - 1) svg += `<text x="${x(i)}" y="${H - 8}" class="ax" text-anchor="middle">KW${isoWeek(w.mon)}</text>`; });
    for (const id of ids) {
      const c = esc(this._subj(id).color);
      let seg = [];
      const flush = () => { if (seg.length > 1) svg += `<polyline points="${seg.join(" ")}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/>`; seg = []; };
      weeks.forEach((w, i) => {
        const v = this._val(w.st, id);
        if (v == null) { flush(); return; }
        seg.push(`${x(i)},${y(v)}`);
        svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${c}"><title>${esc(this._subj(id).name)} KW${isoWeek(w.mon)}: ${fmt(v, dig)}</title></circle>`;
      });
      flush();
    }
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`;
  }

  _rEinst() {
    const subj = this._subjDraft.map((s, i) => `
      <div class="srow">
        <input type="color" value="${esc(s.color)}" data-act="scolor" data-i="${i}">
        <input type="text" value="${esc(s.name)}" placeholder="Fach, z. B. Mathe" maxlength="40" data-act="sname" data-i="${i}">
        <label class="small"><input type="checkbox" data-act="sactive" data-i="${i}" ${s.active !== false ? "checked" : ""}> aktiv</label>
        <button class="link danger" data-act="delsubj" data-i="${i}">✕</button>
      </div>`).join("");
    const saved = this._data.subjects.filter((s) => s.active !== false);
    const opts = (sel) => `<option value="">–</option>` + saved.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    const dayTabs = DAYS.map((d, i) => `<button class="seg ${this._ttDay === i ? "on" : ""}" data-act="ttday" data-day="${i}">${d}</button>`).join("");
    let rows = "";
    for (let p = 1; p <= this._periodsDraft; p++) {
      const prev = this._ttDraft.find((t) => t.day === this._ttDay && t.period === p - 1 && t.length === 2);
      if (prev) { rows += `<div class="ttrow"><span class="pn">${p}.</span><span class="muted">↳ Doppelstunde ${esc(this._subj(prev.subject_id).name)}</span></div>`; continue; }
      const cur = this._ttDraft.find((t) => t.day === this._ttDay && t.period === p);
      rows += `<div class="ttrow"><span class="pn">${p}.</span>
        <select data-act="ttsubj" data-p="${p}">${opts(cur && cur.subject_id)}</select>
        <label class="small"><input type="checkbox" data-act="ttdouble" data-p="${p}" ${cur && cur.length === 2 ? "checked" : ""} ${!cur || p === this._periodsDraft ? "disabled" : ""}> Doppel</label>
      </div>`;
    }
    const per = [6, 7, 8, 9, 10, 11, 12].map((n) => `<option ${n === this._periodsDraft ? "selected" : ""}>${n}</option>`).join("");
    return `
      <div class="card">
        <h2>Fächer</h2>
        ${subj || `<p class="muted">Noch keine Fächer.</p>`}
        <div class="row"><button data-act="addsubj">+ Fach</button><button class="primary" data-act="savesubj">Fächer speichern</button></div>
      </div>
      <div class="card">
        <h2>Stundenplan</h2>
        ${saved.length ? "" : `<p class="muted">Bitte zuerst Fächer anlegen und speichern.</p>`}
        <div class="row">${dayTabs}</div>
        ${rows}
        <div class="row"><label class="small">Stunden pro Tag <select data-act="periods">${per}</select></label></div>
        <button class="primary" data-act="savett">Stundenplan speichern</button>
        <p class="hint">Bei einer Doppelstunde „Doppel“ in der ersten der beiden Stunden anhaken. Änderungen gelten nur für neue Einträge – bereits gespeicherte Tage bleiben, wie sie sind.</p>
      </div>
      ${this._isParent ? this._rFeiern() : ""}
      ${this._data.role === "admin" ? this._rProfile() + this._rEltern() : ""}`;
  }

  _rProfile() {
    const users = this._data.users || [];
    const uopts = (sel) => `<option value="">– kein Benutzer –</option>` + users.map((u) => `<option value="${esc(u.id)}" ${u.id === sel ? "selected" : ""}>${esc(u.name)}</option>`).join("");
    const rows = this._profDraft.map((p, i) => `
      <div class="srow">
        <input type="text" value="${esc(p.name)}" maxlength="30" data-act="pname" data-i="${i}">
        <select data-act="puser" data-i="${i}">${uopts(p.user_id)}</select>
        <button class="link" data-act="profsave" data-i="${i}">Speichern</button>
        ${this._profDraft.length > 1 ? `<button class="link danger" data-act="profdel" data-i="${i}">✕</button>` : ""}
      </div>`).join("");
    const copts = `<option value="">ohne Fächer</option>` + this._profDraft.map((p) => `<option value="${esc(p.id)}" ${p.id === this._newProf.copy ? "selected" : ""}>Fächer von ${esc(p.name)}</option>`).join("");
    return `<div class="card">
      <h2>🧒 Profile</h2>
      <p class="hint">Ein Profil je Kind. Mit dem HA-Benutzer verknüpft, sieht das Kind beim Öffnen der Seite automatisch sein eigenes Profil – und nur dieses.</p>
      ${rows}
      <h2 style="margin-top:14px">Neues Profil</h2>
      <div class="srow"><input type="text" placeholder="Name" maxlength="30" value="${esc(this._newProf.name)}" data-act="nname">
        <select data-act="nuser">${uopts(this._newProf.user_id)}</select></div>
      <div class="srow"><select data-act="ncopy">${copts}</select><button data-act="profadd">+ Anlegen</button></div>
    </div>`;
  }

  _rEltern() {
    const users = this._data.users || [];
    const rows = users.map((u) => `<label class="small prow"><input type="checkbox" data-act="parent" data-uid="${esc(u.id)}" ${this._parentsDraft.includes(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("");
    return `<div class="card">
      <h2>👪 Eltern</h2>
      <p class="hint">Eltern sehen alle Kinder, können oben umschalten und alles bearbeiten. Administratoren dürfen das immer. Kinder sehen nur ihr eigenes Profil.</p>
      ${rows || `<p class="muted">Keine weiteren Benutzer.</p>`}
      <button class="primary" data-act="saveparents">Eltern speichern</button>
    </div>`;
  }
}

const CSS = `
:host { display:block; background:var(--primary-background-color); color:var(--primary-text-color); min-height:100vh; font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
header { display:flex; align-items:center; gap:8px; height:56px; padding:0 8px; background:var(--app-header-background-color, var(--primary-color)); color:var(--app-header-text-color, #fff); }
header h1 { font-size:20px; font-weight:400; margin:0; flex:1; }
.pswitch { display:flex; gap:4px; background:rgba(255,255,255,.15); border-radius:18px; padding:3px; }
.pswitch button { border:0; border-radius:15px; padding:5px 12px; background:none; color:inherit; font-size:14px; }
.pswitch button.on { background:var(--card-background-color); color:var(--primary-text-color); font-weight:500; }
.prow { display:flex; margin:6px 0; }
nav { display:flex; overflow-x:auto; background:var(--card-background-color); border-bottom:1px solid var(--divider-color); }
.tab { flex:1; padding:12px 8px; border:0; background:none; color:var(--secondary-text-color); font-size:15px; border-bottom:3px solid transparent; white-space:nowrap; }
.tab.on { color:var(--primary-color); border-bottom-color:var(--primary-color); font-weight:500; }
main { max-width:760px; margin:0 auto; padding:12px 16px 80px; box-sizing:border-box; }
.card { background:var(--card-background-color); border-radius:12px; padding:12px 14px; margin:10px 0; box-shadow:var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.15)); }
.card.err { color:var(--error-color); }
h2 { font-size:17px; margin:2px 0 10px; font-weight:500; }
button { font:inherit; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); padding:8px 12px; cursor:pointer; }
button:disabled { opacity:.4; }
button.primary { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:var(--primary-color); width:100%; padding:12px; font-size:16px; margin-top:10px; }
.row button.primary { width:auto; margin-top:0; }
button.link { border:0; background:none; color:var(--primary-color); padding:4px 6px; }
button.danger, .danger { color:var(--error-color); }
.seg { border-radius:16px; padding:6px 12px; }
.seg.on { background:var(--primary-color); color:var(--text-primary-color,#fff); border-color:var(--primary-color); }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
.datebar { display:flex; gap:8px; align-items:center; justify-content:center; margin:6px 0; }
.datebar input { font:inherit; padding:7px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); }
.wk { font-weight:500; min-width:200px; text-align:center; }
.sub { text-align:center; color:var(--secondary-text-color); font-size:14px; }
.ok { color:var(--success-color, #43a047); font-weight:500; }
.muted { color:var(--secondary-text-color); }
.hint { color:var(--secondary-text-color); font-size:13px; }
.small { font-size:14px; color:var(--secondary-text-color); display:inline-flex; align-items:center; gap:4px; }
.lesson { display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--card-background-color); border-radius:12px; border-left:6px solid var(--c); padding:10px 12px; margin:8px 0; box-shadow:var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.15)); }
.lesson.cx { opacity:.55; }
.lesson .name { font-size:17px; font-weight:500; }
.lesson .meta { font-size:13px; color:var(--secondary-text-color); margin:2px 0 4px; }
.stepper { display:flex; align-items:center; gap:6px; }
.stepper button { width:48px; height:48px; font-size:26px; padding:0; border-radius:50%; }
.stepper button:last-child { background:var(--primary-color); color:var(--text-primary-color,#fff); border-color:var(--primary-color); }
.stepper input { width:46px; text-align:center; font-size:22px; font-weight:500; border:0; background:none; color:var(--primary-text-color); -moz-appearance:textfield; }
.stepper input::-webkit-outer-spin-button, .stepper input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.extra select, .ttrow select, .srow select, .srow input[type=text] { font:inherit; padding:8px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); flex:1; min-width:0; }
.sum { text-align:center; margin-top:10px; font-size:16px; }
.scroll { overflow-x:auto; background:var(--card-background-color); border-radius:12px; margin:10px 0; box-shadow:var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.15)); }
table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { padding:8px 6px; text-align:center; border-bottom:1px solid var(--divider-color); white-space:nowrap; }
th { font-weight:500; font-size:13px; }
td.fach { text-align:left; }
td.b, .b { font-weight:600; }
i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
.legend { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:13px; margin:4px 2px; }
.chart svg { width:100%; height:auto; display:block; }
.chart .grid { stroke:var(--divider-color); stroke-width:1; }
.chart .ax { fill:var(--secondary-text-color); font-size:11px; }
.srow, .ttrow { display:flex; align-items:center; gap:8px; margin:6px 0; }
.srow input[type=color] { width:38px; height:34px; padding:0; border:0; background:none; }
.pn { width:24px; text-align:right; color:var(--secondary-text-color); }
.goal { display:grid; grid-template-columns: minmax(80px, 1.2fr) 2fr auto; align-items:center; gap:8px; margin:8px 0; font-size:14px; }
.grow { display:flex; justify-content:space-between; align-items:center; margin:8px 0; }
.gname { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gname .meta { font-size:12px; color:var(--secondary-text-color); margin-left:16px; }
.gnum { font-weight:600; min-width:52px; text-align:right; }
.bar { height:12px; border-radius:6px; background:var(--divider-color); overflow:hidden; }
.bar div { height:100%; border-radius:6px; background:var(--primary-color); transition:width .4s; }
.bar.big { height:16px; margin:10px 0 6px; }
.stepper.sm button { width:38px; height:38px; font-size:22px; }
.gv { min-width:32px; text-align:center; font-size:20px; font-weight:600; }
.star { font-size:18px; font-weight:600; margin:4px 0 8px; }
.lvl { text-align:center; }
.lvl .li { font-size:48px; line-height:1.2; }
.lvl .lt { font-size:18px; }
.tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:10px 0; }
.tile { background:var(--card-background-color); border-radius:12px; padding:10px 6px; text-align:center; box-shadow:var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.15)); }
.tv { font-size:22px; font-weight:600; }
.tl { font-size:12px; color:var(--secondary-text-color); }
.badges { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:10px; }
.badge { text-align:center; padding:8px 4px; border-radius:10px; background:var(--primary-background-color); }
.badge.locked { opacity:.35; filter:grayscale(1); }
.bi { font-size:30px; }
.bt { font-size:13px; font-weight:600; margin-top:2px; }
.bd { font-size:11px; color:var(--secondary-text-color); }
.rec { display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid var(--divider-color); font-size:14px; }
.rec span:nth-child(2) { flex:1; }
.ri { font-size:18px; }
.ms { margin:10px 0; }
.ms .lbl { font-size:14px; font-weight:500; margin-bottom:4px; }
.ms select, .txt, input[type=time] { font:inherit; padding:7px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); }
.ms select, .txt { width:100%; box-sizing:border-box; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.chip { display:inline-flex; align-items:center; gap:2px; background:var(--primary-background-color); border:1px solid var(--divider-color); border-radius:16px; padding:2px 4px 2px 10px; font-size:13px; }
.chip .x { border:0; background:none; padding:2px 6px; color:var(--secondary-text-color); }
.toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#323232; color:#fff; padding:10px 18px; border-radius:8px; font-size:14px; z-index:10; }
`;

customElements.define("meldetracker-panel", MeldetrackerPanel);
