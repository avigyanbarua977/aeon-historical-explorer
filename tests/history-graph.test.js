import { initGraph } from '../js/graph.js';
import { calculateRadialLayout, createGraphIndex, createSyntheticGraphData, selectNeighborhood } from '../js/graph-layout.js';
import { createRelationshipEngine } from '../js/relationship-engine.js';

const results = document.querySelector('#test-results');
const summary = document.querySelector('#test-summary');
let passed = 0;
let failed = 0;

function check(name, callback) {
  const row = document.createElement('li');
  try {
    callback();
    row.textContent = 'PASS — ' + name;
    row.dataset.status = 'pass';
    passed += 1;
  } catch (error) {
    row.textContent = 'FAIL — ' + name + ': ' + error.message;
    row.dataset.status = 'fail';
    failed += 1;
  }
  results.append(row);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function node(id, year) {
  return { id, type: 'event', title: 'Event ' + id, year, displayYear: year + ' CE', era: 'test' };
}

function edge(id, source, target, type, provenance) {
  return {
    id,
    source: { type: 'event', id: source },
    target: { type: 'event', id: target },
    type: type || 'CAUSES',
    provenance: Object.assign({ eventId: source, field: 'test' }, provenance || {}),
  };
}

const fixture = {
  nodes: [node('a', 100), node('b', 200), node('c', 50), node('d', 150), node('e', 300), node('island', 400)],
  edges: [
    edge('ab', 'a', 'b'),
    edge('ca', 'c', 'a'),
    edge('be', 'b', 'e'),
    edge('ad-1', 'a', 'd', 'RELATED_TO', { eventId: 'a', field: 'relatedEvents' }),
    edge('ad-2', 'd', 'a', 'RELATED_TO', { eventId: 'd', field: 'relatedEvents' }),
  ],
};
const index = createGraphIndex(fixture);

check('single-node graph', () => {
  const single = createGraphIndex({ nodes: [node('solo', 1)], edges: [] });
  const result = selectNeighborhood(single, 'solo');
  assert(result.nodes.size === 1 && result.edges.length === 0, 'single root did not render alone');
});
check('disconnected events stay outside the local neighborhood', () => {
  assert(!selectNeighborhood(index, 'a').nodes.has('island'), 'disconnected node leaked into neighborhood');
});
check('causal areas and date-ordered radial placement', () => {
  const result = selectNeighborhood(index, 'a');
  const layout = calculateRadialLayout(result);
  assert(result.nodes.get('c').branch === 'precursors', 'incoming cause not a precursor');
  assert(result.nodes.get('b').branch === 'outcomes', 'outgoing cause not an outcome');
  assert(layout.positions.get('c').x < layout.positions.get('a').x, 'precursor not placed left');
  assert(layout.positions.get('b').x > layout.positions.get('a').x, 'outcome not placed right');
  assert(layout.positions.get('d').y < layout.positions.get('a').y, 'context not placed in its own arc');
});
check('duplicate and reciprocal relationship provenance is grouped, not removed', () => {
  const contextual = selectNeighborhood(index, 'a').edges.find((item) => item.type === 'RELATED_TO');
  assert(contextual.count === 2 && contextual.records.length === 2, 'duplicate records or provenance missing');
});
check('cycles do not create duplicate nodes', () => {
  const cycle = createGraphIndex({ nodes: [node('x', 1), node('y', 2), node('z', 3)], edges: [edge('xy', 'x', 'y'), edge('yz', 'y', 'z'), edge('zx', 'z', 'x')] });
  assert(selectNeighborhood(cycle, 'x', { depth: 3 }).nodes.size === 3, 'cycle duplicated graph nodes');
});
check('expand and collapse controls deeper branches', () => {
  assert(!selectNeighborhood(index, 'a').nodes.has('e'), 'deeper node should start hidden');
  assert(selectNeighborhood(index, 'a', { expandedNodes: new Set(['a', 'b']) }).nodes.has('e'), 'expanded branch did not reveal child');
  assert(!selectNeighborhood(index, 'a', { expandedNodes: new Set(['a']) }).nodes.has('e'), 'collapsed branch retained child');
});
check('depth limits neighborhood expansion', () => {
  assert(!selectNeighborhood(index, 'a', { depth: 1 }).nodes.has('e'), 'nearby depth expanded too far');
  assert(selectNeighborhood(index, 'a', { depth: 2 }).nodes.has('e'), 'wider depth did not reveal child');
});
check('node cap reports when a neighborhood is truncated', () => {
  const result = selectNeighborhood(index, 'a', { depth: 3, expandedNodes: new Set(['a', 'b', 'c', 'd', 'e']), nodeCap: 3 });
  assert(result.nodes.size === 3 && result.limited, 'node cap was not enforced');
});
check('radial layout is deterministic', () => {
  const first = calculateRadialLayout(selectNeighborhood(index, 'a'));
  const second = calculateRadialLayout(selectNeighborhood(index, 'a'));
  assert(JSON.stringify([...first.positions]) === JSON.stringify([...second.positions]), 'layout changed between identical calls');
});

let syntheticMilliseconds = 0;
check('synthetic large graph remains bounded', () => {
  const synthetic = createSyntheticGraphData(1800, 3);
  const start = performance.now();
  const largeIndex = createGraphIndex(synthetic);
  const expanded = new Set(synthetic.nodes.map((item) => item.id));
  const result = selectNeighborhood(largeIndex, 'synthetic-0', { depth: 3, expandedNodes: expanded, nodeCap: 100 });
  syntheticMilliseconds = performance.now() - start;
  assert(synthetic.nodes.length === 1800 && synthetic.edges.length > 5000, 'synthetic dataset is too small');
  assert(result.nodes.size === 100 && result.limited, 'large graph did not reach cap');
});

try {
  const [events, relationships] = await Promise.all([
    fetch('../data/events.json').then((response) => response.json()),
    fetch('../data/relationships.json').then((response) => response.json()),
  ]);
  const canonicalData = createRelationshipEngine({ events, relationships }).getGraphData();
  const canonical = createGraphIndex(canonicalData);
  check('canonical dataset indexes 80 events but shows a local neighborhood', () => {
    const result = selectNeighborhood(canonical, 'agriculture');
    assert(canonical.nodes.size === 80, 'canonical event count mismatch');
    assert(result.nodes.size < canonical.nodes.size, 'default graph rendered the whole dataset');
  });
} catch (error) {
  check('canonical graph data loads', () => { throw error; });
}

const selectedNodes = [];
let returnedId = null;
const graphApi = initGraph({
  container: document.querySelector('#history-graph-view'),
  graphData: fixture,
  onSelectNode: (id) => selectedNodes.push(id),
  onReturn: (id) => { returnedId = id; },
});
graphApi.setRoot('a');
check('integration selects the requested root and renders its local nodes', () => {
  assert(graphApi.getRoot() === 'a', 'wrong root selected');
  assert(document.querySelectorAll('#graph-nodes [data-node-id]').length === 4, 'local nodes did not render');
});
check('selecting a node updates the event-detail callback', () => {
  document.querySelector('#graph-nodes [data-node-id="b"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert(graphApi.getSelected() === 'b' && selectedNodes.at(-1) === 'b', 'node selection did not propagate');
});
check('integration expands and collapses a branch', () => {
  document.querySelector('#graph-expand').click();
  assert(graphApi.getVisibleGraph().nodes.has('e'), 'expand did not reveal a node');
  document.querySelector('#graph-expand').click();
  assert(!graphApi.getVisibleGraph().nodes.has('e'), 'collapse did not hide a node');
});
check('integration changes graph root', () => {
  document.querySelector('#graph-set-root').click();
  assert(graphApi.getRoot() === 'b', 'root action did not change root');
});
check('integration filters relationship types and adjusts depth', () => {
  graphApi.setRoot('a');
  const causes = document.querySelector('input[value="CAUSES"]');
  causes.checked = false;
  causes.dispatchEvent(new Event('change', { bubbles: true }));
  assert(graphApi.getVisibleGraph().edges.every((item) => item.type !== 'CAUSES'), 'cause filter failed');
  causes.checked = true;
  causes.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#graph-depth').value = '2';
  document.querySelector('#graph-depth').dispatchEvent(new Event('change', { bubbles: true }));
  assert(graphApi.getVisibleGraph().nodes.has('e'), 'depth control failed');
});
check('zoom and reset change only the SVG transform and restore auto-fit', () => {
  const count = document.querySelectorAll('#graph-nodes [data-node-id]').length;
  const world = document.querySelector('#graph-world');
  const original = world.getAttribute('transform');
  document.querySelector('#graph-zoom-in').click();
  const zoomed = world.getAttribute('transform');
  document.querySelector('#graph-zoom-reset').click();
  assert(original !== zoomed && world.getAttribute('transform') === original, 'zoom/reset failed to restore auto-fit');
  assert(document.querySelectorAll('#graph-nodes [data-node-id]').length === count, 'zoom rebuilt nodes');
});
check('desktop pointer pan changes the world transform without rebuilding nodes', () => {
  const svg = document.querySelector('#history-graph-svg');
  const world = document.querySelector('#graph-world');
  const before = world.getAttribute('transform');
  const count = document.querySelectorAll('#graph-nodes [data-node-id]').length;
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, pointerType: 'mouse', clientX: 120, clientY: 120 }));
  svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 41, pointerType: 'mouse', clientX: 160, clientY: 145 }));
  svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 41, pointerType: 'mouse', clientX: 160, clientY: 145 }));
  assert(world.getAttribute('transform') !== before, 'pan did not move the SVG world');
  assert(document.querySelectorAll('#graph-nodes [data-node-id]').length === count, 'pan rebuilt nodes');
  document.querySelector('#graph-zoom-reset').click();
});
check('touch pinch updates scale while the mobile list remains zoomable by controls', () => {
  const svg = document.querySelector('#history-graph-svg');
  const world = document.querySelector('#graph-world');
  const initialScale = Number(world.getAttribute('transform').match(/scale\(([^)]+)\)/)?.[1]);
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: 100, clientY: 100 }));
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 52, pointerType: 'touch', clientX: 180, clientY: 100 }));
  svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 52, pointerType: 'touch', clientX: 220, clientY: 100 }));
  svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: 100, clientY: 100 }));
  svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 52, pointerType: 'touch', clientX: 220, clientY: 100 }));
  const nextScale = Number(world.getAttribute('transform').match(/scale\(([^)]+)\)/)?.[1]);
  assert(nextScale > initialScale, 'pinch did not zoom the SVG');
  document.querySelector('#graph-zoom-reset').click();
});
check('keyboard arrows move focus and selection between graph nodes', () => {
  const root = document.querySelector('#graph-nodes [data-node-id="a"]');
  root.focus();
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert(graphApi.getSelected() === 'b', 'arrow navigation did not select right-side outcome');
  assert(document.activeElement.dataset.nodeId === 'b', 'arrow navigation did not move focus');
});
check('relationship edge activation reveals multiplicity and provenance', () => {
  const related = document.querySelector('#graph-edges [data-edge-id^="RELATED_TO"]');
  related.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const information = document.querySelector('#graph-edge-info');
  assert(!information.hidden && information.textContent.includes('2 source records'), 'duplicate count not exposed');
  assert(information.textContent.includes('relatedEvents'), 'source provenance not exposed');
});
check('SVG graph nodes and edges are keyboard-accessible controls', () => {
  const graphNode = document.querySelector('#graph-nodes [data-node-id]');
  const graphEdge = document.querySelector('#graph-edges [data-edge-id]');
  assert(graphNode.getAttribute('role') === 'button' && graphNode.getAttribute('aria-label'), 'node semantics missing');
  assert(graphEdge.getAttribute('role') === 'button' && graphEdge.getAttribute('aria-label'), 'edge semantics missing');
});
check('return callback preserves the selected node', () => {
  document.querySelector('#graph-return-timeline').click();
  assert(returnedId === graphApi.getSelected(), 'selected context was not returned');
});
check('single-node auto-fit keeps the root scale restrained', () => {
  graphApi.setGraphData({ nodes: [node('solo', 1)], edges: [] });
  const scale = Number(document.querySelector('#graph-world').getAttribute('transform').match(/scale\(([^)]+)\)/)?.[1]);
  assert(scale > 0 && scale <= 0.95, `single-node scale was ${scale}`);
});
check('three-node labels remain separated', () => {
  const nodes = [node('root-3', 3), node('left-3', 1), node('right-3', 5)];
  const edges = [edge('left-link', 'left-3', 'root-3'), edge('right-link', 'root-3', 'right-3')];
  graphApi.setGraphData({ nodes, edges });
  const labels = [...document.querySelectorAll('#graph-nodes .graph-node-caption')].map((caption) => caption.getBoundingClientRect());
  assert(labels.length === 3, 'three-node graph did not render all labels');
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      const a = labels[left];
      const b = labels[right];
      assert(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'three-node captions overlap');
    }
  }
});
check('five-node labels remain separated', () => {
  const nodes = Array.from({ length: 5 }, (_, index) => node(`root-5-${index}`, index));
  const edges = nodes.slice(1).map((item, index) => edge(`root-5-link-${index}`, nodes[0].id, item.id, 'RELATED_TO'));
  graphApi.setGraphData({ nodes, edges });
  const labels = [...document.querySelectorAll('#graph-nodes .graph-node-caption')].map((caption) => caption.getBoundingClientRect());
  assert(labels.length === 5, 'five-node graph did not render all labels');
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      const a = labels[left];
      const b = labels[right];
      assert(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'five-node captions overlap');
    }
  }
});
check('seven-node labels are placed without collisions', () => {
  const nodes = [
    { ...node('mongol', 1206), title: 'The Mongol Empire' },
    { ...node('silk-road', -130), title: 'Eurasian Trade Routes' },
    { ...node('han', -206), title: 'Han Dynasty' },
    { ...node('rome', -27), title: 'Roman Empire' },
    { ...node('steppe', 750), title: 'Steppe Confederations' },
    { ...node('trade', 1250), title: 'Eurasian Trade Networks' },
    { ...node('plague', 1347), title: 'The Black Death' },
  ];
  const edges = nodes.slice(1).map((item) => edge(`mongol-${item.id}`, 'mongol', item.id, 'RELATED_TO'));
  graphApi.setGraphData({ nodes, edges });
  const captions = [...document.querySelectorAll('#graph-nodes .graph-node-caption')].map((caption) => caption.getBoundingClientRect());
  for (let left = 0; left < captions.length; left += 1) {
    for (let right = left + 1; right < captions.length; right += 1) {
      const a = captions[left];
      const b = captions[right];
      assert(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'two event captions overlap');
    }
  }
});

summary.textContent = passed + ' passed · ' + failed + ' failed · synthetic 1,800 nodes / ' + syntheticMilliseconds.toFixed(1) + ' ms';
summary.dataset.status = failed ? 'fail' : 'pass';
