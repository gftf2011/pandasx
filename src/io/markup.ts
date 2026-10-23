/** A small, tolerant HTML / XML parser producing an element tree (no dependencies). */

export interface MNode {
  tag: string;
  attrs: Record<string, string>;
  children: (MNode | string)[];
  parent: MNode | null;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
/** Elements an opening tag implicitly closes (HTML only). */
const IMPLIED: Record<string, string[]> = {
  tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], thead: ['tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], tfoot: ['thead', 'tbody', 'tr', 'td', 'th'], li: ['li'], p: ['p'], option: ['option'],
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', deg: '°', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', middot: '·', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  times: '×', divide: '÷', plusmn: '±', laquo: '«', raquo: '»', bull: '•', trade: '™', minus: '−', aacute: 'á', eacute: 'é',
  iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', agrave: 'à', ecirc: 'ê', ocirc: 'ô', acirc: 'â',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function escapeXml(s: string, attr = false): string {
  const out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attr ? out.replace(/"/g, '&quot;') : out;
}

/** Parses markup into a root node whose children are the top-level elements. */
export function parseMarkup(src: string, mode: 'html' | 'xml'): MNode {
  const root: MNode = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const html = mode === 'html';
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { cur.children.push(decodeEntities(src.slice(i))); break; }
    if (lt > i) cur.children.push(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); cur.children.push(src.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const gt = findTagEnd(src, lt);
    if (gt < 0) { cur.children.push(src.slice(lt)); break; }
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = norm(body.slice(1).trim(), html);
      // Close up to the matching open element; ignore stray end tags.
      let k: MNode | null = cur;
      while (k && k.tag !== name) k = k.parent;
      if (k && k.parent) cur = k.parent;
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) continue;
    const tag = norm(m[1], html);
    const attrs: Record<string, string> = {};
    attrRe.lastIndex = m[1].length;
    for (let a = attrRe.exec(inner); a; a = attrRe.exec(inner)) attrs[html ? a[1].toLowerCase() : a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    if (html && IMPLIED[tag]) {
      // An open <tr> etc. closes previous siblings of the listed kinds, within the same table.
      let k: MNode | null = cur;
      while (k && k.tag !== '#root' && k.tag !== 'table' && !IMPLIED[tag].includes(k.tag)) k = k.parent;
      if (k && IMPLIED[tag].includes(k.tag)) cur = k.parent!;
    }
    const node: MNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (selfClosing || (html && VOID.has(tag))) continue;
    if (html && RAW.has(tag)) {
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      const end = close < 0 ? n : close;
      if (tag === 'title' || tag === 'textarea') node.children.push(decodeEntities(src.slice(i, end)));
      i = close < 0 ? n : src.indexOf('>', close) + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

function norm(name: string, html: boolean): string {
  return html ? name.toLowerCase() : name;
}

function findTagEnd(src: string, start: number): number {
  let q: string | null = null;
  for (let k = start + 1; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return k;
  }
  return -1;
}

/** All descendants (depth-first) matching `pred`. */
export function findAll(node: MNode, pred: (n: MNode) => boolean, out: MNode[] = []): MNode[] {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

/** Concatenated text of a node; block elements and <br> become spaces when `spacing`. */
export function textContent(node: MNode | string): string {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  return node.children.map(textContent).join('');
}

export const elementChildren = (n: MNode): MNode[] => n.children.filter((c): c is MNode => typeof c !== 'string');

/** Local name without a namespace prefix. */
export const localName = (tag: string): string => tag.slice(tag.indexOf(':') + 1);
