// CSV-Export der Anwesenheit - festes Format, siehe README "Export".
import { compareMembers, compareSessions, formatDateDe, memberNumberForExport } from './model.js';

export const CSV_BOM = '﻿';
export const CSV_SEP = ';';
export const CSV_EOL = '\r\n';
export const EXPORT_HEADER = [
  'Mitgliedsnummer', 'Nachname', 'Vorname', 'Gruppe', 'Datum', 'Uhrzeit', 'Anwesend', 'Gast', 'Bemerkung',
];

/** Feld nur dann in Anfuehrungszeichen setzen, wenn es Trennzeichen, Anfuehrungszeichen oder Umbrueche enthaelt. */
export function escapeCsvField(value) {
  const s = String(value ?? '');
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const jaNein = (b) => (b ? 'ja' : 'nein');

/**
 * Zeitraum -> { from, to } als ISO-Datum (inklusive) oder null fuer "alle".
 *   { type: 'all' }
 *   { type: 'month', year: 2026, month: 11 }
 *   { type: 'year', year: 2026 }
 *   { type: 'range', from: '2026-11-01', to: '2026-11-30' }
 */
export function rangeBounds(range) {
  const p = (n) => String(n).padStart(2, '0');
  switch (range.type) {
    case 'all':
      return { from: null, to: null };
    case 'month': {
      const last = new Date(Date.UTC(range.year, range.month, 0)).getUTCDate();
      return { from: `${range.year}-${p(range.month)}-01`, to: `${range.year}-${p(range.month)}-${p(last)}` };
    }
    case 'year':
      return { from: `${range.year}-01-01`, to: `${range.year}-12-31` };
    case 'range':
      return { from: range.from, to: range.to };
    default:
      throw new Error('Unbekannter Zeitraum.');
  }
}

export function exportFileName(range) {
  const p = (n) => String(n).padStart(2, '0');
  switch (range.type) {
    case 'month':
      return `Anwesenheit_${range.year}-${p(range.month)}_Schwimmen.csv`;
    case 'year':
      return `Anwesenheit_${range.year}_Schwimmen.csv`;
    case 'range':
      return `Anwesenheit_${range.from}_bis_${range.to}_Schwimmen.csv`;
    default:
      return 'Anwesenheit_alle_Schwimmen.csv';
  }
}

/**
 * Exportzeilen bauen.
 * Je Einheit im Zeitraum, die mindestens einen Anwesenheitseintrag hat:
 *  - alle Personen mit Eintrag (auch Gaeste und inzwischen deaktivierte Mitglieder),
 *  - plus alle aktiven Nicht-Gast-Mitglieder ohne Eintrag (als "nein").
 * Einheiten ganz ohne Eintrag (nie benutzt) und als "faellt aus" markierte werden ausgelassen.
 * Sortierung: Datum, Uhrzeit, Nachname, Vorname.
 */
export function buildExportRows({ members, sessions, attendance, range = { type: 'all' } }) {
  const { from, to } = rangeBounds(range);
  const bySession = new Map();
  for (const a of attendance) {
    if (!bySession.has(a.einheitId)) bySession.set(a.einheitId, new Map());
    bySession.get(a.einheitId).set(a.mitgliedId, a);
  }
  const rows = [];
  const inRange = sessions
    .filter((s) => !s.ausgefallen && (!from || s.datum >= from) && (!to || s.datum <= to) && bySession.has(s.id))
    .sort(compareSessions);

  for (const s of inRange) {
    const entries = bySession.get(s.id);
    const people = members.filter((m) => entries.has(m.id) || (m.aktiv && !m.gast));
    people.sort(compareMembers);
    for (const m of people) {
      const a = entries.get(m.id);
      rows.push([
        memberNumberForExport(m),
        m.nachname,
        m.vorname,
        m.gruppe,
        formatDateDe(s.datum),
        s.uhrzeit,
        jaNein(a ? a.anwesend : false),
        jaNein(m.gast),
        a ? a.bemerkung : '',
      ]);
    }
  }
  return rows;
}

/** Vollstaendiger CSV-Text inkl. BOM, Kopfzeile und CRLF nach jeder Zeile. */
export function rowsToCsv(rows) {
  const lines = [EXPORT_HEADER, ...rows].map((r) => r.map(escapeCsvField).join(CSV_SEP));
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}

export function buildAttendanceCsv(data) {
  return rowsToCsv(buildExportRows(data));
}

/** Bytes (UTF-8, BOM bleibt als EF BB BF erhalten). */
export function csvToBytes(csv) {
  return new TextEncoder().encode(csv);
}
