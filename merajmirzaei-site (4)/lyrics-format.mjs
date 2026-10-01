// Shared by the admin preview and Worker. Plain text only; layout is a
// small allowlist of values rather than user-supplied HTML or CSS.
export const DEFAULT_LAYOUT = Object.freeze({
  font: 'site', fontSize: 18.5, lineHeight: 2.1, stanzaGap: 26,
  textAlign: 'start', maxWidth: 1000, position: 'center',
});
export const FONTS = Object.freeze({
  site: 'var(--lyr-default-font)', system: 'Tahoma, Arial, sans-serif',
  classic: 'Georgia, Times New Roman, serif', mono: 'monospace',
});
const CHOICES = { font: Object.keys(FONTS), textAlign: ['start', 'right', 'center', 'left'], position: ['right', 'center', 'left'] };
const RANGES = { fontSize: [14, 36], lineHeight: [1.3, 3.2], stanzaGap: [0, 64], maxWidth: [280, 1000] };

export function validateDetails(row) {
  if (row.poet != null && (typeof row.poet !== 'string' || row.poet.length > 200)) return 'poet must be a string of at most 200 characters';
  if (row.layout == null) return null;
  if (typeof row.layout !== 'object' || Array.isArray(row.layout)) return 'layout must be an object';
  for (const [key, value] of Object.entries(row.layout)) {
    if (Object.hasOwn(CHOICES, key)) { if (!CHOICES[key].includes(value)) return 'invalid layout ' + key; }
    else if (Object.hasOwn(RANGES, key)) {
      const [min, max] = RANGES[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return 'invalid layout ' + key;
    } else return 'unknown layout field ' + key;
  }
  return null;
}

export function normalizeLayout(input) {
  const layout = { ...DEFAULT_LAYOUT };
  if (input && typeof input === 'object') for (const key of Object.keys(layout)) {
    const value = input[key];
    if (CHOICES[key]?.includes(value)) layout[key] = value;
    else if (RANGES[key] && typeof value === 'number' && Number.isFinite(value)) {
      const [min, max] = RANGES[key];
      layout[key] = Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
    }
  }
  return layout;
}

export function cleanText(value) {
  return String(value ?? '')
    // Some word processors put a Unicode separator next to an existing
    // newline. That is one line break, not an extra empty stanza.
    .replace(/[\u2028\u2029]*(?:\r\n?|\n)[\u2028\u2029]*/g, '\n')
    .replace(/\u2028/g, '\n').replace(/\u2029/g, '\n\n')
    .replace(/[\uFEFF\u200B]/g, '').replace(/ك/g, 'ک').replace(/ي/g, 'ی')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function stanzas(text) {
  return cleanText(text).split(/\n{2,}/).map(block => block.split('\n').filter(Boolean)).filter(lines => lines.length);
}
export function escapeText(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function renderHtml(text) {
  return stanzas(text).map(lines => '<p dir="auto">' + lines.map(escapeText).join('<br>') + '</p>').join('');
}
export function textLang(text) {
  const arabic = (String(text).match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? 'fa' : 'en';
}
export function layoutStyle(input) {
  const l = normalizeLayout(input);
  return '--lyr-font:' + FONTS[l.font] + ';--lyr-size:' + l.fontSize + 'px;--lyr-line:' + l.lineHeight
    + ';--lyr-gap:' + l.stanzaGap + 'px;--lyr-align:' + l.textAlign + ';--lyr-width:' + l.maxWidth + 'px'
    + ';--lyr-left:' + (l.position === 'left' ? '0' : 'auto') + ';--lyr-right:' + (l.position === 'right' ? '0' : 'auto');
}
export const TEXT_CSS = '.lyr-text{--lyr-default-font:var(--body,system-ui);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:24px 26px;width:100%;max-width:var(--lyr-width,1000px);margin-left:var(--lyr-left,auto);margin-right:var(--lyr-right,auto);box-sizing:border-box;overflow-wrap:anywhere}'
  + '.lyr-text[lang="fa"]{--lyr-default-font:var(--fa,Vazirmatn,system-ui);direction:rtl}'
  + '.lyr-text p{font-family:var(--lyr-font,var(--lyr-default-font));font-size:var(--lyr-size,18.5px);line-height:var(--lyr-line,2.1);text-align:var(--lyr-align,start);color:var(--text);margin:0 0 var(--lyr-gap,26px);max-width:none}'
  + '.lyr-text p:last-child{margin-bottom:0}'
  + '@media(max-width:520px){.lyr-text{padding:18px 16px}}';

// Explicit, reversible tools. Word wrapping is a user-chosen word count,
// not a guess at poetic meter; existing line/stanza boundaries are kept.
export function formatText(text, action, wordCount = 8) {
  let value = String(text ?? '');
  if (action === 'split') value = value.replace(/[ \t\u00A0]{2,}/g, '\n').replace(/[\/|؛]+/g, '\n');
  value = cleanText(value);
  if (action === 'clean') return value.split('\n').map(line => line.replace(/[ \t\u00A0]+/g, ' ')).join('\n');
  if (action === 'couplets') {
    const lines = value.split('\n').filter(Boolean), blocks = [];
    for (let i = 0; i < lines.length; i += 2) blocks.push(lines.slice(i, i + 2).join('\n'));
    return blocks.join('\n\n');
  }
  if (action === 'compact') return value.replace(/\n{2,}/g, '\n');
  if (action === 'wrap') {
    const count = Math.min(24, Math.max(3, Math.round(Number(wordCount) || 8)));
    return value.split('\n').map(line => {
      if (!line) return '';
      const words = line.split(/\s+/), lines = [];
      for (let i = 0; i < words.length; i += count) lines.push(words.slice(i, i + count).join(' '));
      return lines.join('\n');
    }).join('\n');
  }
  return value;
}
