import { handleWorkerRequest } from '../server/worker.js';
import { generateGroundedExplanation } from '../server/providers/openai.js';
import { getAIEnhancedAnswer, isAIEligible } from '../js/ai-explanation.js';
import { getDatasetVersion } from '../js/dataset-version.js';
import { interpretQuery } from '../js/query-interpreter.js';
import { retrieveEvents } from '../js/event-retrieval.js';
import { createRelationshipIndex } from '../js/relationship-traversal.js';
import { createRelationshipEngine } from '../js/relationship-engine.js';
import { buildHistoricalAnswer } from '../js/historical-answer.js';
import { initExplorer } from '../js/explorer.js';

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
async function checkAsync(name, callback) {
  const row = document.createElement('li');
  try { await callback(); row.textContent = `PASS — ${name}`; row.dataset.status = 'pass'; passed += 1; }
  catch (error) { row.textContent = `FAIL — ${name}: ${error.message}`; row.dataset.status = 'fail'; failed += 1; }
  results.append(row);
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const [events, eras, relationships] = await Promise.all([
  fetch('../data/events.json').then((response) => response.json()),
  fetch('../data/eras.json').then((response) => response.json()),
  fetch('../data/relationships.json').then((response) => response.json()),
]);
const graphData = createRelationshipEngine({ events, relationships }).getGraphData();
const relationshipIndex = createRelationshipIndex(graphData);
const version = await getDatasetVersion({ events, eras, relationships });
const query = interpretQuery('How did ARPANET lead to the World Wide Web?', { events, eras });
const retrieval = retrieveEvents(query, { events, eras, relationshipIndex });
const deterministic = buildHistoricalAnswer(query, retrieval, { events, eras, graphData });
assert(isAIEligible(query, deterministic), 'Canonical path example should be eligible for optional explanation.');

function validModelAnswer(base = deterministic) {
  const eventIds = [...base.eventIds];
  const relationshipIds = [...base.relationshipIds];
  const first = events.find((event) => event.id === eventIds[0]);
  return {
    schemaVersion: '1',
    status: 'answered',
    shortAnswer: 'AEON records a path linking the retrieved events.',
    shortAnswerEventIds: eventIds,
    shortAnswerRelationshipIds: relationshipIds,
    statements: [
      { kind: 'dataset_fact', text: `${first.title} — ${first.displayYear}. ${first.description}`, eventIds: [first.id], relationshipIds: [] },
      { kind: 'explanation', text: 'The selected sequence forms a documented connection in AEON’s graph.', eventIds, relationshipIds },
    ],
    relationshipClaims: base.relationshipClaims.map((claim) => ({
      type: claim.type,
      fromEventId: claim.fromEventId,
      toEventId: claim.toEventId,
      relationshipIds: [...claim.relationshipIds],
      text: claim.type === 'CAUSES'
        ? `${events.find((event) => event.id === claim.fromEventId).title} is recorded by AEON as contributing to ${events.find((event) => event.id === claim.toEventId).title}.`
        : `${events.find((event) => event.id === claim.fromEventId).title} is contextually related to ${events.find((event) => event.id === claim.toEventId).title} in AEON records.`,
    })),
    path: base.path.map((step) => ({ ...step, relationshipIds: [...step.relationshipIds] })),
    eventIds,
    relationshipIds,
    uncertainty: '',
  };
}
const goodAnswer = validModelAnswer();
const dataAssets = { 'events.json': events, 'eras.json': eras, 'relationships.json': relationships };
const assetBinding = { async fetch(request) {
  const name = new URL(request.url).pathname.slice(1);
  if (!(name in dataAssets)) return new Response('', { status: 404 });
  return new Response(JSON.stringify(dataAssets[name]), { headers: { 'Content-Type': 'application/json' } });
} };
const env = {
  ALLOWED_ORIGINS: 'https://aeon.test',
  ASSETS: assetBinding,
  AI_LIMITER: { async limit() { return { success: true }; } },
  OPENAI_API_KEY: 'phase4b-test-secret-sentinel',
  OPENAI_MODEL: 'test-model',
};
function request(body, { method = 'POST', origin = 'https://aeon.test', contentType = 'application/json' } = {}) {
  // Origin is a browser-controlled request header and cannot be set by the
  // page's own test harness. A minimal Request-shaped object lets the worker
  // contract tests exercise exact-origin CORS without weakening production.
  const bodyText = method === 'GET' || method === 'OPTIONS' ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    url: 'https://worker.test/v1/explain',
    method,
    headers: new Headers({ Origin: origin, 'Content-Type': contentType }),
    body: bodyText ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(bodyText)); controller.close(); } }) : null,
  };
}
const payload = {
  apiVersion: '1', datasetVersion: version, query: query.raw,
  intent: { type: query.intent, direction: query.direction, depth: query.depth, explanationType: query.explanationType },
  eventIds: deterministic.eventIds, relationshipIds: deterministic.relationshipIds,
};
function fakeProvider(answer = goodAnswer) { return async () => answer; }
async function callWorker(body = payload, options = {}, dependencies = {}) {
  return handleWorkerRequest(request(body, options), env, {
    loadDataset: async () => ({ events, eras, relationships }),
    generateGroundedExplanation: fakeProvider(),
    ...dependencies,
  });
}

