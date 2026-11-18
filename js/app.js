// Oberflaeche. Daten nur ueber db.js (IndexedDB), Logik in model.js/export.js.
// Inhalte aus Daten werden ausschliesslich per textContent eingesetzt (kein innerHTML).
import * as db from './db.js';
import {
  DEFAULT_TIME, attendanceId, compareMembers, compareText, createGuest, createMember, createSpecialSession,
  isNumberTaken,
  formatDateDe, isValidIsoDate, isValidTime, lastMondayOnOrBefore, missingMondaySessions, neighborSession,
  regularSessionId, toIsoDate, upsertAttendance, weekdayNameDe,
} from './model.js';
import { buildExportRows, csvToBytes, exportFileName, rowsToCsv } from './export.js';
import {
  convertLegacyBackup, decodeText, isLegacyBackup, parseMemberCsv, planMemberImport, planRecords,
} from './importer.js';
import { backupDue, backupFileName, buildBackup, parseBackup } from './backup.js';

const APP_VERSION = '1.0.0';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const stores = { members: new Map(), sessions: new Map(), attendance: new Map() };
const state = { settings: {}, current: null, undo: [], editMember: null };
const UNDO_MAX = 30;
const LONG_PRESS_MS = 550;

/* ================= Speichern + Rueckgaengig ================= */

async function persist(puts = {}, dels = {}) {
  try {
    await db.apply(puts, dels);
  } catch (e) {
    toast('⚠ Speichern fehlgeschlagen – bitte Sicherung exportieren!');
    throw e;
  }
  // gleiche Reihenfolge wie in db.apply: erst loeschen, dann schreiben
  for (const [s, ids] of Object.entries(dels)) for (const id of ids) stores[s].delete(id);
  for (const [s, recs] of Object.entries(puts)) for (const r of recs) stores[s].set(r.id, r);
}

/** Aenderung speichern und als ein Rueckgaengig-Schritt merken. */
async function commit(label, puts = {}, dels = {}) {
  const before = [];
  for (const [s, recs] of Object.entries(puts)) for (const r of recs) before.push([s, r.id, stores[s].get(r.id) ?? null]);
  for (const [s, ids] of Object.entries(dels)) for (const id of ids) before.push([s, id, stores[s].get(id) ?? null]);
  await persist(puts, dels);
  state.undo.push({ label, before });
  if (state.undo.length > UNDO_MAX) state.undo.shift();
}

async function undo() {
  const entry = state.undo.pop();
  if (!entry) return;
  const puts = {};
  const dels = {};
  for (const [s, id, prev] of entry.before) {
    if (prev) (puts[s] ||= []).push(prev);
    else (dels[s] ||= []).push(id);
  }
  await persist(puts, dels);
  if (state.current && !stores.sessions.has(state.current.id)) state.current = fallbackSession();
  else if (state.current) state.current = stores.sessions.get(state.current.id);
  toast('Rückgängig: ' + entry.label);
  render();
}

async function setPref(key, value) {
  state.settings[key] = value;
  try { await db.setSetting(key, value); } catch (e) { /* Einstellung ist nicht kritisch */ }
}

/* ================= Hilfen ================= */

const defaultTime = () => state.settings.uhrzeit || DEFAULT_TIME;
const todayIso = () => toIsoDate(new Date());
const fullName = (m) => [m.vorname, m.nachname].filter(Boolean).join(' ');
const vibrate = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) { /* egal */ } };

function fallbackSession() {
  return stores.sessions.get(regularSessionId(lastMondayOnOrBefore(todayIso())));
}

const DEFAULT_GROUPS = ['I. Gruppe (Bronze/Silber)', 'II. Gruppe (ab JSA Gold)', 'III. Gruppe (Rettung)'];

/** Kurzname fuer Knoepfe: Text in Klammern, sonst der ganze Name ("I. Gruppe (Bronze/Silber)" -> "Bronze/Silber"). */
function groupLabel(g) {
  const hit = /\(([^)]+)\)\s*$/.exec(g);
  return hit ? hit[1] : g;
}

/** Trainingsgruppen: feste Reihenfolge aus den Einstellungen, danach weitere Gruppen aus den Mitgliedsdaten. */
function groups() {
  const fixed = groupsSetting();
  const extra = new Set();
  for (const m of stores.members.values()) if (m.gruppe && m.aktiv && !fixed.includes(m.gruppe)) extra.add(m.gruppe);
  return [...fixed, ...[...extra].sort(compareText)];
}

