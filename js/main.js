import { initTimeline, loadTimelineData } from './timeline.js';
import { createRelationshipEngine } from './relationship-engine.js';
import { initGraph } from './graph.js';
import { initExplorer } from './explorer.js';
import { getDatasetVersion } from './dataset-version.js';

const TRANSITION_MS = 420;
const RELATIONSHIPS_URL = new URL('../data/relationships.json', import.meta.url);

function showTimeline(landing, timeline) {
  landing.classList.add('is-leaving');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.setTimeout(() => {
    landing.hidden = true;
    timeline.hidden = false;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    timeline.querySelector('#timeline-heading')?.focus({ preventScroll: true });
  }, prefersReducedMotion ? 0 : TRANSITION_MS);
}

function showLanding(landing, timeline) {
  timeline.hidden = true;
  landing.hidden = false;
  landing.classList.remove('is-leaving');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  document.getElementById('begin-journey')?.focus({ preventScroll: true });
}

async function initializeApplication() {
  const landing = document.getElementById('landing');
  const timeline = document.getElementById('timeline-view');
  const beginButton = document.getElementById('begin-journey');
  const returnButton = document.getElementById('return-home');
  const timelineExploration = document.getElementById('timeline-exploration');
  const graphView = document.getElementById('history-graph-view');
  const explorerView = document.getElementById('historical-explorer');
  const explorerEntry = document.getElementById('open-explorer');
  if (!landing || !timeline || !beginButton || !returnButton || !timelineExploration || !graphView || !explorerView || !explorerEntry) {
    throw new Error('The AEON page structure is incomplete.');
  }

  const { events, eras } = await loadTimelineData();
  let graphApi;
  let explorerApi;
  let graphEntryControl = null;
  let pendingRootId = null;
  let graphReturnView = 'timeline';
  let canonicalRelationships = [];

  async function loadGraphData() {
    const response = await fetch(RELATIONSHIPS_URL);
    if (!response.ok) throw new Error('Canonical relationship data could not be loaded.');
    let relationships;
    try {
      relationships = await response.json();
    } catch {
      throw new Error('Canonical relationship data is not valid JSON.');
    }
    canonicalRelationships = relationships;
    return createRelationshipEngine({ events, relationships }).getGraphData();
  }

  function returnFromGraph(selectedId) {
    if (selectedId) timelineApi.selectById(selectedId, { scrollIntoView: false });
    graphView.hidden = true;
    timeline.classList.remove('is-graph-mode');
    window.setTimeout(() => {
      if (graphReturnView === 'explorer') {
        timelineExploration.hidden = true;
        explorerView.hidden = false;
        explorerApi?.focusGraphAction();
      } else {
        explorerView.hidden = true;
        timelineExploration.hidden = false;
        const focusTarget = graphEntryControl?.isConnected ? graphEntryControl : document.getElementById('open-history-graph');
        focusTarget?.focus({ preventScroll: true });
      }
    });
  }

  function openGraph(eventId, returnView = explorerView.hidden ? 'timeline' : 'explorer') {
    graphReturnView = returnView;
    graphEntryControl = graphReturnView === 'timeline' ? document.getElementById('open-history-graph') : null;
    pendingRootId = eventId;
    timelineExploration.hidden = true;
    explorerView.hidden = true;
    graphView.hidden = false;
    timeline.classList.add('is-graph-mode');
    graphApi?.setRoot(eventId);
    document.getElementById('history-graph-heading')?.focus({ preventScroll: true });
  }

  function openTimelineEvent(eventId) {
    if (!timelineApi.selectById(eventId)) return false;
    explorerView.hidden = true;
    graphView.hidden = true;
    timeline.classList.remove('is-graph-mode');
    timelineExploration.hidden = false;
    window.setTimeout(() => document.querySelector(`.timeline-moment[data-event-id="${CSS.escape(eventId)}"]`)?.focus({ preventScroll: true }), 0);
    return true;
  }

  function returnFromExplorer() {
    explorerView.hidden = true;
    timelineExploration.hidden = false;
    window.setTimeout(() => explorerEntry.focus({ preventScroll: true }), 0);
  }

  const timelineApi = initTimeline({ events, eras, onOpenGraph: openGraph });
  let graphData = null;
  try {
    graphData = await loadGraphData();
  } catch (error) {
    console.error('AEON graph data could not initialize:', error);
  }
  graphApi = initGraph({
    container: graphView,
    graphData,
    onSelectNode: (id) => timelineApi.selectById(id, { scrollIntoView: false }),
    onReturn: returnFromGraph,
    onRetry: async () => ({ graphData: await loadGraphData(), rootId: pendingRootId }),
  });
  let datasetVersion = null;
  if (canonicalRelationships.length) {
    try { datasetVersion = await getDatasetVersion({ events, eras, relationships: canonicalRelationships }); }
    catch (error) { console.error('AEON dataset version could not be computed; AI explanations are unavailable.', error); }
  }
  explorerApi = initExplorer({
    container: explorerView,
    openButton: explorerEntry,
    events,
    eras,
    graphData: graphData ?? { nodes: [], edges: [] },
    datasetVersion,
    onOpen: () => { timelineExploration.hidden = true; graphView.hidden = true; },
    onOpenTimeline: openTimelineEvent,
    onOpenGraph: (eventId) => openGraph(eventId, 'explorer'),
    onReturn: returnFromExplorer,
  });
  beginButton.addEventListener('click', () => showTimeline(landing, timeline));
  returnButton.addEventListener('click', () => showLanding(landing, timeline));
  return timelineApi;
}

initializeApplication().catch((error) => {
  console.error('AEON could not initialize:', error);
  const beginButton = document.getElementById('begin-journey');
  const errorMessage = document.getElementById('app-error');
  if (errorMessage) {
    errorMessage.textContent = `The historical timeline is unavailable. ${error.message}`;
    errorMessage.hidden = false;
  }
  if (beginButton) {
    beginButton.disabled = true;
    beginButton.setAttribute('aria-label', 'Journey unavailable because timeline data failed to load');
  }
});