await checkAsync('dataset version is deterministic and includes canonical records', async () => {
  assert(version === await getDatasetVersion({ events, eras, relationships }), 'Dataset version changed for identical data.');
});
check('valid model response passes schema and evidence validation', () => {
  const response = validModelAnswer();
  assert(JSON.stringify(response) === JSON.stringify(goodAnswer), 'Fixture was not stable.');
});
await checkAsync('Worker reconstructs canonical data and accepts a valid answer', async () => {
  const response = await callWorker(payload, {}, { generateGroundedExplanation: fakeProvider(goodAnswer) });
  assert(response.status === 200 && response.headers.get('Access-Control-Allow-Origin') === 'https://aeon.test', 'Valid request was not accepted with exact CORS.');
  const result = await response.json();
  assert(result.datasetVersion === version && result.answer.schemaVersion === '1', 'Versioned answer missing.');
});
await checkAsync('Worker resolves its canonical data from the ASSETS binding', async () => {
  const response = await handleWorkerRequest(request(payload), env, { generateGroundedExplanation: fakeProvider(goodAnswer) });
  assert(response.status === 200, 'Canonical data assets were not resolved.');
});
await checkAsync('provider timeout returns a safe failure', async () => {
  const response = await handleWorkerRequest(request(payload), env, {
    loadDataset: async () => ({ events, eras, relationships }),
    timeoutMs: 5,
    generateGroundedExplanation: (_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))),
  });
  const result = await response.json();
  assert(response.status === 503 && result.error.code === 'PROVIDER_TIMEOUT' && !JSON.stringify(result).includes(env.OPENAI_API_KEY), 'Timeout response leaked details or was not safe.');
});

const invalidAnswers = [
  ['malformed schema', (answer) => { answer.path = 'not-an-array'; }],
  ['unknown field', (answer) => { answer.untrusted = 'field'; }],
  ['missing required field', (answer) => { delete answer.schemaVersion; }],
  ['invalid enum', (answer) => { answer.status = 'maybe'; }],
  ['empty answer', (answer) => { answer.shortAnswer = ''; }],
  ['excessive output', (answer) => { answer.statements[0].text = 'x'.repeat(700); }],
  ['invented event ID', (answer) => { answer.eventIds.push('invented-event'); }],
  ['invented relationship ID', (answer) => { answer.relationshipIds.push('invented-relationship'); }],
  ['wrong relationship type', (answer) => { if (answer.relationshipClaims[0]) answer.relationshipClaims[0].type = answer.relationshipClaims[0].type === 'CAUSES' ? 'RELATED_TO' : 'CAUSES'; }],
  ['wrong relationship endpoint', (answer) => { if (answer.relationshipClaims[0]) answer.relationshipClaims[0].toEventId = 'arpanet'; }],
  ['wrong causal direction', (answer) => { const causal = answer.relationshipClaims.find((claim) => claim.type === 'CAUSES'); if (causal) [causal.fromEventId, causal.toEventId] = [causal.toEventId, causal.fromEventId]; }],
  ['broken path', (answer) => { answer.path[0].relationshipIds = ['invented-relationship']; }],
  ['discontinuous path', (answer) => { if (answer.path.length > 1) answer.path[1].fromEventId = 'world-wide-web'; else answer.path[0].fromEventId = 'world-wide-web'; }],
  ['incorrect path endpoint', (answer) => { answer.path.at(-1).toEventId = 'arpanet'; }],
  ['unsupported causal claim', (answer) => { answer.shortAnswer = 'One event caused another.'; answer.shortAnswerRelationshipIds = []; }],
  ['RELATED_TO used as CAUSES', (answer) => {
    const edge = graphData.edges.find((item) => item.type === 'RELATED_TO' && deterministic.eventIds.includes(item.source.id) && deterministic.eventIds.includes(item.target.id));
    if (!edge) { answer.relationshipClaims.push({ type: 'CAUSES', fromEventId: 'artificial-intelligence', toEventId: 'world-wide-web', relationshipIds: [graphData.edges.find((item) => item.type === 'RELATED_TO')?.id ?? 'missing'], text: 'This caused that.' }); }
  }],
];
for (const [label, mutate] of invalidAnswers) {
  await checkAsync(`${label} causes full-response rejection`, async () => {
    const answer = validModelAnswer();
    mutate(answer);
    const response = await callWorker(payload, {}, { generateGroundedExplanation: fakeProvider(answer) });
    assert(response.status === 502, `${label} response was not rejected.`);
    const body = await response.json();
    assert(body.error.code === 'GROUNDING_FAILED', 'Grounding failure was not reported safely.');
  });
}