function visiblePeople() {
  const cur = state.current;
  const filter = state.settings.gruppe || '';
  return [...stores.members.values()]
    .filter((m) => (m.aktiv && !m.gast) || stores.attendance.has(attendanceId(cur.id, m.id)))
    .filter((m) => !filter || m.gruppe === filter)
    .sort(compareMembers);
}

let toastTimer = null;
function toast(text, withUndo = false) {
  $('toast-text').textContent = text;
  $('toast-undo').hidden = !withUndo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, withUndo ? 5000 : 3500);
}

/* ================= Anzeige ================= */

function render() {
  renderSession();
  renderFilter();
  renderList();
  $('undo').disabled = state.undo.length === 0;
  $('backup-banner').hidden = !backupDue([...stores.attendance.values()], state.settings.letztesBackup);
}

function renderSession() {
  const s = state.current;
  $('session-date').textContent = `${weekdayNameDe(s.datum)}, ${formatDateDe(s.datum)}`;
  const sub = $('session-sub');
  sub.textContent = s.uhrzeit + ' Uhr';
  if (s.datum === todayIso()) sub.append(' · heute');
  if (s.sondertermin) { sub.append(' '); sub.append(el('span', 'badge', 'Sondertermin')); }
  if (s.ausgefallen) { sub.append(' '); sub.append(el('span', 'badge', 'fällt aus')); }
  $('cancel-banner').hidden = !s.ausgefallen;
}

function renderFilter() {
  const current = state.settings.gruppe || '';
  const list = groups();
  const options = [['', 'Alle'], ...list.map((g) => [g, groupLabel(g)])];
  if (current && !list.includes(current)) options.push([current, current]);
  $('group-filter').replaceChildren(...options.map(([value, label]) => {
    const b = el('button', 'seg', label);
    b.type = 'button';
    b.dataset.group = value;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    if (label !== value && value) b.title = value;
    return b;
  }));
  $('group-list').replaceChildren(...list.map((g) => new Option(g)));
}

function renderList() {
  const cur = state.current;
  const details = Boolean(state.settings.details);
  $('details-toggle').checked = details;
  const people = visiblePeople();
  let present = 0;
  const items = people.map((m) => {
    const a = stores.attendance.get(attendanceId(cur.id, m.id));
    const yes = Boolean(a && a.anwesend);
    if (yes) present++;
    const li = el('li', 'row' + (yes ? ' is-yes' : '') + (cur.ausgefallen ? ' is-locked' : ''));
    li.dataset.id = m.id;
    const main = el('div', 'row-main');
    const name = el('button', 'row-name');
    name.type = 'button';
    name.dataset.action = 'edit';
    name.append(el('span', 'last', m.nachname), ', ', el('span', 'first', m.vorname));
    name.setAttribute('aria-label', `${fullName(m)} bearbeiten`);
    main.append(name);
    if (m.gast) main.append(el('span', 'badge row-tag', 'Gast'));
    if (!m.aktiv) main.append(el('span', 'badge row-tag', 'inaktiv'));
    if (details) {
      const note = a && a.bemerkung;
      main.append(el('div', 'row-note' + (note ? '' : ' empty'), note || 'keine Bemerkung'));
    }
    const yn = el('button', 'yn', yes ? 'JA' : 'NEIN');
    yn.type = 'button';
    yn.setAttribute('aria-pressed', String(yes));
    yn.setAttribute('aria-label', `${fullName(m)} anwesend`);
    li.append(main, yn);
    return li;
  });
  $('list').replaceChildren(...items);
  $('counter').replaceChildren('Anwesend: ', el('b', '', `${present} / ${people.length}`));
  $('empty-hint').hidden = stores.members.size > 0;
}

/* ================= Aktionen ================= */

async function toggle(memberId) {
  const cur = state.current;
  if (cur.ausgefallen) { toast('Training fällt aus – oben auf das Datum tippen, um das zu ändern.'); return; }
  const m = stores.members.get(memberId);
  const id = attendanceId(cur.id, memberId);
  const prev = stores.attendance.get(id) || null;
  const next = upsertAttendance(prev, { einheitId: cur.id, mitgliedId: memberId, anwesend: !(prev && prev.anwesend) });
  vibrate();
  await commit(`${fullName(m)}: ${next.anwesend ? 'JA' : 'NEIN'}`, { attendance: [next] });
  render();
}

async function go(dir) {
  const { session, isNew } = neighborSession([...stores.sessions.values()], state.current, dir, defaultTime());
  if (!session) return;
  if (isNew) await persist({ sessions: [session] });
  state.current = stores.sessions.get(session.id);
  render();
  window.scrollTo(0, 0);
}

/* ---------- Dialog: Person bearbeiten ---------- */

