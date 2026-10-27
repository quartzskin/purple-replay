import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from './sigma.js';
import { loadScenarios } from './scenarios.js';
import { latestEvents, openStore, resetStore } from './store.js';
import { replay } from './replay.js';
import { buildReport, reportToMarkdown } from './report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const HOST_OK = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

export function createApp({ db, scenariosDir = join(ROOT, 'scenarios'), rulesDir = join(ROOT, 'rules') } = {}) {
  const load = () => {
    const s = loadScenarios(scenariosDir);
    const r = loadRules(rulesDir);
    return { scenarios: s.scenarios, rules: r.rules, errors: { scenarios: s.errors, rules: r.errors } };
  };

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
  }

  async function handle(req, res) {
    if (!HOST_OK.test(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !HOST_OK.test(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'bad origin' });
    }

    if (path.startsWith('/api/')) {
      const cat = load();
      if (req.method === 'GET' && path === '/api/catalog') {
        return send(res, 200, {
          scenarios: cat.scenarios.map(({ events, ...s }) => ({ ...s, eventCount: events.length })),
          rules: cat.rules.map(({ match, ...r }) => r),
          errors: cat.errors,
        });
      }
      if (req.method === 'GET' && path === '/api/timeline') {
        const sc = url.searchParams.get('scenario');
        return send(res, 200, latestEvents(db).filter((e) => !sc || e.scenarioId === sc));
      }
      if (req.method === 'GET' && (path === '/api/report.json' || path === '/api/report.md')) {
        const report = buildReport(cat.scenarios, cat.rules, latestEvents(db));
        if (path.endsWith('.json')) {
          return send(res, 200, JSON.stringify(report, null, 2), undefined, {
            'content-disposition': 'attachment; filename="purple-replay-report.json"',
          });
        }
        return send(res, 200, reportToMarkdown(report), 'text/markdown; charset=utf-8', {
          'content-disposition': 'attachment; filename="purple-replay-report.md"',
        });
      }
      if (req.method === 'GET' && path === '/api/coverage') {
        const r = buildReport(cat.scenarios, cat.rules, latestEvents(db));
        return send(res, 200, { summary: r.summary, techniques: r.coverage });
      }
      if (req.method === 'POST' && path === '/api/replay') {
        const body = await readBody(req);
        const picked = body.scenario === undefined || body.scenario === 'all'
          ? cat.scenarios
          : cat.scenarios.filter((s) => s.id === body.scenario);
        if (!picked.length) return send(res, 404, { error: 'unknown scenario' });
        return send(res, 200, { runs: replay(db, picked, cat.rules) });
      }
      if (req.method === 'POST' && path === '/api/reset') {
        resetStore(db);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) return send(res, 403, { error: 'forbidden' });
    try {
      send(res, 200, await readFile(join(PUBLIC, rel)), TYPES[extname(rel)] ?? 'application/octet-stream');
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => send(res, e.status ?? 500, { error: e.message }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const port = Number(opt('--port', 8787));
  const db = openStore(opt('--db', join(ROOT, 'data', 'replay.db')));
  createApp({ db }).listen(port, '127.0.0.1', () => {
    console.log(`purple-replay on http://127.0.0.1:${port}`);
  });
}
