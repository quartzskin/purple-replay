import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.js';

export class RuleError extends Error {}

const LEVELS = new Set(['informational', 'low', 'medium', 'high', 'critical']);
const OPS = new Set(['contains', 'startswith', 'endswith', 're']);
const TECH_TAG = /^attack\.(t\d{4}(?:\.\d{3})?)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wildcard(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '*' || s[i + 1] === '?')) out += escapeRe(s[++i]);
    else if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`, 'is');
}

function valueTest(op, raw, where) {
  if (raw === null) return (v) => v === undefined || v === null || v === '';
  if (typeof raw === 'object') throw new RuleError(`${where}: nested values are not allowed`);
  const want = String(raw);
  const lower = want.toLowerCase();
  const str = (v) => (v === undefined || v === null ? null : String(v));
  switch (op) {
    case 'contains':
      return (v) => str(v) !== null && str(v).toLowerCase().includes(lower);
    case 'startswith':
      return (v) => str(v) !== null && str(v).toLowerCase().startsWith(lower);
    case 'endswith':
      return (v) => str(v) !== null && str(v).toLowerCase().endsWith(lower);
    case 're': {
      let re;
      try {
        re = new RegExp(want);
      } catch (e) {
        throw new RuleError(`${where}: invalid regex ${JSON.stringify(want)}`);
      }
      return (v) => str(v) !== null && re.test(str(v));
    }
    default:
      if (/[*?]/.test(want)) {
        const re = wildcard(want);
        return (v) => str(v) !== null && re.test(str(v));
      }
      return (v) => str(v) !== null && str(v).toLowerCase() === lower;
  }
}

function compileField(spec, value, sel) {
  const [field, ...mods] = spec.split('|');
  if (!field) throw new RuleError(`selection "${sel}": empty field name`);
  let op = null;
  let all = false;
  for (const m of mods) {
    if (m === 'all') all = true;
    else if (OPS.has(m)) {
      if (op) throw new RuleError(`selection "${sel}": field "${spec}" has more than one match modifier`);
      op = m;
    } else throw new RuleError(`selection "${sel}": unsupported modifier "${m}"`);
  }
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new RuleError(`selection "${sel}": field "${spec}" has no values`);
  const tests = values.map((v) => valueTest(op, v, `selection "${sel}" field "${spec}"`));
  return (ev) => {
    const got = ev[field];
    return all ? tests.every((t) => t(got)) : tests.some((t) => t(got));
  };
}

function compileSelection(name, def) {
  const groups = Array.isArray(def) ? def : [def];
  if (!groups.length) throw new RuleError(`selection "${name}" is empty`);
  const compiled = groups.map((g) => {
    if (g === null || typeof g !== 'object' || Array.isArray(g)) {
      throw new RuleError(`selection "${name}" must be a map of fields (keyword lists are not supported)`);
    }
    const entries = Object.entries(g);
    if (!entries.length) throw new RuleError(`selection "${name}" is empty`);
    const tests = entries.map(([k, v]) => compileField(k, v, name));
    return (ev) => tests.every((t) => t(ev));
  });
  return (ev) => compiled.some((t) => t(ev));
}

function tokenize(cond) {
  const toks = cond.match(/\(|\)|[^\s()]+/g) || [];
  return toks;
}

function compileCondition(cond, names) {
  if (typeof cond !== 'string' || !cond.trim()) throw new RuleError('condition must be a non-empty string');
  const toks = tokenize(cond);
  let i = 0;

  const pick = (pat) => {
    if (pat === 'them') return names;
    const re = new RegExp(`^${pat.split('*').map(escapeRe).join('.*')}$`);
    const hit = names.filter((n) => re.test(n));
    if (!hit.length) throw new RuleError(`condition: "${pat}" matches no selection`);
    return hit;
  };

  function primary() {
    const t = toks[i++];
    if (t === undefined) throw new RuleError('condition ends unexpectedly');
    if (t === '(') {
      const e = or();
      if (toks[i++] !== ')') throw new RuleError('condition: missing closing parenthesis');
      return e;
    }
    if (t === 'not') {
      const e = primary();
      return (r) => !e(r);
    }
    if ((t === '1' || t === 'all') && toks[i] === 'of') {
      i++;
      const pat = toks[i++];
      if (!pat) throw new RuleError('condition: "of" needs a selection name');
      const hit = pick(pat);
      return t === '1' ? (r) => hit.some((n) => r[n]) : (r) => hit.every((n) => r[n]);
    }
    if (t === ')' || t === 'and' || t === 'or') throw new RuleError(`condition: unexpected "${t}"`);
    if (!names.includes(t)) throw new RuleError(`condition references unknown selection "${t}"`);
    return (r) => r[t];
  }
  function and() {
    let l = primary();
    while (toks[i] === 'and') {
      i++;
      const a = l;
      const b = primary();
      l = (r) => a(r) && b(r);
    }
    return l;
  }
  function or() {
    let l = and();
    while (toks[i] === 'or') {
      i++;
      const a = l;
      const b = and();
      l = (r) => a(r) || b(r);
    }
    return l;
  }

  const fn = or();
  if (i < toks.length) throw new RuleError(`condition: unexpected "${toks[i]}"`);
  return fn;
}

export function compileRule(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new RuleError('rule must be a map');
  for (const k of ['id', 'title']) {
    if (typeof obj[k] !== 'string' || !obj[k].trim()) throw new RuleError(`missing or invalid "${k}"`);
  }
  const level = obj.level ?? 'medium';
  if (!LEVELS.has(level)) throw new RuleError(`invalid level "${level}"`);
  const tags = obj.tags ?? [];
  if (!Array.isArray(tags)) throw new RuleError('"tags" must be a list');
  const det = obj.detection;
  if (det === null || typeof det !== 'object' || Array.isArray(det)) throw new RuleError('missing "detection" map');
  const { condition, ...sels } = det;
  const names = Object.keys(sels);
  if (!names.length) throw new RuleError('detection has no selections');
  const compiled = Object.fromEntries(names.map((n) => [n, compileSelection(n, sels[n])]));
  const test = compileCondition(condition, names);
  const category = obj.logsource?.category ?? null;
  const techniques = tags.map((t) => TECH_TAG.exec(String(t))?.[1].toUpperCase()).filter(Boolean);

  return {
    id: obj.id,
    title: obj.title,
    level,
    description: obj.description ?? '',
    category,
    tags: tags.map(String),
    techniques,
    match(event) {
      if (category && event.category && event.category !== category) return false;
      const fields = event.fields ?? event;
      const res = {};
      for (const n of names) res[n] = compiled[n](fields);
      return Boolean(test(res));
    },
  };
}

export function parseRule(text) {
  return compileRule(parseYaml(text));
}

export function loadRules(dir) {
  const rules = [];
  const errors = [];
  const seen = new Set();
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    try {
      const rule = parseRule(readFileSync(join(dir, f), 'utf8'));
      if (seen.has(rule.id)) throw new RuleError(`duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      rules.push(rule);
    } catch (e) {
      errors.push({ file: f, error: e.message });
    }
  }
  return { rules, errors };
}