function openEdit(memberId) {
  const m = stores.members.get(memberId);
  const cur = state.current;
  const a = stores.attendance.get(attendanceId(cur.id, memberId));
  state.editMember = memberId;
  $('dlg-edit-title').textContent = `${m.nachname}, ${m.vorname}`;
  const sub = m.gast ? `Gast ${m.temporaereId}` : (m.mitgliedsnummer ? `Mitgliedsnr. ${m.mitgliedsnummer}` : 'ohne Mitgliedsnummer');
  $('dlg-edit-sub').textContent = `${sub} · ${weekdayNameDe(cur.datum)}, ${formatDateDe(cur.datum)}`;
  $('edit-note').value = (a && a.bemerkung) || '';
  $('edit-group').value = m.gruppe || '';
  $('dlg-edit').showModal();
}

async function saveEdit() {
  const m = stores.members.get(state.editMember);
  const cur = state.current;
  const id = attendanceId(cur.id, m.id);
  const prev = stores.attendance.get(id) || null;
  const note = $('edit-note').value.trim();
  const group = $('edit-group').value.trim();
  const puts = {};
  if ((prev ? prev.bemerkung : '') !== note) {
    puts.attendance = [upsertAttendance(prev, { einheitId: cur.id, mitgliedId: m.id, bemerkung: note })];
  }
  if ((m.gruppe || '') !== group) puts.members = [{ ...m, gruppe: group }];
  if (!Object.keys(puts).length) return;
  await commit(`Änderung bei ${fullName(m)}`, puts);
  toast(`Gespeichert: ${fullName(m)}`, true);
  render();
}

/* ---------- Dialog: Neuer Gast ---------- */

function openGuest() {
  if (state.current.ausgefallen) { toast('Training fällt aus – Eintragen ist gesperrt.'); return; }
  $('guest-name').value = '';
  $('guest-error').hidden = true;
  const cur = state.current;
  const known = [...stores.members.values()]
    .filter((m) => m.gast && m.aktiv && !stores.attendance.get(attendanceId(cur.id, m.id))?.anwesend)
    .sort(compareMembers);
  $('known-guests').replaceChildren(...known.map((g) => {
    const b = el('button', 'chip', `${fullName(g)} (${g.temporaereId})`);
    b.type = 'button';
    b.addEventListener('click', async () => {
      $('dlg-guest').close();
      await markGuestPresent(g);
    });
    return b;
  }));
  $('known-guests-wrap').hidden = known.length === 0;
  $('dlg-guest').showModal();
}

async function markGuestPresent(g) {
  const cur = state.current;
  const prev = stores.attendance.get(attendanceId(cur.id, g.id)) || null;
  const a = upsertAttendance(prev, { einheitId: cur.id, mitgliedId: g.id, anwesend: true });
  await commit(`Gast ${fullName(g)} eingetragen`, { attendance: [a] });
  toast(`Gast ${fullName(g)} ist eingetragen.`, true);
  render();
}

async function saveGuest() {
  let g;
  try {
    g = createGuest($('guest-name').value, [...stores.members.values()], state.settings.gruppe || '');
  } catch (e) {
    $('guest-error').textContent = e.message;
    $('guest-error').hidden = false;
    return false;
  }
  const a = upsertAttendance(null, { einheitId: state.current.id, mitgliedId: g.id, anwesend: true });
  await commit(`Gast ${fullName(g)} angelegt`, { members: [g], attendance: [a] });
  toast(`Gast ${fullName(g)} (${g.temporaereId}) ist eingetragen.`, true);
  render();
  return true;
}

/* ---------- Dialog: Einheit ---------- */

function openSession() {
  const s = state.current;
  $('session-time').value = s.uhrzeit;
  $('session-cancelled').checked = Boolean(s.ausgefallen);
  $('special-date').value = todayIso();
  $('special-time').value = defaultTime();
  $('session-delete').hidden = !s.sondertermin;
  $('dlg-session').showModal();
}

async function saveSession() {
  const s = state.current;
  const time = $('session-time').value;
  if (!isValidTime(time)) { toast('Bitte eine gültige Uhrzeit eingeben.'); return false; }
  const cancelled = $('session-cancelled').checked;
  if (time === s.uhrzeit && cancelled === Boolean(s.ausgefallen)) return true;
  const next = { ...s, uhrzeit: time, ausgefallen: cancelled };
  await commit(`Einheit ${formatDateDe(s.datum)} geändert`, { sessions: [next] });
  state.current = next;
  render();
  return true;
}

