import { interpretQuery } from '../js/query-interpreter.js';
import { rankEventCandidates, retrieveEvents } from '../js/event-retrieval.js';
import { adjacentRelationships, createRelationshipIndex, findHistoricalPath } from '../js/relationship-traversal.js';
import { validateGroundedAnswer } from '../js/answer-grounding.js';
import { buildHistoricalAnswer } from '../js/historical-answer.js';
import { initExplorer } from '../js/explorer.js';
import { createRelationshipEngine } from '../js/relationship-engine.js';

const results = document.querySelector('#test-results');
const summary = document.querySelector('#test-summary');
let passed = 0;
let failed = 0;

function check(name, callback) {
  const row = document.createElement('li');
  try { callback(); row.textContent = `PASS — ${name}`; row.dataset.status = 'pass'; passed += 1; }
  catch (error) { row.textContent = `FAIL — ${name}: ${error.message}`; row.dataset.status = 'fail'; failed += 1; }
  results.append(row);
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const event = (id, title, year, era = 'test', description = `${title} event record.`) => ({ id, title, year, displayYear: `${year} CE`, era, description, importance: 'major' });
const events = [
  event('arpanet', 'ARPANET Sends Its First Message', 1969, 'contemporary', 'An early packet-switching network contributed to the development of the internet.'),
  event('internet', "The Internet's Shared Protocol", 1983, 'contemporary', 'A common protocol helped connect networks.'),
  event('world-wide-web', 'The World Wide Web', 1989, 'contemporary', 'A system of linked documents and resources runs over the internet.'),
  event('artificial-intelligence', 'Generative AI Enters Public Use', 2022, 'contemporary', 'Generative AI tools became broadly accessible.'),
  event('roman-empire', 'The Roman Empire', -27, 'ancient'),
  event('fall-west-rome', 'The Western Roman Empire Ends', 476, 'ancient'),
  event('printing-press', 'The Printing Press', 1440, 'early-modern'),
  event('printing-aftermath', 'Print Culture Expands', 1500, 'early-modern'),
  event('wonderwerk', 'Early Hearth Evidence', -100000, 'prehistory', 'Evidence from Wonderwerk Cave indicates early fire use.'),
];
const eras = [
  { id: 'prehistory', title: 'Deep Time', startYear: -2500000, endYear: -8000 },
  { id: 'ancient', title: 'The Ancient World', startYear: -7999, endYear: 499 },
  { id: 'early-modern', title: 'A Changing World', startYear: 1450, endYear: 1759 },
  { id: 'contemporary', title: 'The Contemporary Age', startYear: 1945, endYear: 2026 },
];
const rel = (id, source, target, type = 'CAUSES') => ({ id, source: { type: 'event', id: source }, target: { type: 'event', id: target }, type, provenance: { eventId: source, field: 'test' } });
const edges = [
  rel('cause-1', 'arpanet', 'internet'), rel('cause-1-duplicate', 'arpanet', 'internet'),
  rel('cause-2', 'internet', 'world-wide-web'), rel('context-ai', 'world-wide-web', 'artificial-intelligence', 'RELATED_TO'),
  rel('roman-cause', 'roman-empire', 'fall-west-rome'), rel('roman-context', 'roman-empire', 'printing-press', 'RELATED_TO'),
  rel('press-cause', 'printing-press', 'printing-aftermath'),
];
const graphData = createRelationshipEngine({ events, relationships: edges }).getGraphData();
const relationIndex = createRelationshipIndex(graphData);
const interpret = (question) => interpretQuery(question, { eras, events });
const retrieve = (question) => {
  const query = interpret(question);
  return { query, result: retrieveEvents(query, { events, eras, relationshipIndex: relationIndex }) };
};

check('exact event ID lookup populates query candidates', () => {
  const { query, result } = retrieve('internet');
  assert(result.target?.id === 'internet' && query.eventCandidates.includes('internet'), 'event ID was not resolved into query candidates');
});
check('case-insensitive exact title lookup', () => assert(retrieve("THE INTERNET'S SHARED PROTOCOL").result.target?.id === 'internet', 'case-insensitive title failed'));
check('partial title lookup', () => assert(retrieve('Printing Press').result.target?.id === 'printing-press', 'partial title failed'));
check('description keyword lookup', () => assert(retrieve('Wonderwerk Cave').result.target?.id === 'wonderwerk', 'description term did not retrieve its event'));
check('multiword description phrase lookup', () => assert(retrieve('evidence from Wonderwerk Cave in South Africa').result.target?.id === 'wonderwerk', 'multiword description phrase did not retrieve its event'));
check('date lookup', () => assert(retrieve('What happened in 1983?').result.target?.id === 'internet', 'date lookup did not match the exact year'));
check('era lookup', () => assert(retrieve('What happened in the Contemporary Age?').result.eraEvents.length === 4, 'era overview did not retrieve all its events'));
check('cause query follows incoming directed causes', () => {
  const { query, result } = retrieve('What caused the Western Roman Empire Ends?');
  assert(query.intent === 'cause_explanation' && result.relationships.some((edge) => edge.source === 'roman-empire' && edge.target === 'fall-west-rome'), 'incoming cause was not retrieved');
});
check('consequence query follows outgoing directed causes', () => {
  const { query, result } = retrieve('What were the consequences of the Roman Empire?');
  assert(query.intent === 'consequence_lookup' && result.relationships.some((edge) => edge.source === 'roman-empire' && edge.target === 'fall-west-rome'), 'outgoing consequence was not retrieved');
});
check('related query returns contextual edges only', () => {
  const { query, result } = retrieve('Events related to the Roman Empire');
  assert(query.intent === 'related_events' && result.relationships.every((edge) => edge.type === 'RELATED_TO'), 'context results included other types');
});
check('historical path query preserves edge type and path direction', () => {
  const { query, result } = retrieve('How did ARPANET lead to the World Wide Web?');
  assert(query.intent === 'historical_path' && result.path?.found && result.path.nodes[0] === 'arpanet' && result.path.nodes.at(-1) === 'world-wide-web', 'directed path was not found');
});
check('what came after query returns later-dated events', () => {
  const { query, result } = retrieve('What came after the Printing Press?');
  assert(query.intent === 'what_after' && result.chronology.some((item) => item.id === 'printing-aftermath'), 'later chronology was not found');
});
check('what came before query returns earlier-dated events', () => {
  const { query, result } = retrieve('What came before the World Wide Web?');
  assert(query.intent === 'what_before' && result.chronology.some((item) => item.id === 'internet'), 'earlier chronology was not found');
});
check('ambiguous event lookup returns explicit candidates', () => {
  const duplicates = [...events, event('printing-another', 'The Printing Press', 1450, 'early-modern')];
  const query = interpretQuery('The Printing Press', { eras, events: duplicates });
  const result = retrieveEvents(query, { events: duplicates, eras, relationshipIndex: relationIndex });
  assert(result.status === 'ambiguous' && result.candidates.length === 2, 'duplicate title was silently resolved');
});
check('unsupported question remains unsupported', () => assert(interpret('Write a recipe for bread').status === 'unsupported', 'unsupported intent was guessed'));
check('no matching event returns no_match', () => assert(retrieve('What is quantum mechanics?').result.status === 'no_match', 'unmatched supported lookup did not return no_match'));
check('canonical adjacency respects cause direction', () => {
  assert(adjacentRelationships(relationIndex, 'fall-west-rome', { type: 'CAUSES', direction: 'incoming' }).some((edge) => edge.source === 'roman-empire'), 'incoming cause missing');
  assert(adjacentRelationships(relationIndex, 'fall-west-rome', { type: 'CAUSES', direction: 'outgoing' }).length === 0, 'cause was reversed');
});
check('relationship traversal retains duplicate relationship IDs', () => assert(relationIndex.edges.find((edge) => edge.source === 'arpanet' && edge.target === 'internet').relationshipIds.length === 2, 'duplicates/provenance were lost'));
check('path depth is bounded', () => assert(!findHistoricalPath(relationIndex, 'arpanet', 'world-wide-web', { maxDepth: 1 }).found, 'path exceeded traversal depth'));
check('cycles terminate without repeated nodes', () => {
  const cycleIndex = createRelationshipIndex({ nodes: graphData.nodes.slice(0, 3), edges: [rel('ab', 'arpanet', 'internet'), rel('bc', 'internet', 'world-wide-web'), rel('ca', 'world-wide-web', 'arpanet')] });
  const path = findHistoricalPath(cycleIndex, 'arpanet', 'world-wide-web', { maxDepth: 4 });
  assert(path.found && new Set(path.nodes).size === path.nodes.length, 'cycle traversal repeated a node');
});
check('invalid event IDs fail grounding validation', () => {
  const invalid = { eventIds: ['invented-event'], factualStatements: [{ eventIds: ['invented-event'] }], relationshipClaims: [], path: [], navigation: { timeline: { eventIds: ['invented-event'] } } };
  assert(!validateGroundedAnswer(invalid, { events, graphData }).valid, 'unknown event ID was accepted');
});
check('invalid relationship IDs fail grounding validation', () => {
  const invalid = { eventIds: ['internet'], factualStatements: [], relationshipClaims: [{ type: 'CAUSES', fromEventId: 'arpanet', toEventId: 'internet', relationshipIds: ['invented-link'] }], path: [], navigation: { timeline: { eventIds: ['internet'] } } };
  assert(!validateGroundedAnswer(invalid, { events, graphData }).valid, 'unknown relationship ID was accepted');
});
check('grounding accepts valid causal claims and rejects false direction', () => {
  const valid = { eventIds: ['arpanet', 'internet'], factualStatements: [{ eventIds: ['internet'] }], relationshipClaims: [{ type: 'CAUSES', fromEventId: 'arpanet', toEventId: 'internet', relationshipIds: ['cause-1'] }], path: [{ fromEventId: 'arpanet', toEventId: 'internet', type: 'CAUSES', relationshipIds: ['cause-1'] }], navigation: { timeline: { eventIds: ['internet'] }, graph: { rootEventId: 'arpanet' } } };
  assert(validateGroundedAnswer(valid, { events, graphData }).valid, 'valid evidence was rejected');
  valid.relationshipClaims[0].fromEventId = 'internet';
  assert(!validateGroundedAnswer(valid, { events, graphData }).valid, 'false causal direction was accepted');
});
check('answer builder distinguishes contextual paths from causal claims', () => {
  const { query, result } = retrieve('How did the World Wide Web connect to Generative AI?');
  const answer = buildHistoricalAnswer(query, result, { events, eras, graphData });
  assert(answer.path.some((step) => step.type === 'RELATED_TO') && !answer.relationshipClaims.some((claim) => claim.type === 'CAUSES' && claim.fromEventId === 'world-wide-web' && claim.toEventId === 'artificial-intelligence'), 'context was promoted to causality');
});

let timelineOpened = null;
let graphOpened = null;
let returned = 0;
const explorerApi = initExplorer({
  container: document.querySelector('#historical-explorer'), openButton: document.querySelector('#open-explorer'), events, eras, graphData,
  onOpen: () => {}, onOpenTimeline: (id) => { timelineOpened = id; }, onOpenGraph: (id) => { graphOpened = id; }, onReturn: () => { returned += 1; },
});
check('timeline navigation uses selected event ID', () => {
  const answer = explorerApi.submitQuestion('internet');
  document.querySelector('#historical-explorer [data-event-id="internet"]')?.click();
  assert(answer.eventIds.includes('internet') && timelineOpened === 'internet', 'timeline event callback did not receive the grounded ID');
});
check('graph navigation uses an existing event root', () => {
  const answer = explorerApi.submitQuestion('How did ARPANET lead to the World Wide Web?');
  document.querySelector('#explorer-open-graph').click();
  assert(graphOpened === 'arpanet', `graph callback did not receive the selected real event root (root=${answer.navigation.graph?.rootEventId}; status=${answer.status}; callback=${graphOpened})`);
});
check('keyboard form submission is semantic', () => {
  const input = document.querySelector('#explorer-question');
  input.value = 'internet';
  document.querySelector('#explorer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert(explorerApi.getLastAnswer()?.eventIds.includes('internet'), 'form submission did not produce a result');
});
check('example question fills and submits through the form pipeline', () => {
  document.querySelector('[data-explorer-example]').click();
  assert(explorerApi.getLastAnswer()?.intent === 'what_after', 'example did not use the deterministic query pipeline');
});
check('return navigation calls the timeline return hook', () => {
  document.querySelector('#historical-explorer').hidden = false;
  document.querySelector('#explorer-return').click();
  document.querySelector('#explorer-question').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert(returned === 2, 'button or Escape return callback was not called');
});
check('reduced-motion preference is queryable and responsive layout controls are present', () => {
  assert(typeof matchMedia('(prefers-reduced-motion: reduce)').matches === 'boolean' && document.querySelector('.historical-explorer'), 'motion or responsive explorer hooks are missing');
});

async function verifyCanonicalData() {
  try {
    const [canonicalEvents, canonicalEras, canonicalRelations] = await Promise.all([
      fetch('../data/events.json').then((response) => response.json()), fetch('../data/eras.json').then((response) => response.json()), fetch('../data/relationships.json').then((response) => response.json()),
    ]);
    const canonicalGraph = createRelationshipEngine({ events: canonicalEvents, relationships: canonicalRelations }).getGraphData();
    const canonicalIndex = createRelationshipIndex(canonicalGraph);
    check('canonical dataset: exact event, date, era and query records resolve', () => {
      assert(canonicalEvents.length === 80 && canonicalEras.length === 6, 'canonical dataset size changed unexpectedly');
      const query = interpretQuery('1983 CE', { events: canonicalEvents, eras: canonicalEras });
      const result = retrieveEvents(query, { events: canonicalEvents, eras: canonicalEras, relationshipIndex: canonicalIndex });
      assert(result.target?.id === 'internet', 'canonical date query did not find the Internet event');
    });
    check('canonical cause query resolves the longer, more specific event title', () => {
      const query = interpretQuery('What caused the Western Roman Empire?', { events: canonicalEvents, eras: canonicalEras });
      const result = retrieveEvents(query, { events: canonicalEvents, eras: canonicalEras, relationshipIndex: canonicalIndex });
      assert(result.target?.id === 'fall-west-rome' && result.relationships.some((edge) => edge.source === 'roman-empire'), 'cause query selected a shorter overlapping event title');
    });
    check('canonical AI relation stays contextual, not causal', () => {
      const query = interpretQuery('How did the internet eventually lead to modern AI?', { events: canonicalEvents, eras: canonicalEras });
      const result = retrieveEvents(query, { events: canonicalEvents, eras: canonicalEras, relationshipIndex: canonicalIndex });
      const answer = buildHistoricalAnswer(query, result, { events: canonicalEvents, eras: canonicalEras, graphData: canonicalGraph });
      assert(query.eraId === null && answer.status === 'supported' && answer.relationshipClaims.some((claim) => claim.type === 'RELATED_TO')
        && !answer.relationshipClaims.some((claim) => claim.type === 'CAUSES' && claim.toEventId === 'artificial-intelligence'), 'canonical contextual AI relationship was misrepresented');
    });
  } catch (error) { check('canonical data loads for exploration', () => { throw error; }); }
}

await verifyCanonicalData();
summary.textContent = `${passed} passed · ${failed} failed`;
summary.dataset.status = failed ? 'fail' : 'pass';
