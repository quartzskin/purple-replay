import { buildCoverage } from './coverage.js';

const LABEL = { detected: 'detected', gap: 'GAP', not_run: 'not run', rule_only: 'rule only' };

export function buildReport(scenarios, rules, events, now = Date.now()) {
  const coverage = buildCoverage(scenarios, rules, events);
  const fired = events.flatMap((e) =>
    e.detections.map((d) => ({
      ts: e.ts,
      scenario: e.scenarioId,
      technique: e.technique,
      ruleId: d.ruleId,
      rule: d.title,
      level: d.level,
    })),
  );
  return {
    generatedAt: new Date(now).toISOString(),
    scope: 'Simulated events replayed as data. Nothing was executed and no network traffic was generated.',
    summary: { ...coverage.summary, scenarios: scenarios.length, rules: rules.length, events: events.length, detections: fired.length },
    coverage: coverage.techniques,
    detections: fired,
    timeline: events.map((e) => ({
      ts: e.ts,
      scenario: e.scenarioId,
      technique: e.technique,
      category: e.category,
      fields: e.fields,
      detections: e.detections.map((d) => d.ruleId),
    })),
  };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function reportToMarkdown(r) {
  const s = r.summary;
  const out = [];
  out.push('# Purple-team replay report', '', `Generated ${r.generatedAt}`, '', `Scope: ${r.scope}`, '');
  out.push(
    `${s.scenarios} scenarios, ${s.rules} rules, ${s.events} events replayed, ${s.detections} detections fired.`,
    `Techniques: ${s.techniques} total, ${s.detected} detected, ${s.gap} gaps, ${s.notRun} not run, ${s.ruleOnly} rule-only.` +
      (s.detectionRate === null ? '' : ` Detection rate over techniques with telemetry: ${s.detectionRate}%.`),
    '',
  );
  out.push('## Coverage', '', '| Technique | Status | Events | Scenarios | Detected by |', '| --- | --- | --- | --- | --- |');
  for (const c of r.coverage) {
    const sc = (c.scenariosRun.length ? c.scenariosRun : c.scenarios).join(', ') || '-';
    out.push(`| ${c.technique} | ${LABEL[c.status]} | ${c.telemetry} | ${cell(sc)} | ${cell(c.detectedBy.map((d) => d.id).join(', ') || '-')} |`);
  }
  const gaps = r.coverage.filter((c) => c.status === 'gap');
  out.push('', '## Gaps', '');
  if (gaps.length) for (const g of gaps) out.push(`- ${g.technique}: ${g.telemetry} event(s) from ${g.scenariosRun.join(', ')}, no rule fired`);
  else out.push('None.');
  const untested = r.coverage.filter((c) => c.status === 'rule_only');
  if (untested.length) {
    out.push('', '## Rules without a scenario', '');
    for (const u of untested) out.push(`- ${u.technique}: ${u.rules.map((x) => x.id).join(', ')}`);
  }
  out.push('', '## Detections', '');
  if (r.detections.length) {
    out.push('| Time | Scenario | Technique | Rule | Level |', '| --- | --- | --- | --- | --- |');
    for (const d of r.detections) out.push(`| ${new Date(d.ts).toISOString()} | ${d.scenario} | ${d.technique} | ${cell(d.rule)} | ${d.level} |`);
  } else out.push('None.');
  out.push('');
  return out.join('\n');
}