async function createSpecial() {
  const date = $('special-date').value;
  const time = $('special-time').value;
  if (!isValidIsoDate(date) || !isValidTime(time)) { toast('Bitte Datum und Uhrzeit angeben.'); return false; }
  const s = createSpecialSession(date, time);
  await commit(`Sondertermin ${formatDateDe(date)} angelegt`, { sessions: [s] });
  state.current = s;
  toast(`Sondertermin ${formatDateDe(date)}, ${time} Uhr angelegt.`, true);
  render();
  return true;
}

async function deleteSpecial() {
  const s = state.current;
  if (!s.sondertermin) return true;
  const entries = [...stores.attendance.values()].filter((a) => a.einheitId === s.id);
  const ok = window.confirm(
    `Sondertermin ${formatDateDe(s.datum)}, ${s.uhrzeit} Uhr löschen?\n${entries.length} Einträge gehen dabei verloren.`,
  );
  if (!ok) return false;
  const prev = neighborSession([...stores.sessions.values()], s, -1, defaultTime());
  await commit(`Sondertermin ${formatDateDe(s.datum)} gelöscht`, {}, { sessions: [s.id], attendance: entries.map((a) => a.id) });
  if (prev.isNew) await persist({ sessions: [prev.session] });
  state.current = stores.sessions.get(prev.session.id);
  toast('Sondertermin gelöscht.', true);
  render();
  return true;
}

/* ---------- Export ---------- */

function exportRange() {
  const type = $('exp-type').value;
  if (type === 'month') {
    const [y, m] = ($('exp-month').value || '').split('-').map(Number);
    return y && m ? { type, year: y, month: m } : null;
  }
  if (type === 'year') {
    const y = Number($('exp-year').value);
    return y >= 2000 && y <= 2100 ? { type, year: y } : null;
  }
  if (type === 'range') {
    const from = $('exp-from').value;
    const to = $('exp-to').value;
    return isValidIsoDate(from) && isValidIsoDate(to) && from <= to ? { type, from, to } : null;
  }
  return { type: 'all' };
}

function exportData(range) {
  return {
    members: [...stores.members.values()],
    sessions: [...stores.sessions.values()],
    attendance: [...stores.attendance.values()],
    range,
  };
}

function updateExportUi() {
  const type = $('exp-type').value;
  $('exp-month-field').hidden = type !== 'month';
  $('exp-year-field').hidden = type !== 'year';
  $('exp-range-field').hidden = type !== 'range';
  const range = exportRange();
  if (!range) { $('exp-info').textContent = 'Bitte den Zeitraum vollständig angeben.'; return; }
  const rows = buildExportRows(exportData(range));
  const units = new Set(rows.map((r) => r[4] + r[5])).size;
  $('exp-info').textContent = rows.length
    ? `${units} Einheit(en), ${rows.length} Zeilen → ${exportFileName(range)}`
    : 'Keine Einträge in diesem Zeitraum.';
}

async function shareOrDownload(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'aborted';
    // sonst: Fallback Download
  }
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

async function runExport() {
  const range = exportRange();
  if (!range) { toast('Bitte den Zeitraum vollständig angeben.'); return; }
  const rows = buildExportRows(exportData(range));
  if (!rows.length) { toast('Keine Einträge in diesem Zeitraum.'); return; }
  const result = await shareOrDownload(csvToBytes(rowsToCsv(rows)), exportFileName(range), 'text/csv');
  if (result === 'downloaded') toast('Datei wurde heruntergeladen.');
}

/* ---------- Montage ergaenzen ---------- */

async function ensureMondays() {
  const thisMonday = lastMondayOnOrBefore(todayIso());
  const missing = missingMondaySessions([...stores.sessions.values()], state.settings.startDatum, thisMonday, defaultTime());
  if (missing.length) await persist({ sessions: missing });
}

/* ================= Mitglieder ================= */

const norm = (v) => String(v || '').toLocaleLowerCase('de');

