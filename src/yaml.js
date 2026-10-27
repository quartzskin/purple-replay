// Parser for the YAML subset Sigma rules use: block maps/lists, inline lists, quoted scalars.
export class YamlError extends Error {}

const KEY = /^('[^']*'|"[^"]*"|[^\s:'"#][^:]*?)\s*:(?:\s+(.*))?$/;

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && q === "'" && s[i + 1] === "'") i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      if (i === 0 || /[\s\[,:-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function unquoteKey(k) {
  return /^(['"]).*\1$/.test(k) ? k.slice(1, -1) : k;
}

function scalar(s, lineNo) {
  s = s.trim();
  if (s === '') return null;
  if (s[0] === "'") {
    if (s.length < 2 || s.at(-1) !== "'") throw new YamlError(`line ${lineNo}: unterminated quote`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`line ${lineNo}: bad double-quoted string`);
    }
  }
  if (s[0] === '[') {
    if (s.at(-1) !== ']') throw new YamlError(`line ${lineNo}: unterminated inline list`);
    return splitInline(s.slice(1, -1), lineNo).map((p) => scalar(p, lineNo));
  }
  if (s[0] === '{') throw new YamlError(`line ${lineNo}: inline maps are not supported`);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitInline(s, lineNo) {
  const out = [];
  let cur = '';
  let q = null;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (q) throw new YamlError(`line ${lineNo}: unterminated quote`);
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out;
}

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\t/.test(raw)) throw new YamlError(`line ${i + 1}: tabs are not allowed for indentation`);
    const body = stripComment(raw).replace(/\s+$/, '');
    if (body.trim() === '' || body.trim() === '---') return;
    lines.push({ indent: body.length - body.trimStart().length, text: body.trim(), no: i + 1 });
  });
  let pos = 0;

  function block(indent) {
    const ln = lines[pos];
    if (ln.text === '-' || ln.text.startsWith('- ')) return list(indent);
    return map(indent);
  }

  function list(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
      const ln = lines[pos];
      const rest = ln.text.slice(1).trim();
      if (rest === '') {
        pos++;
        out.push(pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null);
      } else if (KEY.test(rest) && !/^['"].*['"]$/.test(rest)) {
        const inner = indent + (ln.text.length - ln.text.slice(1).trimStart().length);
        lines[pos] = { indent: inner, text: rest, no: ln.no };
        out.push(map(inner));
      } else {
        pos++;
        out.push(scalar(rest, ln.no));
      }
    }
    return out;
  }

  function map(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const ln = lines[pos];
      const m = KEY.exec(ln.text);
      if (!m) throw new YamlError(`line ${ln.no}: expected "key: value"`);
      const key = unquoteKey(m[1]);
      if (key in out) throw new YamlError(`line ${ln.no}: duplicate key "${key}"`);
      pos++;
      if (m[2] !== undefined && m[2] !== '') {
        out[key] = scalar(m[2], ln.no);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        out[key] = block(lines[pos].indent);
      } else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
        out[key] = list(indent);
      } else {
        out[key] = null;
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError(`line ${lines[pos].no}: unexpected indentation`);
    }
    return out;
  }

  if (!lines.length) return null;
  const result = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].no}: unexpected content`);
  return result;
}
