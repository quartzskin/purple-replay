import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, parseRule } from '../src/sigma.js';
import { loadScenarios, validateScenario, ScenarioError } from '../src/scenarios.js';
import { latestEvents, openStore } from '../src/store.js';
import { replay } from '../src/replay.js';
import { buildCoverage } from '../src/coverage.js';
import { buildReport, reportToMarkdown } from '../src/report.js';
import { createApp } from '../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('shipped scenarios and rules all load', () => {
  const s = loadScenarios(join(root, 'scenarios'));
  const r = loadRules(join(root, 'rules'));
  assert.deepEqual(s.errors, []);
  assert.deepEqual(r.errors, []);
  assert.equal(s.scenarios.length, 10);
  assert.equal(r.rules.length, 12);
});

test('scenario validation rejects malformed input', () => {
  const ev = { offset_ms: 0, category: 'process_creation', technique: 'T1059', fields: {} };
  assert.throws(() => validateScenario(null), ScenarioError);
  assert.throws(() => validateScenario({ id: 'a', name: 'b', events: [] }), ScenarioError);
  assert.throws(() => validateScenario({ id: 'a', name: 'b', events: [{ ...ev, technique: 'x' }] }), ScenarioError);
  assert.throws(() => validateScenario({ id: 'a', name: 'b', events: [{ ...ev, fields: [] }] }), ScenarioError);
  assert.throws(() => validateScenario({ id: 'a', name: 'b', events: [ev, { ...ev, offset_ms: -5 }] }), ScenarioError);
  assert.ok(validateScenario({ id: 'a', name: 'b', events: [ev] }));
});

test('bad files are reported and skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  try {
    writeFileSync(join(dir, 'ok.yml'), 'title: t\nid: a\ndetection:\n  s:\n    A: 1\n  condition: s\n');
    writeFileSync(join(dir, 'dup.yml'), 'title: t\nid: a\ndetection:\n  s:\n    A: 1\n  condition: s\n');
    writeFileSync(join(dir, 'bad.yml'), 'title: t\n');
    writeFileSync(join(dir, 'x.json'), '{ nope');
    const r = loadRules(dir);
    assert.equal(r.rules.length, 1);
    assert.deepEqual(r.errors.map((e) => e.file).sort(), ['bad.yml', 'ok.yml']);
    assert.equal(loadScenarios(dir).errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const setup = () => {
  const { scenarios } = loadScenarios(join(root, 'scenarios'));
  const { rules } = loadRules(join(root, 'rules'));
  const db = openStore();
  return { scenarios, rules, db };
};

test('replay stores events and detections; benign events stay quiet', () => {
  const { scenarios, rules, db } = setup();
  replay(db, scenarios, rules);
  const events = latestEvents(db);
  assert.equal(events.length, scenarios.reduce((n, s) => n + s.events.length, 0));
  const lsass = events.filter((e) => e.scenarioId === 'lsass-access');
  assert.deepEqual(lsass.map((e) => e.detections.length), [1, 0]);
  const task = events.filter((e) => e.scenarioId === 'scheduled-task');
  assert.deepEqual(task.map((e) => e.detections.length), [1, 0]);
});

test('replaying twice keeps only the latest run per scenario', () => {
  const { scenarios, rules, db } = setup();
  replay(db, scenarios, rules);
  replay(db, scenarios, rules);
  assert.equal(latestEvents(db).length, scenarios.reduce((n, s) => n + s.events.length, 0));
});

test('coverage statuses', () => {
  const { scenarios, rules, db } = setup();
  const before = buildCoverage(scenarios, rules, []);
  assert.equal(before.summary.detected, 0);
  assert.ok(before.techniques.some((t) => t.status === 'not_run'));
  replay(db, scenarios, rules);
  const cov = buildCoverage(scenarios, rules, latestEvents(db));
  const by = Object.fromEntries(cov.techniques.map((t) => [t.technique, t.status]));
  assert.equal(by['T1490'], 'detected');
  assert.equal(by['T1082'], 'gap');
  assert.equal(by['T1136.001'], 'rule_only');
});

test('a rule firing on the wrong technique does not count as coverage', () => {
  const rule = parseRule('title: t\nid: r\ntags:\n  - attack.t1000\ndetection:\n  s:\n    A: 1\n  condition: s\n');
  const sc = validateScenario({
    id: 's', name: 's',
    events: [{ offset_ms: 0, category: 'c', technique: 'T2000', fields: { A: 1 } }],
  });
  const db = openStore();
  replay(db, [sc], [rule]);
  const cov = buildCoverage([sc], [rule], latestEvents(db));
  assert.equal(cov.techniques.find((t) => t.technique === 'T2000').status, 'gap');
});

test('report json and markdown', () => {
  const { scenarios, rules, db } = setup();
  replay(db, scenarios, rules);
  const rep = buildReport(scenarios, rules, latestEvents(db));
  assert.equal(rep.summary.scenarios, 10);
  assert.ok(rep.detections.length > 0);
  const md = reportToMarkdown(rep);
  assert.match(md, /^# Purple-team replay report/);
  assert.match(md, /\| T1490 \| detected/);
  assert.match(md, /## Gaps/);
  JSON.parse(JSON.stringify(rep));
});

let server;
let base;
before(async () => {
  const { db } = setup();
  server = createApp({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('http api: replay, coverage, report, errors', async () => {
  let res = await fetch(`${base}/api/replay`, { method: 'POST', body: JSON.stringify({ scenario: 'all' }) });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/api/coverage`);
  assert.ok((await res.json()).summary.detected > 0);
  res = await fetch(`${base}/api/report.md`);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(await res.text(), /# Purple-team replay report/);
  res = await fetch(`${base}/api/replay`, { method: 'POST', body: JSON.stringify({ scenario: 'nope' }) });
  assert.equal(res.status, 404);
  res = await fetch(`${base}/api/replay`, { method: 'POST', body: '{bad' });
  assert.equal(res.status, 400);
  res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  res = await fetch(`${base}/..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});

test('http api rejects foreign host and origin', async () => {
  const { request } = await import('node:http');
  const status = (headers, method = 'GET', path = '/api/catalog') =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await status({ host: 'evil.example' }), 403);
  assert.equal(await status({ origin: 'http://evil.example' }, 'POST', '/api/reset'), 403);
});