function renderMembers() {
  const q = norm($('mem-search').value.trim());
  const showInactive = $('mem-show-inactive').checked;
  const all = [...stores.members.values()].sort(compareMembers);
  const shown = all.filter((m) => (showInactive || m.aktiv) &&
    (!q || [m.nachname, m.vorname, `${m.vorname} ${m.nachname}`, m.mitgliedsnummer, m.temporaereId, m.gruppe]
      .some((f) => norm(f).includes(q))));
  const active = all.filter((m) => m.aktiv && !m.gast).length;
  const guests = all.filter((m) => m.aktiv && m.gast).length;
  const inactive = all.filter((m) => !m.aktiv).length;
  $('mem-count').textContent = `${active} aktive Mitglieder · ${guests} Gäste · ${inactive} inaktiv` +
    (q ? ` – ${shown.length} Treffer` : '');
  $('mem-list').replaceChildren(...shown.map((m) => {
    const li = el('li', 'row mrow' + (m.aktiv ? '' : ' is-inactive'));
    li.dataset.id = m.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const main = el('div', 'row-main');
    const name = el('div', 'mname', `${m.nachname}, ${m.vorname}`);
    if (m.gast) name.append(' ', el('span', 'badge', 'Gast'));
    if (!m.aktiv) name.append(' ', el('span', 'badge', 'inaktiv'));
    const nr = m.gast ? m.temporaereId : (m.mitgliedsnummer ? 'Nr. ' + m.mitgliedsnummer : 'ohne Nummer');
    main.append(name, el('div', 'msub', [nr, m.gruppe].filter(Boolean).join(' · ')));
    li.append(main);
    return li;
  }));
}

function openMember(id) {
  const m = id ? stores.members.get(id) : null;
  state.editMember = id;
  $('dlg-member-title').textContent = m ? (m.gast ? 'Gast bearbeiten' : 'Mitglied bearbeiten') : 'Neues Mitglied';
  $('member-nr-field').hidden = Boolean(m && m.gast);
  $('member-guest-info').hidden = !(m && m.gast);
  if (m && m.gast) $('member-guest-info').textContent = `Gast mit vorläufiger ID ${m.temporaereId}`;
  $('member-nr').value = m ? m.mitgliedsnummer : '';
  $('member-first').value = m ? m.vorname : '';
  $('member-last').value = m ? m.nachname : '';
  $('member-group').value = m ? m.gruppe : (state.settings.gruppe || '');
  $('member-note').value = (m && m.notiz) || '';
  $('member-active').checked = m ? m.aktiv : true;
  $('member-error').hidden = true;
  renderFilter(); // Gruppen-Vorschlaege aktualisieren
  $('dlg-member').showModal();
}

function memberError(msg) {
  $('member-error').textContent = msg;
  $('member-error').hidden = false;
  return false;
}

async function saveMember() {
  const id = state.editMember;
  const old = id ? stores.members.get(id) : null;
  const nr = $('member-nr').value.trim();
  const fields = {
    vorname: $('member-first').value.trim(),
    nachname: $('member-last').value.trim(),
    gruppe: $('member-group').value.trim(),
    aktiv: $('member-active').checked,
  };
  if (!fields.vorname && !fields.nachname) return memberError('Bitte einen Namen eingeben.');
  if (!(old && old.gast) && isNumberTaken([...stores.members.values()], nr, id)) {
    return memberError(`Die Mitgliedsnummer ${nr} ist schon vergeben.`);
  }
  const note = $('member-note').value.trim();
  let rec;
  if (old) {
    rec = { ...old, ...fields };
    if (!old.gast) rec.mitgliedsnummer = nr;
  } else {
    rec = { ...createMember({ mitgliedsnummer: nr, ...fields }), aktiv: fields.aktiv };
  }
  if (note) rec.notiz = note;
  else delete rec.notiz;
  if (old && JSON.stringify(old) === JSON.stringify(rec)) return true;
  await commit(old ? `${fullName(rec)} geändert` : `${fullName(rec)} angelegt`, { members: [rec] });
  toast(old ? `Gespeichert: ${fullName(rec)}` : `Angelegt: ${fullName(rec)}`, true);
  renderMembers();
  return true;
}

/* ---------- Import mit Vorschau ---------- */

let pendingImport = null;

async function readFile(input, maxMb = 5) {
  const file = input.files && input.files[0];
  input.value = ''; // gleiche Datei erneut waehlbar
  if (!file) return null;
  if (file.size > maxMb * 1024 * 1024) { toast(`Datei ist zu groß (max. ${maxMb} MB).`); return null; }
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}

function nameList(title, lines, open = false) {
  const d = el('details');
  d.open = open;
  d.append(el('summary', '', `${title} (${lines.length})`));
  const ul = el('ul');
  ul.append(...lines.map((p) => el('li', '', p)));
  d.append(ul);
  return d;
}

function statList(pairs) {
  const ul = el('ul', 'stats');
  for (const [n, t] of pairs) {
    const li = el('li');
    li.append(el('b', '', String(n)), t);
    ul.append(li);
  }
  return ul;
}

function showImportPreview(title, nodes, okLabel, action) {
  $('dlg-import-title').textContent = title;
  $('import-body').replaceChildren(...nodes);
  $('import-ok').textContent = okLabel;
  $('import-ok').hidden = !action;
  pendingImport = action;
  $('dlg-import').showModal();
}

