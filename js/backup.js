// Backup (JSON) erstellen und beim Wiederherstellen streng pruefen. Reine Logik, in Node testbar.
import { isValidIsoDate, isValidTime } from './model.js';

export const BACKUP_APP = 'dlrg-anwesenheit';
export const BACKUP_FORMAT = 1;

export function buildBackup({ members, sessions, attendance, settings }, now = new Date()) {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportiert: now.toISOString(),
    members,
    sessions,
    attendance,
    settings,
  };
}

export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}`;
  return `Backup_Anwesenheit_${d}_${t}.json`;
}

/* ---------- Pruefung ---------- */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));

function fail(msg) {
  throw new Error('Backup ungültig: ' + msg);
}

function cleanMember(m, i) {
  if (!isObj(m) || typeof m.id !== 'string' || !m.id) fail(`Mitglied ${i + 1} ohne ID.`);
  const rec = {
    id: str(m.id, 100),
    mitgliedsnummer: str(m.mitgliedsnummer, 30),
    vorname: str(m.vorname, 60),
    nachname: str(m.nachname, 60),
    gruppe: str(m.gruppe, 60),
    gast: m.gast === true,
    temporaereId: str(m.temporaereId, 20),
    aktiv: m.aktiv !== false,
  };
  const note = str(m.notiz, 200);
  if (note) rec.notiz = note;
  if (!rec.vorname && !rec.nachname) fail(`Mitglied ${i + 1} ohne Namen.`);
  return rec;
}

function cleanSession(s, i) {
  if (!isObj(s) || typeof s.id !== 'string' || !s.id) fail(`Einheit ${i + 1} ohne ID.`);
  if (!isValidIsoDate(s.datum)) fail(`Einheit ${i + 1} mit ungültigem Datum.`);
  if (!isValidTime(s.uhrzeit)) fail(`Einheit ${i + 1} mit ungültiger Uhrzeit.`);
  const rec = { id: str(s.id, 100), datum: s.datum, uhrzeit: s.uhrzeit, sondertermin: s.sondertermin === true };
  if (s.ausgefallen === true) rec.ausgefallen = true;
  return rec;
}

function cleanAttendance(a, i, memberIds, sessionIds) {
  if (!isObj(a) || typeof a.id !== 'string') fail(`Anwesenheit ${i + 1} ohne ID.`);
  if (!memberIds.has(a.mitgliedId) || !sessionIds.has(a.einheitId)) fail(`Anwesenheit ${i + 1} verweist auf Unbekanntes.`);
  return {
    id: str(a.id, 220),
    einheitId: a.einheitId,
    mitgliedId: a.mitgliedId,
    anwesend: a.anwesend === true,
    bemerkung: str(a.bemerkung, 200),
    geaendert: str(a.geaendert, 40),
  };
}

const ALLOWED_SETTINGS = new Set(['details', 'gruppe', 'startDatum', 'uhrzeit', 'theme', 'trainingsgruppen', 'letztesBackup']);

/** JSON-Objekt pruefen und nur bekannte Felder uebernehmen. Wirft bei Fehlern eine verstaendliche Meldung. */
export function parseBackup(data) {
  if (!isObj(data) || data.app !== BACKUP_APP) fail('Das ist keine Sicherung dieser App.');
  if (data.format !== BACKUP_FORMAT) fail(`Unbekannte Version ${data.format}.`);
  for (const k of ['members', 'sessions', 'attendance', 'settings']) if (!Array.isArray(data[k])) fail(`"${k}" fehlt.`);
  const members = data.members.map(cleanMember);
  const sessions = data.sessions.map(cleanSession);
  const memberIds = new Set(members.map((m) => m.id));
  const sessionIds = new Set(sessions.map((s) => s.id));
  if (memberIds.size !== members.length) fail('Doppelte Mitglieds-IDs.');
  if (sessionIds.size !== sessions.length) fail('Doppelte Einheiten-IDs.');
  const attendance = data.attendance.map((a, i) => cleanAttendance(a, i, memberIds, sessionIds));
  const settings = data.settings
    .filter((s) => isObj(s) && ALLOWED_SETTINGS.has(s.key))
    .map((s) => ({ key: s.key, value: s.value }));
  return { members, sessions, attendance, settings, exportiert: str(data.exportiert, 40) };
}

/**
 * Soll an ein Backup erinnert werden? Ja, wenn es Eintraege gibt, die nach der letzten Sicherung
 * geaendert wurden, und die letzte Aenderung mindestens `quietMs` her ist (nicht mitten im Training stoeren).
 */
export function backupDue(attendance, lastBackupIso, now = new Date(), quietMs = 60 * 60 * 1000) {
  let latest = '';
  for (const a of attendance) if (a.geaendert && a.geaendert > latest) latest = a.geaendert;
  if (!latest) return false;
  if (lastBackupIso && latest <= lastBackupIso) return false;
  return now.getTime() - new Date(latest).getTime() >= quietMs;
}
