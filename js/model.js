// Datenmodell und reine Logik (ohne DOM, ohne Speicher) - in Node testbar.
// Datumswerte sind immer ISO-Strings 'JJJJ-MM-TT' ohne Uhrzeit; gerechnet wird in UTC,
// damit Sommer-/Winterzeit keine Tage verschiebt.

export const DEFAULT_TIME = '18:00';
const DAY_MS = 86400000;
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/* ---------------- IDs ---------------- */

export function randomId(prefix = '') {
  const c = globalThis.crypto;
  const raw = c && c.randomUUID ? c.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return prefix + raw;
}

/* ---------------- Datum / Uhrzeit ---------------- */

const pad = (n, len = 2) => String(n).padStart(len, '0');

export function isValidIsoDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isValidTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** Lokales Datum (z. B. new Date()) als ISO-String. */
export function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoToUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToIso(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(iso, n) {
  return utcToIso(isoToUtc(iso) + n * DAY_MS);
}

/** 0 = Sonntag, 1 = Montag, ... 6 = Samstag */
export function weekday(iso) {
  return new Date(isoToUtc(iso)).getUTCDay();
}

export const isMonday = (iso) => weekday(iso) === 1;

/** Der heutige Tag, falls Montag, sonst der letzte Montag davor. */
export function lastMondayOnOrBefore(iso) {
  return addDays(iso, -((weekday(iso) + 6) % 7));
}

export function nextMondayOnOrAfter(iso) {
  return addDays(iso, (8 - weekday(iso)) % 7);
}

/** Alle Montage im Bereich [fromIso, toIso], beide Grenzen eingeschlossen. */
export function mondaysBetween(fromIso, toIso) {
  const result = [];
  for (let d = nextMondayOnOrAfter(fromIso); d <= toIso; d = addDays(d, 7)) result.push(d);
  return result;
}

/** 'JJJJ-MM-TT' -> 'TT.MM.JJJJ' */
export function formatDateDe(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export function weekdayNameDe(iso) {
  return WEEKDAYS_DE[weekday(iso)];
}

/* ---------------- Trainingseinheiten ---------------- */

/** Regulaere Montags-Einheit: ID ist aus dem Datum abgeleitet, damit sie nie doppelt entsteht. */
export function regularSessionId(iso) {
  return 'R-' + iso;
}

export function createRegularSession(iso, uhrzeit = DEFAULT_TIME) {
  if (!isValidIsoDate(iso) || !isMonday(iso)) throw new Error('Regulaere Einheiten liegen immer auf einem Montag.');
  if (!isValidTime(uhrzeit)) throw new Error('Ungueltige Uhrzeit.');
  return { id: regularSessionId(iso), datum: iso, uhrzeit, sondertermin: false };
}

export function createSpecialSession(iso, uhrzeit = DEFAULT_TIME, idFn = randomId) {
  if (!isValidIsoDate(iso)) throw new Error('Ungueltiges Datum.');
  if (!isValidTime(uhrzeit)) throw new Error('Ungueltige Uhrzeit.');
  return { id: idFn('S-'), datum: iso, uhrzeit, sondertermin: true };
}

/**
 * Liefert die Montags-Einheiten im Bereich, die noch fehlen.
 * Bereits vorhandene (auch mit geaenderter Uhrzeit) werden nicht angetastet.
 */
export function missingMondaySessions(existingSessions, fromIso, toIso, uhrzeit = DEFAULT_TIME) {
  const known = new Set(existingSessions.map((s) => s.id));
  return mondaysBetween(fromIso, toIso)
    .filter((iso) => !known.has(regularSessionId(iso)))
    .map((iso) => createRegularSession(iso, uhrzeit));
}

export function compareSessions(a, b) {
  return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : a.uhrzeit < b.uhrzeit ? -1 : a.uhrzeit > b.uhrzeit ? 1 : 0;
}

/**
 * Blaettern mit ‹ ›: naechste Einheit vor/nach der aktuellen. Kandidaten sind alle vorhandenen
 * Einheiten plus der benachbarte Montag (der bei Bedarf neu angelegt wird).
 * Liefert { session, isNew }.
 */
export function neighborSession(sessions, current, dir, uhrzeit = DEFAULT_TIME) {
  const mondayBase = dir < 0 ? lastMondayOnOrBefore(addDays(current.datum, -1)) : nextMondayOnOrAfter(addDays(current.datum, 1));
  const candidates = sessions.filter((s) => s.id !== current.id);
  const mondayId = regularSessionId(mondayBase);
  const isNew = !sessions.some((s) => s.id === mondayId);
  if (isNew) candidates.push(createRegularSession(mondayBase, uhrzeit));
  const side = candidates.filter((s) => (dir < 0 ? compareSessions(s, current) < 0 : compareSessions(s, current) > 0));
  side.sort(compareSessions);
  const session = dir < 0 ? side[side.length - 1] : side[0];
  return { session, isNew: isNew && session.id === mondayId };
}

/* ---------------- Mitglieder und Gaeste ---------------- */

const clean = (v) => String(v ?? '').trim();

export function createMember({ mitgliedsnummer, vorname, nachname, gruppe }, idFn = randomId) {
  const m = {
    id: idFn('M-'),
    mitgliedsnummer: clean(mitgliedsnummer),
    vorname: clean(vorname),
    nachname: clean(nachname),
    gruppe: clean(gruppe),
    gast: false,
    temporaereId: '',
    aktiv: true,
  };
  if (!m.vorname && !m.nachname) throw new Error('Name fehlt.');
  return m;
}

/** Naechste freie Gast-ID (G-001, G-002, ...). Vergebene Nummern werden nie wiederverwendet. */
export function nextGuestId(members) {
  let max = 0;
  for (const m of members) {
    const hit = /^G-(\d+)$/.exec(m.temporaereId || '');
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return 'G-' + pad(max + 1, 3);
}

/**
 * Ein Eingabefeld fuer den Gastnamen: letztes Wort = Nachname, Rest = Vorname.
 * Nur ein Wort: Vorname = Wort, Nachname = 'Gast' (wie im Muster-Export "G-001;Gast;Lena").
 */
export function splitGuestName(input) {
  const words = clean(input).split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('Bitte einen Namen eingeben.');
  if (words.length === 1) return { vorname: words[0], nachname: 'Gast' };
  return { vorname: words.slice(0, -1).join(' '), nachname: words[words.length - 1] };
}

export function createGuest(nameInput, existingMembers, gruppe = '', idFn = randomId) {
  const { vorname, nachname } = splitGuestName(nameInput);
  return {
    id: idFn('M-'),
    mitgliedsnummer: '',
    vorname,
    nachname,
    gruppe: clean(gruppe),
    gast: true,
    temporaereId: nextGuestId(existingMembers),
    aktiv: true,
  };
}

/** Wert fuer die Spalte "Mitgliedsnummer": bei Gaesten die temporaere ID. */
export function memberNumberForExport(m) {
  return m.gast ? m.temporaereId : m.mitgliedsnummer;
}

/** Prueft, ob eine Mitgliedsnummer schon vergeben ist (leere Nummern zaehlen nicht). */
export function isNumberTaken(members, nummer, exceptId = null) {
  const n = clean(nummer);
  if (!n) return false;
  return members.some((m) => m.id !== exceptId && !m.gast && m.mitgliedsnummer === n);
}

export function compareMembers(a, b) {
  return collator.compare(a.nachname, b.nachname) || collator.compare(a.vorname, b.vorname);
}

export function compareText(a, b) {
  return collator.compare(a, b);
}

/* ---------------- Anwesenheit ---------------- */

export function attendanceId(einheitId, mitgliedId) {
  return einheitId + '|' + mitgliedId;
}

/** Neuer oder geaenderter Anwesenheitseintrag; nur die uebergebenen Felder werden ueberschrieben. */
export function upsertAttendance(existing, { einheitId, mitgliedId, anwesend, bemerkung }, now = new Date()) {
  const base = existing || {
    id: attendanceId(einheitId, mitgliedId),
    einheitId,
    mitgliedId,
    anwesend: false,
    bemerkung: '',
  };
  return {
    ...base,
    anwesend: anwesend === undefined ? base.anwesend : Boolean(anwesend),
    bemerkung: bemerkung === undefined ? base.bemerkung : clean(bemerkung),
    geaendert: now.toISOString(),
  };
}
