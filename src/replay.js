import { addRun } from './store.js';

const GAP_MS = 5000;

// Scenarios are laid out one after another so the timeline reads in order.
export function replay(db, scenarios, rules, now = Date.now()) {
  let at = now;
  return scenarios.map((s) => {
    const res = addRun(db, s, rules, at);
    at += s.events.at(-1).offset_ms + GAP_MS;
    return { scenario: s.id, ...res };
  });
}
