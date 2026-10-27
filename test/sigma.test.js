import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, RuleError } from '../src/sigma.js';
import { parseYaml, YamlError } from '../src/yaml.js';

const rule = (detection, extra = '') => `title: t
id: x1
${extra}detection:
${detection}`;

const ev = (fields) => ({ category: 'process_creation', fields });

test('contains, startswith, endswith are case-insensitive', () => {
  const r = parseRule(rule(`  s:
    A|contains: Foo
    B|startswith: bar
    C|endswith: BAZ
  condition: s
`));
  assert.ok(r.match(ev({ A: 'xxfOOxx', B: 'BARn', C: 'a.baz' })));
  assert.ok(!r.match(ev({ A: 'xxfOOxx', B: 'nbar', C: 'a.baz' })));
});

test('value lists are OR, |all makes them AND', () => {
  const any = parseRule(rule(`  s:
    A|contains: [one, two]
  condition: s
`));
  const all = parseRule(rule(`  s:
    A|contains|all: [one, two]
  condition: s
`));
  assert.ok(any.match(ev({ A: 'one' })));
  assert.ok(!all.match(ev({ A: 'one' })));
  assert.ok(all.match(ev({ A: 'two one' })));
});

test('re modifier', () => {
  const r = parseRule(rule(`  s:
    A|re: '^a\\d+z$'
  condition: s
`));
  assert.ok(r.match(ev({ A: 'a123z' })));
  assert.ok(!r.match(ev({ A: 'a12' })));
});

test('plain values support wildcards and exact match', () => {
  const r = parseRule(rule(`  s:
    A: 'C:\\Win*\\cmd.exe'
  condition: s
`));
  assert.ok(r.match(ev({ A: 'c:\\windows\\system32\\cmd.exe' })));
  assert.ok(!r.match(ev({ A: 'c:\\windows\\system32\\cmd.exe2' })));
});

test('conditions: and / or / not / parentheses', () => {
  const src = (cond) => rule(`  a:
    X: 1
  b:
    Y: 1
  c:
    Z: 1
  condition: ${cond}
`);
  const m = (cond, f) => parseRule(src(cond)).match(ev(f));
  assert.ok(m('a and b', { X: 1, Y: 1 }));
  assert.ok(!m('a and b', { X: 1 }));
  assert.ok(m('a or b', { Y: 1 }));
  assert.ok(m('a and not b', { X: 1 }));
  assert.ok(!m('a and not b', { X: 1, Y: 1 }));
  assert.ok(m('a and (b or c)', { X: 1, Z: 1 }));
  assert.ok(!m('(a and b) or c', { X: 1 }));
});

test('1 of / all of with wildcards and them', () => {
  const body = `  sel_a:
    X: 1
  sel_b:
    Y: 1
`;
  const m = (cond, f) => parseRule(rule(`${body}  condition: ${cond}\n`)).match(ev(f));
  assert.ok(m('1 of sel_*', { Y: 1 }));
  assert.ok(!m('all of sel_*', { Y: 1 }));
  assert.ok(m('all of them', { X: 1, Y: 1 }));
  assert.ok(m('1 of them', { X: 1 }));
});

test('list of maps in a selection is OR of AND groups', () => {
  const r = parseRule(rule(`  s:
    - A: 1
      B: 2
    - C: 3
  condition: s
`));
  assert.ok(r.match(ev({ A: 1, B: 2 })));
  assert.ok(r.match(ev({ C: 3 })));
  assert.ok(!r.match(ev({ A: 1 })));
});

test('category in logsource limits which events match', () => {
  const r = parseRule(rule(`  s:
    A: 1
  condition: s
`, 'logsource:\n  category: process_access\n'));
  assert.ok(!r.match(ev({ A: 1 })));
  assert.ok(r.match({ category: 'process_access', fields: { A: 1 } }));
});

test('techniques come from attack tags', () => {
  const r = parseRule(rule(`  s:
    A: 1
  condition: s
`, 'tags:\n  - attack.execution\n  - attack.t1059.001\n'));
  assert.deepEqual(r.techniques, ['T1059.001']);
});

test('malformed rules are rejected', () => {
  const bad = {
    'not a map': '- a\n- b\n',
    'missing id': 'title: t\ndetection:\n  s:\n    A: 1\n  condition: s\n',
    'missing detection': 'title: t\nid: a\n',
    'no selections': 'title: t\nid: a\ndetection:\n  condition: s\n',
    'bad level': rule('  s:\n    A: 1\n  condition: s\n', 'level: severe\n'),
    'unknown modifier': rule('  s:\n    A|base64: 1\n  condition: s\n'),
    'two match modifiers': rule('  s:\n    A|contains|endswith: 1\n  condition: s\n'),
    'invalid regex': rule("  s:\n    A|re: '(['\n  condition: s\n"),
    'unknown selection in condition': rule('  s:\n    A: 1\n  condition: s and nope\n'),
    'missing condition': rule('  s:\n    A: 1\n'),
    'dangling operator': rule('  s:\n    A: 1\n  condition: s and\n'),
    'unbalanced parens': rule('  s:\n    A: 1\n  condition: (s\n'),
    'wildcard matches nothing': rule('  s:\n    A: 1\n  condition: 1 of x_*\n'),
    'keyword list': rule('  s:\n    - foo\n    - bar\n  condition: s\n'),
    'empty selection': rule('  s: {}\n  condition: s\n'),
    'tags not a list': rule('  s:\n    A: 1\n  condition: s\n', 'tags: attack.t1059\n'),
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(() => parseRule(text), (e) => e instanceof RuleError || e instanceof YamlError, name);
  }
});

test('yaml parser errors', () => {
  assert.throws(() => parseYaml('a: 1\na: 2\n'), YamlError);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), YamlError);
  assert.throws(() => parseYaml("a: 'open\n"), YamlError);
  assert.throws(() => parseYaml('a: [1, 2\n'), YamlError);
  assert.throws(() => parseYaml('just text\n'), YamlError);
});

test('yaml parser handles comments, quotes and nested lists', () => {
  const y = parseYaml(`# top
a: 'it''s # not a comment' # real comment
b:
  - 1
  - x: [p, "q r"]
    y: true
c: ~
`);
  assert.deepEqual(y, { a: "it's # not a comment", b: [1, { x: ['p', 'q r'], y: true }], c: null });
});
