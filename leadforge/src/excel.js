'use strict';
/* Genuine .xlsx writer with zero dependencies.
   Builds a ZIP package (stored + deflated entries) containing workbook XML.
   Includes: header styling, frozen pane, autofilter, column widths, types, error sheet, summary sheet,
   UTF-8 support, and formula-injection sanitization. */
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c; }
    crc32._t = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function escXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function sanitizeCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Prevent formula injection: prefix values starting with = + - @ (and tab/CR) with apostrophe
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // Strip control chars except tab/newline
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return s;
}

function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function cellXml(value, styleIdx) {
  const sAttr = styleIdx ? ` s="${styleIdx}"` : '';
  if (value == null || value === '') return `<c${sAttr}/>`;
  if (isNumber(value)) return `<c${sAttr} t="n"><v>${value}</v></c>`;
  return `<c${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(sanitizeCell(value))}</t></is></c>`;
}

function sheetXml(name, columns, rows, { freeze = true, filter = true } = {}) {
  const ref = `A1:${colLetter(Math.max(columns.length - 1, 0))}${Math.max(rows.length + 1, 1)}`;
  const cols = columns.map((c, i) => {
    const w = Math.min(60, Math.max(12, Math.ceil(Math.max(String(c.header).length, ...rows.slice(0, 200).map(r => String(r[i] ?? '').length)) * 1.15)));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');
  const header = `<row r="1" ht="22">${columns.map((c, i) => `<c r="${colLetter(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${escXml(c.header)}</t></is></c>`).join('')}</row>`;
  const body = rows.map((r, ri) => `<row r="${ri + 2}">${r.map((v, ci) => cellXml(v, 0).replace('<c', `<c r="${colLetter(ci)}${ri + 2}"`)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0">${freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews><cols>${cols}</cols><sheetData>${header}${body}</sheetData>${filter ? `<autoFilter ref="${ref}"/>` : ''}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F6F4A"/><bgColor indexed="64"/></patternFill></fill></fills><borders><border><left/><right/><top/><bottom/><diagonal/></border></border><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs></styleSheet>`;

function zipFile(entries) {
  // entries: [{name, data: Buffer, compress: bool}]
  const enc = (s) => Buffer.from(s, 'utf8');
  const chunks = []; const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = enc(e.name);
    const raw = Buffer.isBuffer(e.data) ? e.data : enc(String(e.data));
    const comp = e.compress === false ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const method = e.compress === false ? 0 : 8;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  chunks.push(cd);
  offset += cd.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16); end.writeUInt16LE(0, 20);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function unionColumns(records, renames = {}) {
  const keys = [];
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r || {})) {
    if (k === 'id' || k === 'jobId') continue;
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  // stable order: preferred first
  const preferred = ['businessName', 'name', 'title', 'category', 'phone', 'email', 'website', 'address', 'fullAddress', 'city', 'region', 'country', 'rating', 'reviewCount', 'url', 'status'];
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a), ib = preferred.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  return keys.map(k => ({ key: k, header: renames[k] || prettyHeader(k) }));
}

function prettyHeader(k) {
  return String(k).replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
}

function buildWorkbook({ records, columns, summary, errors }) {
  const cols = columns && columns.length ? columns : unionColumns(records);
  if (!cols.length) cols.push({ key: 'message', header: 'Message' });
  const rows = (records || []).map(r => cols.map(c => {
    let v = r[c.key];
    if (Array.isArray(v)) v = v.join(', ');
    if (v && typeof v === 'object') v = JSON.stringify(v);
    return v ?? '';
  }));
  const mainName = 'Data';
  const files = [
    { name: '[Content_Types].xml', compress: true, data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${cols ? `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` : ''}<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${errors && errors.length ? `<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` : ''}</Types>` },
    { name: '_rels/.rels', compress: true, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', compress: true, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(mainName)}" sheetId="1" r:id="rId1"/><sheet name="Job Summary" sheetId="2" r:id="rId2"/>${errors && errors.length ? `<sheet name="Errors" sheetId="3" r:id="rId3"/>` : ''}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', compress: true, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>${errors && errors.length ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>` : ''}<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', compress: true, data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', compress: true, data: sheetXml(mainName, cols, rows.length ? rows : [['No records collected']]) },
    { name: 'xl/worksheets/sheet2.xml', compress: true, data: sheetXml('Job Summary', [{ header: 'Field' }, { header: 'Value' }], Object.entries(summary || {}).map(([k, v]) => [prettyHeader(k), String(v ?? '')])) },
  ];
  if (errors && errors.length) {
    files.push({ name: 'xl/worksheets/sheet3.xml', compress: true, data: sheetXml('Errors', [{ header: 'URL' }, { header: 'Error' }], errors.map(e => [e.url || '', e.error || ''])) });
  }
  return { buffer: zipFile(files), columns: cols };
}

module.exports = { buildWorkbook, unionColumns, sanitizeCell, escXml, prettyHeader };