const personLabel = (m) =>
  `${m.nachname}, ${m.vorname}${m.mitgliedsnummer ? ' (' + m.mitgliedsnummer + ')' : ''}${m.gruppe ? ' – ' + m.gruppe : ''}`;
const errorLines = (errors) => errors.map((x) => `Zeile ${x.line}: ${x.message}`);

async function onCsvFile(e) {
  const read = await readFile(e.target);
  if (!read) return;
  const { rows, errors } = parseMemberCsv(read.text);
  const nodes = [];
  if (read.encoding !== 'utf-8') {
    nodes.push(el('p', 'warn', 'Die Datei ist nicht UTF-8 (vermutlich Excel „CSV (Trennzeichen-getrennt)“). ' +
      'Sie wurde mit Windows-Zeichensatz gelesen – bitte Umlaute in der Vorschau prüfen.'));
  }
  if (!rows.length) {
    nodes.push(el('p', 'error', 'Keine gültigen Zeilen gefunden.'));
    if (errors.length) nodes.push(nameList('Fehler', errorLines(errors), true));
    showImportPreview('Import nicht möglich', nodes, '', null);
    return;
  }
  const plan = planMemberImport([...stores.members.values()], rows);
  nodes.push(
    el('p', 'hint', `${rows.length} Mitglieder in der Datei. Gäste und die bisherige Anwesenheit bleiben erhalten.`),
    statList([
      [plan.create.length, 'neu'],
      [plan.update.length, 'geändert'],
      [plan.deactivate.length, 'werden deaktiviert'],
      [plan.unchanged.length, 'unverändert'],
      [errors.length, 'fehlerhafte Zeilen (werden übersprungen)'],
    ]),
  );
  if (plan.create.length) nodes.push(nameList('Neu', plan.create.map(personLabel)));
  if (plan.update.length) nodes.push(nameList('Geändert', plan.update.map((u) => `${personLabel(u.before)} → ${personLabel(u.after)}`)));
  if (plan.deactivate.length) nodes.push(nameList('Werden deaktiviert', plan.deactivate.map((d) => personLabel(d.before)), plan.deactivate.length <= 10));
  if (errors.length) nodes.push(nameList('Fehlerhafte Zeilen', errorLines(errors), true));
  const records = planRecords(plan);
  if (!records.length) {
    nodes.push(el('p', 'hint', 'Es gibt nichts zu ändern.'));
    showImportPreview('Vorschau Mitgliederliste', nodes, '', null);
    return;
  }
  showImportPreview('Vorschau Mitgliederliste', nodes, 'Übernehmen', async () => {
    await commit('Mitgliederliste importiert', { members: records });
    toast(`Import fertig: ${plan.create.length} neu, ${plan.update.length} geändert, ${plan.deactivate.length} deaktiviert.`, true);
    renderMembers();
    return true;
  });
}

async function onLegacyFile(e) {
  const read = await readFile(e.target);
  if (!read) return;
  let data;
  try { data = JSON.parse(read.text); } catch (err) { toast('Die Datei ist kein gültiges JSON.'); return; }
  if (!isLegacyBackup(data)) { toast('Das ist keine Datei der bisherigen Anwesenheits-App.'); return; }
  const conv = convertLegacyBackup(data, undefined, defaultTime());
  const nodes = [
    statList([
      [conv.members.length, 'Teilnehmer'],
      [conv.groups.length, 'Gruppen'],
      [conv.sessions.length, 'Trainings'],
      [conv.attendance.length, 'Anwesenheits-Einträge'],
    ]),
    nameList('Gruppen', conv.groups, true),
    el('p', 'hint', 'Mitgliedsnummern sind in der alten App nicht enthalten. Sie werden beim späteren CSV-Import über den Namen zugeordnet.'),
  ];
  if (stores.members.size || stores.attendance.size) {
    nodes.unshift(el('p', 'warn',
      `Achtung: Alle vorhandenen Daten in dieser App (${stores.members.size} Personen, ${stores.attendance.size} Einträge) werden ersetzt.`));
  }
  showImportPreview('Daten der bisherigen App übernehmen', nodes, 'Ersetzen und übernehmen', async () => {
    const dels = {
      members: [...stores.members.keys()],
      sessions: [...stores.sessions.keys()],
      attendance: [...stores.attendance.keys()],
    };
    await commit('Daten der alten App übernommen',
      { members: conv.members, sessions: conv.sessions, attendance: conv.attendance }, dels);
    const earliest = conv.sessions.map((s) => s.datum).sort()[0];
    if (earliest && earliest < state.settings.startDatum) await setPref('startDatum', lastMondayOnOrBefore(earliest));
    if (conv.groups.length) await setPref('trainingsgruppen', conv.groups);
    await setPref('gruppe', '');
    await ensureMondays();
    state.current = fallbackSession();
    toast(`${conv.members.length} Teilnehmer übernommen.`, true);
    renderMembers();
    return true;
  });
}