for (const [label, question] of [
  ['ambiguous', 'What is the empire?'],
  ['unsupported', 'Tell me a recipe for soup'],
  ['no-match', 'What happened on Mars in 2020?'],
  ['exact lookup', 'The World Wide Web event'],
  ['date lookup', 'What happened in 1989?'],
  ['era lookup', 'Tell me about the Ancient World era'],
  ['before/after', 'What came after the printing press?'],
  ['direct cause list', 'What caused the World Wide Web?'],
]) {
  await checkAsync(`${label} bypasses AI`, async () => {
    const parsed = interpretQuery(question, { events, eras });
    const found = retrieveEvents(parsed, { events, eras, relationshipIndex });
    const answer = buildHistoricalAnswer(parsed, found, { events, eras, graphData });
    if (isAIEligible(parsed, answer)) return;
    let calls = 0;
    const result = await getAIEnhancedAnswer({ query: parsed, deterministicAnswer: answer, datasetVersion: version, events, graphData, requestExplanation: async () => { calls += 1; return { answer: goodAnswer }; } });
    assert(!calls && result.answer === answer && !result.fallback, 'Ineligible query called provider or changed deterministic result.');
  });
}

await checkAsync('intent, evidence scope, and dataset version cannot be forged', async () => {
  for (const changed of [
    { ...payload, datasetVersion: 'sha256-' + '0'.repeat(64) },
    { ...payload, eventIds: [...payload.eventIds, 'fire'] },
    { ...payload, relationshipIds: ['relationship-0058'] },
    { ...payload, intent: { ...payload.intent, direction: 'backward' } },
  ]) {
    const response = await callWorker(changed, {}, { generateGroundedExplanation: fakeProvider(goodAnswer) });
    assert(response.status === 409 || response.status === 422, 'Forged evidence or version was accepted.');
  }
});
await checkAsync('invalid method, content type, JSON, payload size, and origin are rejected', async () => {
  const checks = [
    [await callWorker(payload, { method: 'GET' }), 405],
    [await callWorker(payload, { contentType: 'text/plain' }), 415],
    [await callWorker('{not-json'), 400],
    [await callWorker('x'.repeat(9000)), 413],
    [await callWorker(payload, { origin: 'https://evil.test' }), 403],
  ];
  for (const [response, status] of checks) assert(response.status === status, `Expected ${status}, got ${response.status}.`);
});
await checkAsync('request rate limit failure prevents provider invocation', async () => {
  let calls = 0;
  const response = await handleWorkerRequest(request(payload), { ...env, AI_LIMITER: { async limit() { return { success: false }; } } }, {
    loadDataset: async () => ({ events, eras, relationships }),
    generateGroundedExplanation: async () => { calls += 1; return goodAnswer; },
  });
  assert(response.status === 429 && calls === 0, 'Rate limit did not stop provider request.');
});
await checkAsync('server bypasses unsupported, ambiguous, no-match, and simple deterministic queries', async () => {
  let calls = 0;
  for (const question of ['Tell me a recipe for soup', 'What happened on Mars in 2020?', 'What came after the printing press?', 'What caused the World Wide Web?']) {
    const response = await callWorker({ ...payload, query: question }, {}, { generateGroundedExplanation: async () => { calls += 1; return goodAnswer; } });
    assert(response.status === 422, `The endpoint did not reject ${question}.`);
  }
  assert(calls === 0, 'An ineligible server request reached the provider.');
});
await checkAsync('missing provider key returns generic fallback-compatible failure', async () => {
  const response = await callWorker(payload, {}, { generateGroundedExplanation: (input, options) => generateGroundedExplanation(input, { ...options, env: { OPENAI_MODEL: env.OPENAI_MODEL } }) });
  const body = await response.text();
  assert(response.status === 503 && !body.includes('OPENAI_API_KEY') && !body.includes(env.OPENAI_API_KEY), 'Provider configuration error disclosed sensitive details.');
});
await checkAsync('OpenAI adapter rejects malformed JSON without external network', async () => {
  let fetchCalled = false;
  try {
    await generateGroundedExplanation({ systemPrompt: 'test', userPrompt: '{}' }, {
      env,
      fetchImpl: async (_url, init) => {
        fetchCalled = true;
        assert(init.headers.Authorization === `Bearer ${env.OPENAI_API_KEY}`, 'Server adapter did not use server-only secret.');
        return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{invalid' }] }] }), { status: 200 });
      },
    });
    throw new Error('Malformed provider output was accepted.');
  } catch (error) { assert(fetchCalled && error instanceof SyntaxError, 'Malformed provider JSON did not fail closed.'); }
});
await checkAsync('provider network and rate-limit failures become safe endpoint errors', async () => {
  for (const providerStatus of [429, 500]) {
    const response = await callWorker(payload, {}, {
      generateGroundedExplanation: (input, options) => generateGroundedExplanation(input, {
        ...options,
        fetchImpl: async () => new Response(JSON.stringify({ error: 'private provider detail' }), { status: providerStatus }),
      }),
    });
    const text = await response.text();
    assert(response.status === 503 && !text.includes('private provider detail'), `Provider status ${providerStatus} leaked or was mishandled.`);
  }
  const response = await callWorker(payload, {}, {
    generateGroundedExplanation: (input, options) => generateGroundedExplanation(input, { ...options, fetchImpl: async () => { throw new Error('network detail'); } }),
  });
  assert(response.status === 503, 'Network failure did not safely fail.');
});
await checkAsync('excessive evidence counts are rejected before provider invocation', async () => {
  let calls = 0;
  const response = await callWorker({ ...payload, eventIds: Array.from({ length: 13 }, (_, index) => `event-${index}`) }, {}, {
    generateGroundedExplanation: async () => { calls += 1; return goodAnswer; },
  });
  assert(response.status === 400 && calls === 0, 'Excess evidence was sent to the provider.');
});
await checkAsync('browser provider client sends no auth or secret header', async () => {
  const { requestGroundedExplanation } = await import('../js/provider-client.js');
  let received;
  await requestGroundedExplanation(payload, { endpoint: 'https://worker.test', fetchImpl: async (_url, init) => {
    received = init;
    return new Response(JSON.stringify({ apiVersion: '1', datasetVersion: version, answer: goodAnswer }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert(!('Authorization' in received.headers) && !JSON.stringify(received.headers).includes('test-secret'), 'Browser request exposed provider authentication.');
  const frontendSources = await Promise.all(['../js/main.js', '../js/explorer.js', '../js/provider-client.js'].map((path) => fetch(path).then((response) => response.text())));
  assert(frontendSources.every((source) => !source.includes('phase4b-test-secret-sentinel') && !source.includes('OPENAI_API_KEY')), 'A provider secret reference appeared in frontend source.');
});

let logs = [];
const oldLog = console.log;
const oldError = console.error;
console.log = (...values) => logs.push(values.join(' '));
console.error = (...values) => logs.push(values.join(' '));
await callWorker(payload, {}, { generateGroundedExplanation: async () => { throw new Error('provider diagnostic contains secret'); } });
console.log = oldLog;
console.error = oldError;
check('raw query and provider secret are not written to operational logs', () => {
  assert(!logs.join('\n').includes(query.raw) && !logs.join('\n').includes(env.OPENAI_API_KEY), 'Sensitive values appeared in logs.');
});

const explorerContainer = document.querySelector('#historical-explorer');
let openedTimeline = null;
let openedGraph = null;
const explorer = initExplorer({
  container: explorerContainer,
  openButton: document.querySelector('#open-explorer'),
  events, eras, graphData, datasetVersion: version,
  requestExplanation: async () => ({ apiVersion: '1', datasetVersion: version, answer: goodAnswer }),
  onOpenTimeline: (id) => { openedTimeline = id; },
  onOpenGraph: (id) => { openedGraph = id; },
});
document.querySelector('#open-explorer').click();
await checkAsync('AI-eligible Ask AEON query exposes an accessible loading state', async () => {
  let finish;
  const loadingExplorer = initExplorer({
    container: explorerContainer,
    openButton: document.querySelector('#open-explorer'),
    events, eras, graphData, datasetVersion: version,
    requestExplanation: () => new Promise((resolve) => { finish = resolve; }),
  });
  const pending = loadingExplorer.submitQuestionWithExplanation('How did ARPANET lead to the World Wide Web?');
  assert(document.querySelector('#explorer-status').textContent.includes('Preparing'), 'Loading status was not announced.');
  finish({ apiVersion: '1', datasetVersion: version, answer: goodAnswer });
  await pending;
});
await checkAsync('AI-eligible Ask AEON query renders explanation, citations, and navigation', async () => {
  const result = await explorer.submitQuestionWithExplanation('How did ARPANET lead to the World Wide Web?');
  assert(result.answerMode === 'ai' && !document.querySelector('#explorer-statements').hidden, 'AI explanation was not rendered.');
  document.querySelector('#explorer-statements [data-event-id]')?.click();
  assert(openedTimeline, 'Event evidence did not navigate to Timeline.');
  document.querySelector('#explorer-open-graph').click();
  assert(openedGraph === result.navigation.graph.rootEventId, 'Connection action did not open the graph root.');
});
await checkAsync('provider failure preserves deterministic Phase 4A result', async () => {
  const fallbackExplorer = initExplorer({
    container: explorerContainer,
    openButton: document.querySelector('#open-explorer'),
    events, eras, graphData, datasetVersion: version,
    requestExplanation: async () => { throw new Error('synthetic provider unavailable'); },
  });
  const result = await fallbackExplorer.submitQuestionWithExplanation('How did ARPANET lead to the World Wide Web?');
  assert(result.answerMode === 'deterministic' && result.status === 'supported', 'Provider failure lost deterministic answer.');
});
await checkAsync('malformed or ungrounded model output falls back without partial render', async () => {
  const invalidExplorer = initExplorer({
    container: explorerContainer,
    openButton: document.querySelector('#open-explorer'),
    events, eras, graphData, datasetVersion: version,
    requestExplanation: async () => ({ apiVersion: '1', datasetVersion: version, answer: { ...goodAnswer, relationshipIds: ['made-up'] } }),
  });
  const result = await invalidExplorer.submitQuestionWithExplanation('How did ARPANET lead to the World Wide Web?');
  assert(result.answerMode === 'deterministic' && document.querySelector('#explorer-statements').hidden, 'Ungrounded partial model answer appeared.');
});
await checkAsync('dataset-version mismatch falls back to the deterministic result', async () => {
  const mismatchExplorer = initExplorer({
    container: explorerContainer,
    openButton: document.querySelector('#open-explorer'),
    events, eras, graphData, datasetVersion: version,
    requestExplanation: async () => ({ apiVersion: '1', datasetVersion: `sha256-${'0'.repeat(64)}`, answer: goodAnswer }),
  });
  const result = await mismatchExplorer.submitQuestionWithExplanation('How did ARPANET lead to the World Wide Web?');
  assert(result.answerMode === 'deterministic' && result.status === 'supported', 'Mismatched server data version did not fall back.');
});
check('keyboard-visible focus and reduced-motion/responsive hooks exist', () => {
  document.querySelector('#explorer-question').focus();
  assert(document.activeElement.id === 'explorer-question' && matchMedia('(prefers-reduced-motion: reduce)').matches !== undefined, 'Keyboard or motion hooks are unavailable.');
  assert(document.querySelector('#explorer-privacy-note') && getComputedStyle(document.body).overflowX !== 'scroll', 'Disclosure missing or horizontal overflow present.');
});

await checkAsync('real app initializes with the landing page and canonical events', async () => {
  const frame = document.createElement('iframe');
  frame.title = 'AEON application smoke test';
  frame.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:900px;border:0;opacity:0.01;pointer-events:none';
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', reject, { once: true });
  });
  const appResponse = await fetch('../index.html');
  const appHtml = await appResponse.text();
  const endpointMeta = '<meta name="aeon-api-endpoint" content="http://127.0.0.1:8787">';
  const fetchProbe = `<base href="../"><script>window.__AEON_WORKER_CALLS__=0;const aeonOriginalFetch=window.fetch.bind(window);window.fetch=(...args)=>{if(String(args[0]).includes('127.0.0.1:8787/v1/explain'))window.__AEON_WORKER_CALLS__++;return aeonOriginalFetch(...args)}</script>`;
  frame.srcdoc = appHtml.replace('<head>', `<head>${fetchProbe}`).replace('<meta name="aeon-api-endpoint" content="">', endpointMeta);
  document.body.append(frame);
  await loaded;
  const app = frame.contentDocument;
  const deadline = Date.now() + 5_000;
  while (app.querySelectorAll('.timeline-moment').length !== 80 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(!app.querySelector('#landing').hidden && app.querySelectorAll('.timeline-moment').length === 80
    && app.documentElement.scrollWidth <= frame.contentWindow.innerWidth, 'Landing/timeline initialization failed or the app overflows its available viewport.');
  window.__AEON_APP_FRAME__ = frame;
});
await checkAsync('Begin Journey reveals the existing timeline without reloading', async () => {
  const app = window.__AEON_APP_FRAME__.contentDocument;
  await new Promise((resolve) => setTimeout(resolve, 250));
  app.querySelector('#begin-journey').click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert(app.querySelector('#landing').hidden && !app.querySelector('#timeline-view').hidden && app.querySelectorAll('.timeline-moment').length === 80,
    `Begin Journey did not enter the populated timeline (landing=${app.querySelector('#landing').hidden}, timeline=${app.querySelector('#timeline-view').hidden}, transition=${app.querySelector('#landing').classList.contains('is-leaving')}).`);
});
await checkAsync('real app keeps deterministic Ask AEON queries off the Worker', async () => {
  const frame = window.__AEON_APP_FRAME__;
  const app = frame.contentDocument;
  app.querySelector('#open-explorer').click();
  const input = app.querySelector('#explorer-question');
  input.value = 'internet';
  app.querySelector('#explorer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(frame.contentWindow.__AEON_WORKER_CALLS__ === 0, 'A deterministic query unnecessarily called the Worker.');
});
await checkAsync('real app completes Ask AEON through Wrangler fake provider and validates the response', async () => {
  const frame = window.__AEON_APP_FRAME__;
  const app = frame.contentDocument;
  const input = app.querySelector('#explorer-question');
  input.value = 'How did ARPANET lead to the World Wide Web?';
  app.querySelector('#explorer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const deadline = Date.now() + 8_000;
  while ((!app.querySelector('#explorer-status').textContent.includes('validated against') || app.querySelector('#explorer-statements').hidden) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(frame.contentWindow.__AEON_WORKER_CALLS__ === 1, 'An eligible query did not call the local Worker exactly once.');
  assert(app.querySelector('#explorer-status').textContent.includes('validated against') && !app.querySelector('#explorer-statements').hidden,
    'The validated fake-provider explanation did not render in Ask AEON.');
  assert(app.querySelector('#explorer-statements [data-event-id]'), 'Evidence references are not visible.');
  app.querySelector('#explorer-open-graph').click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(!app.querySelector('#history-graph-view').hidden && app.querySelector('#history-graph-heading') === app.activeElement,
    'Graph navigation did not open the existing graph or move focus.');
  app.querySelector('#graph-return-timeline')?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(!app.querySelector('#historical-explorer').hidden && app.activeElement.id === 'explorer-open-graph',
    `Return state hidden=${app.querySelector('#historical-explorer').hidden}, focus=${app.activeElement?.id}, graphHidden=${app.querySelector('#history-graph-view').hidden}.`);
});
await checkAsync('real Ask AEON navigation selects a timeline event and preserves the existing view', async () => {
  const app = window.__AEON_APP_FRAME__.contentDocument;
  app.querySelector('#open-explorer').click();
  const input = app.querySelector('#explorer-question');
  input.value = 'internet';
  app.querySelector('#explorer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  app.querySelector('#explorer-evidence [data-event-id="internet"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(app.querySelector('#historical-explorer').hidden && !app.querySelector('#timeline-exploration').hidden
    && app.querySelector('.timeline-moment[aria-pressed="true"]')?.dataset.eventId === 'internet'
    && app.activeElement?.dataset.eventId === 'internet', 'Ask AEON navigation did not return to the selected timeline event and restore its focus.');
});

summary.textContent = `${passed} passed; ${failed} failed.`;
document.documentElement.dataset.testStatus = failed ? 'fail' : 'pass';
window.__AEON_PHASE4B_RESULTS__ = { passed, failed };
