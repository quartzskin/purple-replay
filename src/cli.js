import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from './sigma.js';
import { loadScenarios } from './scenarios.js';
import { latestEvents, openStore } from './store.js';
import { replay } from './replay.js';
import { buildReport, reportToMarkdown } from './report.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');

const { scenarios, errors: sErr } = loadScenarios(join(root, 'scenarios'));
const { rules, errors: rErr } = loadRules(join(root, 'rules'));
for (const e of [...sErr, ...rErr]) console.error(`skipped ${e.file}: ${e.error}`);

const db = openStore();
replay(db, scenarios, rules);
const report = buildReport(scenarios, rules, latestEvents(db));
console.log(json ? JSON.stringify(report, null, 2) : reportToMarkdown(report));
if (sErr.length || rErr.length) process.exitCode = 1;
