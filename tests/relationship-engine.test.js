import { createRelationshipEngine, normalizeLegacyRelationships } from '../js/relationship-engine.js';

const results = document.querySelector('#results');
const summary = document.querySelector('#summary');
let passed = 0;
let failed = 0;

function check(name, callback) {
  const item = document.createElement('li');
  try {
    callback();
    item.textContent = `PASS — ${name}`;
    item.dataset.status = 'pass';
    passed += 1;
  } catch (error) {
    item.textContent = `FAIL — ${name}: ${error.message}`;
    item.dataset.status = 'fail';
    failed += 1;
  }
  results.append(item);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function engine(edges) {
  return createRelationshipEngine({ events, relationships: edges });
}

function edge(id, source, target, type = 'CAUSES') {
  return { id, source: { type: 'event', id: source }, target: { type: 'event', id: target }, type };
}

const events = [
  { id: 'a', title: 'A', year: 100, era: 'ancient', displayYear: '100 CE' },
  { id: 'b', title: 'B', year: 200, era: 'ancient', displayYear: '200 CE' },
  { id: 'c', title: 'C', year: 50, era: 'ancient', displayYear: '50 CE' },
];

check('valid causal relationship', () => {
  assert(engine([edge('r1', 'a', 'b')]).getDiagnostics().length === 0, 'expected no diagnostics');
});
check('missing endpoint detected and excluded from default graph', () => {
  const result = engine([edge('r1', 'a', 'missing')]);
  assert(result.getDiagnostics().some((item) => item.code === 'MISSING_ENDPOINT'), 'missing endpoint not reported');
  assert(result.getGraphData().edges.length === 0, 'invalid edge should not enter default graph');
  assert(result.getGraphData({ includeInvalid: true }).edges.length === 1, 'invalid edge should remain inspectable');
});
check('invalid relationship type detected', () => {
  assert(engine([edge('r1', 'a', 'b', 'INVENTED')]).getDiagnostics().some((item) => item.code === 'INVALID_TYPE'), 'type not reported');
});
check('duplicate edge detected and retained', () => {
  const result = engine([edge('r1', 'a', 'b'), edge('r2', 'a', 'b')]);
  assert(result.getDiagnostics().some((item) => item.code === 'DUPLICATE_EDGE'), 'duplicate not reported');
  assert(result.getGraphData().edges.length === 2, 'duplicate should not be silently removed');
});
check('reciprocal related edge detected and retained', () => {
  const result = engine([edge('r1', 'a', 'b', 'RELATED_TO'), edge('r2', 'b', 'a', 'RELATED_TO')]);
  assert(result.getDiagnostics().some((item) => item.code === 'RECIPROCAL_DUPLICATE'), 'reciprocal not reported');
  assert(result.getGraphData().edges.length === 2, 'reciprocal should remain inspectable');
});
check('self-link detected', () => {
  assert(engine([edge('r1', 'a', 'a')]).getDiagnostics().some((item) => item.code === 'SELF_LINK'), 'self-link not reported');
});
check('causal cycle detected', () => {
  const result = engine([edge('r1', 'a', 'b'), edge('r2', 'b', 'a')]);
  assert(result.getDiagnostics().some((item) => item.code === 'CAUSAL_CYCLE'), 'cycle not reported');
});
check('suspicious chronology detected', () => {
  assert(engine([edge('r1', 'a', 'c')]).getDiagnostics().some((item) => item.code === 'SUSPICIOUS_CHRONOLOGY'), 'chronology not reported');
});
check('legacy relationship migration preserves direction and provenance', () => {
  const normalized = normalizeLegacyRelationships([
    { id: 'b', causes: ['a'], consequences: ['c'], relatedEvents: ['a'] },
  ]);
  assert(normalized.length === 3, 'expected one edge per legacy reference');
  assert(normalized[0].source.id === 'a' && normalized[0].target.id === 'b' && normalized[0].type === 'CAUSES', 'causes direction incorrect');
  assert(normalized[1].source.id === 'b' && normalized[1].target.id === 'c' && normalized[1].type === 'CAUSES', 'consequences direction incorrect');
  assert(normalized[2].provenance.field === 'relatedEvents', 'provenance missing');
});
check('graph-ready output has typed nodes and edges', () => {
  const graph = engine([edge('r1', 'a', 'b')]).getGraphData();
  assert(graph.nodes[0].type === 'event' && graph.nodes.length === 3, 'node shape incorrect');
  assert(graph.edges[0].source.type === 'event' && graph.edges[0].type === 'CAUSES', 'edge shape incorrect');
});
check('typed endpoints can resolve a future entity without adding entity data now', () => {
  const result = createRelationshipEngine({
    events,
    entities: { entity: [{ id: 'fixture-entity', title: 'Typed fixture' }] },
    relationships: [{ id: 'r1', source: { type: 'event', id: 'a' }, target: { type: 'entity', id: 'fixture-entity' }, type: 'RELATED_TO' }],
  });
  assert(result.getDiagnostics().length === 0, 'registered typed endpoint should validate');
  assert(result.getGraphData().nodes.some((node) => node.type === 'entity'), 'typed node missing from graph output');
});

try {
  const [canonicalEvents, relationships] = await Promise.all([
    fetch('../data/events.json').then((response) => response.json()),
    fetch('../data/relationships.json').then((response) => response.json()),
  ]);
  check('canonical data migration covers every legacy relationship', () => {
    const expected = normalizeLegacyRelationships(canonicalEvents);
    assert(expected.length === relationships.length, `legacy ${expected.length}, canonical ${relationships.length}`);
    assert(relationships.every((item, index) => item.id === expected[index].id && item.source.id === expected[index].source.id
      && item.target.id === expected[index].target.id && item.type === expected[index].type
      && item.provenance.field === expected[index].provenance.field), 'canonical records differ from legacy normalization');
  });
  check('canonical graph output includes all timeline events and relationships', () => {
    const graph = createRelationshipEngine({ events: canonicalEvents, relationships }).getGraphData();
    assert(graph.nodes.length === canonicalEvents.length, 'event node count mismatch');
    assert(graph.edges.length === relationships.length, 'relationship records should be preserved');
  });
} catch (error) {
  check('canonical data files load', () => { throw error; });
}

summary.textContent = `${passed} passed · ${failed} failed`;
summary.dataset.status = failed ? 'fail' : 'pass';
