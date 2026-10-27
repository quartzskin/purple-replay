import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ScenarioError extends Error {}

const TECH = /^T\d{4}(\.\d{3})?$/;

export function validateScenario(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new ScenarioError('scenario must be an object');
  for (const k of ['id', 'name']) {
    if (typeof s[k] !== 'string' || !s[k].trim()) throw new ScenarioError(`missing or invalid "${k}"`);
  }
  if (!Array.isArray(s.events) || !s.events.length) throw new ScenarioError('"events" must be a non-empty list');
  let last = 0;
  s.events.forEach((e, i) => {
    const at = `event ${i}`;
    if (!Number.isFinite(e.offset_ms) || e.offset_ms < last) {
      throw new ScenarioError(`${at}: offset_ms must be a number and not go backwards`);
    }
    last = e.offset_ms;
    if (typeof e.technique !== 'string' || !TECH.test(e.technique)) throw new ScenarioError(`${at}: bad technique id`);
    if (typeof e.category !== 'string' || !e.category) throw new ScenarioError(`${at}: missing category`);
    if (e.fields === null || typeof e.fields !== 'object' || Array.isArray(e.fields)) {
      throw new ScenarioError(`${at}: "fields" must be an object`);
    }
  });
  return { ...s, description: s.description ?? '', techniques: [...new Set(s.events.map((e) => e.technique))] };
}

export function loadScenarios(dir) {
  const scenarios = [];
  const errors = [];
  const seen = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const s = validateScenario(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (seen.has(s.id)) throw new ScenarioError(`duplicate scenario id "${s.id}"`);
      seen.add(s.id);
      scenarios.push(s);
    } catch (e) {
      errors.push({ file: f, error: e.message });
    }
  }
  return { scenarios, errors };
}