/* ================= Daten: Backup, Restore, Einstellungen ================= */

function formatStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${formatDateDe(toIsoDate(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} Uhr`;
}

function renderData() {
  const last = state.settings.letztesBackup;
  $('backup-last').textContent = last ? `Letzte Sicherung: ${formatStamp(last)}` : 'Noch keine Sicherung erstellt.';
  $('set-theme').value = state.settings.theme || 'auto';
  $('set-time').value = defaultTime();
  $('set-groups').value = groupsSetting().join('\n');
  $('app-version').textContent = `Version ${APP_VERSION}`;
}

async function runBackup() {
  const data = await db.readAll();
  const now = new Date();
  const bytes = new TextEncoder().encode(JSON.stringify(buildBackup(data, now), null, 1));
  const result = await shareOrDownload(bytes, backupFileName(now), 'application/json');
  if (result === 'aborted') return;
  await setPref('letztesBackup', now.toISOString());
  toast(result === 'downloaded' ? 'Sicherung wurde heruntergeladen – bitte an einen sicheren Ort schicken.' : 'Sicherung erstellt.');
  renderData();
  render();
}

async function onRestoreFile(e) {
  const read = await readFile(e.target, 50);
  if (!read) return;
  let raw;
  let data;
  try { raw = JSON.parse(read.text); } catch (err) { toast('Die Datei ist kein gültiges JSON.'); return; }
  if (isLegacyBackup(raw)) { toast('Das ist eine Datei der alten App – bitte unter „Mitglieder“ übernehmen.'); return; }
  try { data = parseBackup(raw); } catch (err) { showImportPreview('Wiederherstellen nicht möglich', [el('p', 'error', err.message)], '', null); return; }
  const nodes = [
    el('p', 'warn', `Achtung: Alle Daten auf diesem Gerät (${stores.members.size} Personen, ${stores.attendance.size} Einträge) werden durch die Sicherung ersetzt.`),
    el('p', 'hint', data.exportiert ? `Sicherung vom ${formatStamp(data.exportiert)}` : 'Sicherung ohne Datum'),
    statList([
      [data.members.filter((m) => !m.gast).length, 'Mitglieder'],
      [data.members.filter((m) => m.gast).length, 'Gäste'],
      [data.sessions.length, 'Einheiten'],
      [data.attendance.length, 'Anwesenheits-Einträge'],
    ]),
  ];
  showImportPreview('Sicherung wiederherstellen', nodes, 'Alles ersetzen', async () => {
    await commit('Sicherung wiederhergestellt',
      { members: data.members, sessions: data.sessions, attendance: data.attendance },
      { members: [...stores.members.keys()], sessions: [...stores.sessions.keys()], attendance: [...stores.attendance.keys()] });
    const oldKeys = Object.keys(state.settings);
    await db.apply({ settings: data.settings }, { settings: oldKeys });
    state.settings = Object.fromEntries(data.settings.map((s) => [s.key, s.value]));
    if (!state.settings.startDatum) await setPref('startDatum', lastMondayOnOrBefore(todayIso()));
    applyTheme();
    await ensureMondays();
    state.current = fallbackSession();
    toast('Sicherung wiederhergestellt.', true);
    renderData();
    return true;
  });
}

function groupsSetting() {
  return Array.isArray(state.settings.trainingsgruppen) ? state.settings.trainingsgruppen : DEFAULT_GROUPS;
}

async function saveSettings() {
  const time = $('set-time').value;
  if (!isValidTime(time)) { toast('Bitte eine gültige Uhrzeit eingeben.'); return; }
  const list = [...new Set($('set-groups').value.split('\n').map((g) => g.trim()).filter(Boolean))].slice(0, 8);
  await setPref('uhrzeit', time);
  await setPref('trainingsgruppen', list);
  await setPref('theme', $('set-theme').value);
  applyTheme();
  renderData();
  toast('Einstellungen gespeichert.');
}

/* ================= Navigation ================= */

const TITLES = { attendance: 'Anwesenheit', members: 'Mitglieder', data: 'Daten & Export' };
function showView(name) {
  for (const v of Object.keys(TITLES)) $('view-' + v).hidden = v !== name;
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  $('view-title').textContent = TITLES[name];
  if (name === 'data') { updateExportUi(); renderData(); }
  if (name === 'members') renderMembers();
  if (name === 'attendance') render();
  window.scrollTo(0, 0);
}

/* ================= Ereignisse ================= */

function bindDialog(dialogId, formId, handlers) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') { $(dialogId).close(); return; }
    const fn = handlers[action];
    if (!fn) return;
    const keepOpen = (await fn()) === false;
    if (!keepOpen) $(dialogId).close();
  });
}

function bindEvents() {
  $('prev').addEventListener('click', () => go(-1));
  $('next').addEventListener('click', () => go(1));
  $('session-label').addEventListener('click', openSession);
  $('details-toggle').addEventListener('change', async (e) => { await setPref('details', e.target.checked); renderList(); });
  $('group-filter').addEventListener('click', async (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    await setPref('gruppe', b.dataset.group);
    renderFilter();
    renderList();
  });
  $('undo').addEventListener('click', undo);
  $('toast-undo').addEventListener('click', () => { $('toast').hidden = true; undo(); });
  $('add-guest').addEventListener('click', openGuest);

  // Liste: Tippen = umschalten, Name tippen oder lange druecken = bearbeiten
  const list = $('list');
  let pressTimer = null;
  let pressStart = null;
  let longPressed = false;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    longPressed = false;
    pressStart = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer = setTimeout(() => { longPressed = true; vibrate(); openEdit(row.dataset.id); }, LONG_PRESS_MS);
  });
  list.addEventListener('pointermove', (e) => {
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(ev, cancelPress);
  list.addEventListener('contextmenu', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (longPressed) { longPressed = false; return; }
    if (e.target.closest('[data-action="edit"]')) openEdit(row.dataset.id);
    else toggle(row.dataset.id);
  });

  bindDialog('dlg-edit', 'form-edit', { save: saveEdit });
  bindDialog('dlg-guest', 'form-guest', { save: saveGuest });
  bindDialog('dlg-session', 'form-session', { save: saveSession, special: createSpecial, delete: deleteSpecial });

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showView(t.dataset.view));

  // Export
  const now = new Date();
  $('exp-month').value = toIsoDate(now).slice(0, 7);
  $('exp-year').value = now.getFullYear();
  $('exp-from').value = toIsoDate(now).slice(0, 8) + '01';
  $('exp-to').value = toIsoDate(now);
  for (const id of ['exp-type', 'exp-month', 'exp-year', 'exp-from', 'exp-to']) $(id).addEventListener('input', updateExportUi);
  $('exp-go').addEventListener('click', runExport);

  // Mitglieder
  $('mem-search').addEventListener('input', renderMembers);
  $('mem-show-inactive').addEventListener('change', renderMembers);
  $('mem-add').addEventListener('click', () => openMember(null));
  $('mem-list').addEventListener('click', (e) => {
    const row = e.target.closest('.mrow');
    if (row) openMember(row.dataset.id);
  });
  $('mem-list').addEventListener('keydown', (e) => {
    const row = e.target.closest('.mrow');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMember(row.dataset.id); }
  });
  bindDialog('dlg-member', 'form-member', { save: saveMember });
  bindDialog('dlg-import', 'form-import', { save: () => (pendingImport ? pendingImport() : true) });
  $('dlg-import').addEventListener('close', () => { pendingImport = null; });
  $('mem-csv').addEventListener('change', onCsvFile);
  $('mem-legacy').addEventListener('change', onLegacyFile);

  // Daten
  $('backup-go').addEventListener('click', runBackup);
  $('backup-now').addEventListener('click', runBackup);
  $('restore-file').addEventListener('change', onRestoreFile);
  $('set-save').addEventListener('click', saveSettings);
  $('set-theme').addEventListener('change', async (e) => { await setPref('theme', e.target.value); applyTheme(); });
}

/* ================= Start ================= */

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function init() {
  db.requestPersistence();
  let all;
  try {
    all = await db.readAll();
  } catch (e) {
    document.body.replaceChildren(el('p', 'banner', 'Die Datenbank kann nicht geöffnet werden (privater Modus oder Speicher gesperrt?).'));
    return;
  }
  for (const k of Object.keys(stores)) for (const r of all[k]) stores[k].set(r.id, r);
  for (const s of all.settings) state.settings[s.key] = s.value;
  applyTheme();

  if (!state.settings.startDatum) await setPref('startDatum', lastMondayOnOrBefore(todayIso()));
  await ensureMondays();
  state.current = fallbackSession();

  bindEvents();
  render();
  registerServiceWorker();
}

function registerServiceWorker() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || local)) return;
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* ohne Offline-Modus weiter */ });
}

init();

