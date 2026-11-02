/** Own contacts: reading Excel/CSV files and typed text into contact rows, plus the list-contacts API. Files never leave the browser; only rows are sent. */
import { req, send } from './api';

export interface Contact { name: string; company: string; phone: string; email: string; area: string; district: string; note: string }
export type ListContact = { [K in keyof Contact]: string | null } & { id: string; source: 'manual' | 'import'; added_at: string };
export interface ImportResult { added: number; duplicates: number; rejected: { row: number; reason: string }[]; consents: number }

export const FIELDS: { key: keyof Contact; label: string; match: RegExp }[] = [
  { key: 'name', label: 'Name', match: /^(full ?)?name|contact|person|নাম/i },
  { key: 'phone', label: 'Phone / WhatsApp', match: /phone|mobile|cell|whats ?app|number|tel|ফোন|মোবাইল/i },
  { key: 'email', label: 'Email', match: /e-?mail|ইমেইল/i },
  { key: 'company', label: 'Company', match: /company|business|shop|organi[sz]ation|firm|store|প্রতিষ্ঠান/i },
  { key: 'area', label: 'Area', match: /area|thana|upazila|address|location|এলাকা/i },
  { key: 'district', label: 'District', match: /district|city|zila|জেলা/i },
  { key: 'note', label: 'Note', match: /note|comment|remark/i },
];
export const empty = (): Contact => ({ name: '', company: '', phone: '', email: '', area: '', district: '', note: '' });

/** Same rule as the server: Bangladeshi mobile → 8801XXXXXXXXX (also when Excel dropped the leading 0). */
export function bdMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('01')) d = `88${d}`;
  if (d.length === 10 && d.startsWith('1')) d = `880${d}`;
  return /^8801[3-9]\d{8}$/.test(d) ? d : null;
}
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
export const usable = (c: Contact) => !!(bdMobile(c.phone) || c.phone.replace(/[^\d]/g, '').length >= 6 || validEmail(c.email));
export type Channel = 'email' | 'whatsapp' | 'phone';
/** What a campaign or call queue on this channel can actually reach (calls take any phone number, WhatsApp only BD mobiles). */
export const reachable = (c: Contact, channel: Channel) =>
  channel === 'email' ? validEmail(c.email) : channel === 'whatsapp' ? !!bdMobile(c.phone) : !!(bdMobile(c.phone) || c.phone.replace(/[^\d]/g, '').length >= 6);

// ------------------------------------------------------------------ files
function parseCsv(text: string): string[][] {
  const sep = (text.split('\n', 1)[0]!.match(/;/g)?.length ?? 0) > (text.split('\n', 1)[0]!.match(/,/g)?.length ?? 0) ? ';' : text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Reads the first sheet of an .xlsx file, or a .csv/.txt file, as rows of text (numbers kept exactly as typed, so phone digits survive). */
export async function readTable(file: File): Promise<string[][]> {
  const ext = file.name.toLowerCase().split('.').pop();
  let rows: string[][];
  if (ext === 'xlsx') {
    const { readSheet } = await import('read-excel-file/browser'); // loaded only when someone imports a file
    const data = await readSheet<string>(file, { parseNumber: (s) => s });
    rows = data.map((r) => r.map((v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim())));
  } else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  } else if (ext === 'xls') {
    throw new Error('Old .xls files cannot be read. In Excel use File → Save As → Excel Workbook (.xlsx) or CSV, then try again.');
  } else throw new Error('Choose an Excel (.xlsx) or CSV file.');
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

/** Guesses which column holds which field from the header row; -1 = not in the file. */
export function guessMapping(header: string[]): Record<keyof Contact, number> {
  const m = Object.fromEntries(FIELDS.map((f) => [f.key, -1])) as Record<keyof Contact, number>;
  const used = new Set<number>();
  // email/phone first: "Contact email" must not become the name column
  for (const key of ['email', 'phone', 'company', 'district', 'area', 'note', 'name'] as (keyof Contact)[]) {
    const f = FIELDS.find((x) => x.key === key)!;
    const i = header.findIndex((h, j) => !used.has(j) && f.match.test(h));
    if (i >= 0) { m[key] = i; used.add(i); }
  }
  return m;
}
/** True when the first row looks like titles rather than data. */
export const looksLikeHeader = (row: string[]) => !row.some((c) => validEmail(c) || bdMobile(c)) && row.some((c) => FIELDS.some((f) => f.match.test(c)));

export function rowsToContacts(rows: string[][], map: Record<keyof Contact, number>): Contact[] {
  return rows.map((r) => {
    const c = empty();
    for (const f of FIELDS) if (map[f.key] >= 0) c[f.key] = r[map[f.key]] ?? '';
    return c;
  });
}

/** Typed or pasted text: one contact per line, values split by comma/tab/semicolon; emails and numbers are found wherever they are, the rest is the name. */
export function parseTyped(text: string): Contact[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const c = empty();
    const rest: string[] = [];
    for (const part of line.split(/[,;\t]|\s{2,}/).map((x) => x.trim()).filter(Boolean)) {
      if (!c.email && validEmail(part)) c.email = part;
      else if (!c.phone && /^[+\d][\d\s()-]{5,}$/.test(part)) c.phone = part;
      else rest.push(part);
    }
    c.name = rest[0] ?? '';
    c.company = rest[1] ?? '';
    return c;
  });
}

export function downloadCsv(name: string, header: string[], rows: string[][]) {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const downloadTemplate = () => downloadCsv('contacts_template.csv', ['Name', 'Company', 'Phone', 'Email', 'Area', 'District', 'Note'],
  [['Rahim Uddin', 'Rahim Pharmacy', '01712345678', 'rahim@example.com', 'Mirpur', 'Dhaka', '']]);

// ------------------------------------------------------------------ API
const CHUNK = 2000;
export const contactsApi = {
  list: (listId: string, q = '') => req<{ total: number; rows: ListContact[] }>(`/lists/${listId}/contacts?q=${encodeURIComponent(q)}`),
  remove: (listId: string, ids: string[]) => send(`/lists/${listId}/contacts`, 'DELETE', { ids }),
  /** Sends in chunks so large files stay under the request size limit; results are added up. */
  async add(listId: string, contacts: Contact[], source: 'manual' | 'import', onProgress?: (done: number) => void): Promise<ImportResult> {
    const total: ImportResult = { added: 0, duplicates: 0, rejected: [], consents: 0 };
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const r = await send<ImportResult>(`/lists/${listId}/contacts`, 'POST', { contacts: contacts.slice(i, i + CHUNK), source });
      total.added += r.added; total.duplicates += r.duplicates; total.consents += r.consents;
      total.rejected.push(...r.rejected.map((x) => ({ ...x, row: x.row + i })));
      onProgress?.(Math.min(contacts.length, i + CHUNK));
    }
    return total;
  },
};
