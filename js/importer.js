// Import: Mitgliederliste (CSV) und Daten der alten App (JSON). Reine Logik, in Node testbar.
import {
  DEFAULT_TIME, attendanceId, compareMembers, createRegularSession, isMonday, isValidIsoDate, randomId,
} from './model.js';

/* ---------------- Datei lesen ---------------- */

/**
 * Bytes -> Text. UTF-8 (mit oder ohne BOM) ist Standard. Ist die Datei kein gueltiges UTF-8
 * (typisch: Excel "CSV (Trennzeichen-getrennt)"), wird Windows-1252 angenommen und gemeldet.
 */
export function decodeText(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch (e) {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** CSV mit Semikolon parsen (Anfuehrungszeichen, "" und Umbrueche in Feldern werden unterstuetzt). */
export function parseCsv(text, sep = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/* ---------------- Mitglieder-CSV ---------------- */

export const MEMBER_CSV_HEADER = ['Mitgliedsnummer', 'Nachname', 'Vorname', 'Gruppe'];

/**
 * Text -> { rows: [{mitgliedsnummer, nachname, vorname, gruppe, line}], errors: [{line, message}], hasHeader }
 * Kopfzeile wird erkannt (Gross-/Kleinschreibung egal); fehlt sie, gilt die Spaltenreihenfolge oben.
 */
export function parseMemberCsv(text) {
  const raw = parseCsv(text);
  const errors = [];
  const rows = [];
  if (!raw.length) return { rows, errors: [{ line: 0, message: 'Die Datei ist leer.' }], hasHeader: false };
  const norm = (v) => String(v).trim().toLowerCase();
  const hasHeader = norm(raw[0][0]) === 'mitgliedsnummer' && norm(raw[0][1] || '') === 'nachname';
  const seen = new Map();
  raw.forEach((r, i) => {
    if (hasHeader && i === 0) return;
    const line = i + 1;
    const [nr = '', nachname = '', vorname = '', gruppe = ''] = r.map((f) => f.trim());
    if (r.length < 3) { errors.push({ line, message: 'Zu wenige Spalten (erwartet: Mitgliedsnummer;Nachname;Vorname;Gruppe).' }); return; }
    if (!nr) { errors.push({ line, message: `Mitgliedsnummer fehlt (${vorname} ${nachname}).` }); return; }
    if (!nachname && !vorname) { errors.push({ line, message: `Name fehlt bei Nummer ${nr}.` }); return; }
    if (seen.has(nr)) { errors.push({ line, message: `Nummer ${nr} doppelt (auch in Zeile ${seen.get(nr)}).` }); return; }
    seen.set(nr, line);
    rows.push({ mitgliedsnummer: nr, nachname, vorname, gruppe, line });
  });
  return { rows, errors, hasHeader };
}

const nameKey = (m) => `${m.nachname}|${m.vorname}`.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Abgleich Mitgliederliste mit dem Bestand (Gaeste bleiben unberuehrt):
 *  - gleiche Mitgliedsnummer -> aktualisieren (und ggf. wieder aktivieren)
 *  - Mitglied ohne Nummer mit gleichem Nach- und Vornamen -> bekommt die Nummer (z. B. aus den Startdaten)
 *  - neue Nummer -> neu anlegen
 *  - Mitglied nicht mehr in der Liste -> deaktivieren (nie loeschen, Historie bleibt)
 * Liefert { create, update: [{before, after}], deactivate: [{before, after}], unchanged }.
 */
export function planMemberImport(members, rows, idFn = randomId) {
  const plan = { create: [], update: [], deactivate: [], unchanged: [] };
  const regular = members.filter((m) => !m.gast);
  const byNr = new Map(regular.filter((m) => m.mitgliedsnummer).map((m) => [m.mitgliedsnummer, m]));
  const withoutNr = new Map();
  for (const m of regular) if (!m.mitgliedsnummer && !withoutNr.has(nameKey(m))) withoutNr.set(nameKey(m), m);
  const matched = new Set();

  for (const r of rows) {
    let before = byNr.get(r.mitgliedsnummer);
    if (!before) {
      const byName = withoutNr.get(nameKey(r));
      if (byName && !matched.has(byName.id)) before = byName;
    }
    if (!before) {
      plan.create.push({
        id: idFn('M-'), mitgliedsnummer: r.mitgliedsnummer, vorname: r.vorname, nachname: r.nachname,
        gruppe: r.gruppe, gast: false, temporaereId: '', aktiv: true,
      });
      continue;
    }
    matched.add(before.id);
    const after = { ...before, mitgliedsnummer: r.mitgliedsnummer, vorname: r.vorname, nachname: r.nachname, gruppe: r.gruppe, aktiv: true };
    const changed = ['mitgliedsnummer', 'vorname', 'nachname', 'gruppe', 'aktiv'].some((k) => before[k] !== after[k]);
    if (changed) plan.update.push({ before, after });
    else plan.unchanged.push(before);
  }
  for (const m of regular) {
    if (!matched.has(m.id) && m.aktiv) plan.deactivate.push({ before: m, after: { ...m, aktiv: false } });
  }
  plan.create.sort(compareMembers);
  plan.update.sort((a, b) => compareMembers(a.after, b.after));
  plan.deactivate.sort((a, b) => compareMembers(a.before, b.before));
  return plan;
}

/** Alle zu speichernden Mitglieds-Datensaetze eines Plans. */
export function planRecords(plan) {
  return [...plan.create, ...plan.update.map((u) => u.after), ...plan.deactivate.map((d) => d.after)];
}

/* ---------------- Daten der alten App (Version 1) ---------------- */

export function isLegacyBackup(data) {
  return Boolean(data && data.app === 'anwesenheit' && Array.isArray(data.groups) && Array.isArray(data.participants));
}

/**
 * Sicherung/Startdaten der alten App -> neues Datenmodell.
 * Gruppen-ID -> Gruppenname, Notiz -> Mitglied.notiz, Trainings "Datum|Gruppe" -> eine Einheit je Datum
 * (Montag = regulaere Einheit, andere Tage = Sondertermin), 'y' -> anwesend, 'n' -> nicht anwesend.
 */
export function convertLegacyBackup(data, idFn = randomId, uhrzeit = DEFAULT_TIME) {
  if (!isLegacyBackup(data)) throw new Error('Das ist keine Datei der bisherigen Anwesenheits-App.');
  const groupName = new Map(data.groups.map((g) => [g.id, String(g.name || '').trim()]));
  const idMap = new Map();
  const members = data.participants.map((p) => {
    const m = {
      id: idFn('M-'),
      mitgliedsnummer: '',
      vorname: String(p.first || '').trim(),
      nachname: String(p.last || '').trim(),
      gruppe: groupName.get(p.groupId) || '',
      gast: false,
      temporaereId: '',
      aktiv: !(p.active === false || p.archived === true || p.removed === true),
    };
    const note = String(p.note || '').trim();
    if (note) m.notiz = note;
    idMap.set(p.id, m.id);
    return m;
  });

  const sessions = new Map();
  const attendance = [];
  const skipped = [];
  const geaendert = new Date().toISOString();
  for (const [key, marks] of Object.entries(data.sessions || {})) {
    const datum = key.split('|')[0];
    if (!isValidIsoDate(datum)) { skipped.push(key); continue; }
    let s = [...sessions.values()].find((x) => x.datum === datum);
    if (!s) {
      s = isMonday(datum)
        ? createRegularSession(datum, uhrzeit)
        : { id: 'S-' + datum + '-alt', datum, uhrzeit, sondertermin: true };
      sessions.set(s.id, s);
    }
    for (const [pid, v] of Object.entries(marks || {})) {
      const mid = idMap.get(pid);
      if (!mid || (v !== 'y' && v !== 'n')) continue;
      attendance.push({ id: attendanceId(s.id, mid), einheitId: s.id, mitgliedId: mid, anwesend: v === 'y', bemerkung: '', geaendert });
    }
  }
  const groups = data.groups.map((g) => String(g.name || '').trim()).filter(Boolean);
  return { members, sessions: [...sessions.values()], attendance, groups, skipped };
}
