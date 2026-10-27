import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      scenario_name TEXT NOT NULL,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      category TEXT NOT NULL,
      technique TEXT NOT NULL,
      fields TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS detections (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      rule_id TEXT NOT NULL,
      rule_title TEXT NOT NULL,
      level TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
    CREATE INDEX IF NOT EXISTS detections_event ON detections(event_id);
  `);
  return db;
}

export function resetStore(db) {
  db.exec('DELETE FROM detections; DELETE FROM events; DELETE FROM runs;');
}

export function addRun(db, scenario, rules, startedAt = Date.now()) {
  const insRun = db.prepare('INSERT INTO runs (scenario_id, scenario_name, started_at) VALUES (?, ?, ?)');
  const insEv = db.prepare(
    'INSERT INTO events (run_id, seq, ts, category, technique, fields) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insDet = db.prepare('INSERT INTO detections (event_id, rule_id, rule_title, level) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    const runId = Number(insRun.run(scenario.id, scenario.name, startedAt).lastInsertRowid);
    let fired = 0;
    scenario.events.forEach((e, seq) => {
      const evId = Number(
        insEv.run(runId, seq, startedAt + e.offset_ms, e.category, e.technique, JSON.stringify(e.fields)).lastInsertRowid,
      );
      for (const r of rules) {
        if (r.match(e)) {
          insDet.run(evId, r.id, r.title, r.level);
          fired++;
        }
      }
    });
    db.exec('COMMIT');
    return { runId, events: scenario.events.length, detections: fired };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Newest run per scenario, one row per event with its detections attached.
export function latestEvents(db) {
  const rows = db
    .prepare(
      `SELECT e.id, e.run_id, e.seq, e.ts, e.category, e.technique, e.fields, r.scenario_id, r.scenario_name
       FROM events e JOIN runs r ON r.id = e.run_id
       WHERE r.id = (SELECT MAX(id) FROM runs WHERE scenario_id = r.scenario_id)
       ORDER BY e.ts, e.run_id, e.seq`,
    )
    .all();
  const dets = db.prepare('SELECT rule_id, rule_title, level FROM detections WHERE event_id = ? ORDER BY id');
  return rows.map((r) => ({
    runId: r.run_id,
    seq: r.seq,
    ts: r.ts,
    category: r.category,
    technique: r.technique,
    scenarioId: r.scenario_id,
    scenarioName: r.scenario_name,
    fields: JSON.parse(r.fields),
    detections: dets.all(r.id).map((d) => ({ ruleId: d.rule_id, title: d.rule_title, level: d.level })),
  }));
}
