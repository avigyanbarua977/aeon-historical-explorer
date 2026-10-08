import { calculateRadialLayout, createGraphIndex, selectNeighborhood } from './graph-layout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1200;
const HEIGHT = 760;
const DEFAULT_RELATIONSHIPS = ['CAUSES', 'RELATED_TO'];
const FIT_COVERAGE = 0.68;
const FIT_PADDING = 44;

function element(container, selector) {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`History graph element not found: ${selector}`);
  return found;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function safeLabel(value, maximum = 19) {
  const text = String(value ?? 'Untitled event');
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function linesForLabel(label) {
  const words = String(label).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 16 && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > 2) return [lines[0], safeLabel(lines.slice(1).join(' '), 16)];
  return lines;
}

function labelMetrics(node, isRoot) {
  const lines = linesForLabel(node.title);
  const fontSize = isRoot ? 16 : 14;
  const lineAdvance = isRoot ? 20 : 18;
  const year = node.displayYear ?? String(node.year ?? '');
  const width = Math.max(
    ...lines.map((line) => line.length * fontSize * 0.82),
    year.length * 5.6,
    36,
  ) + 28;
  return { lines, lineAdvance, width, height: lines.length * lineAdvance + 40 };
}

function overlaps(left, right, gap = 24) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function placeNodeLabels(neighborhood, positions) {
  const placements = new Map();
  const entries = [...neighborhood.nodes.values()].sort((left, right) => {
    if (left.node.id === neighborhood.rootId) return -1;
    if (right.node.id === neighborhood.rootId) return 1;
    return left.depth - right.depth || left.node.id.localeCompare(right.node.id);
  });
  const nodeBounds = entries.map(({ node }) => {
    const point = positions.get(node.id);
    const radius = node.id === neighborhood.rootId ? 37 : 29;
    return { id: node.id, x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
  });
  const placedLabels = [];

  for (const entry of entries) {
    const { node } = entry;
    const isRoot = node.id === neighborhood.rootId;
    const point = positions.get(node.id);
    const radius = isRoot ? 31 : 23;
    const metrics = labelMetrics(node, isRoot);
    const alternatives = isRoot
      ? ['below']
      : ['below', 'above', point.x < WIDTH / 2 ? 'right' : 'left', point.x < WIDTH / 2 ? 'left' : 'right'];
    const candidates = alternatives.map((side) => {
      let x = point.x - metrics.width / 2;
      let y = point.y + radius + 8;
      if (side === 'above') y = point.y - radius - 8 - metrics.height;
      if (side === 'left') x = point.x - radius - 10 - metrics.width;
      if (side === 'right') x = point.x + radius + 10;
      if (side === 'left' || side === 'right') y = point.y - metrics.height / 2;
      const box = { side, x, y, width: metrics.width, height: metrics.height };
      const captionCollisions = placedLabels.filter((label) => overlaps(box, label)).length;
      const nodeCollisions = nodeBounds.filter((bounds) => bounds.id !== node.id && overlaps(box, bounds, 5)).length;
      return { ...box, score: captionCollisions * 2 + nodeCollisions };
    });
    candidates.sort((left, right) => left.score - right.score || alternatives.indexOf(left.side) - alternatives.indexOf(right.side));
    const chosen = candidates[0];
    placements.set(node.id, { side: chosen.side });
    placedLabels.push(chosen);
  }

  return placements;
}

function endpointId(endpoint) {
  return endpoint?.id;
}

function edgeDescription(edge, index) {
  const source = index.nodes.get(edge.source.id);
  const target = index.nodes.get(edge.target.id);
  const direction = edge.type === 'CAUSES' ? `${source?.title} contributes to ${target?.title}` : `${source?.title} is contextually related to ${target?.title}`;
  const count = edge.count > 1 ? `${edge.count} source records` : '1 source record';
  return `${edge.type}: ${direction}. ${count}. Activate to inspect provenance.`;
}

export function initGraph({ container, graphData, onSelectNode, onReturn, onRetry } = {}) {
  if (!container) throw new TypeError('A graph view container is required.');
  const heading = element(container, '#history-graph-heading');
  const svg = element(container, '#history-graph-svg');
  const svgStage = element(container, '#graph-svg-stage');
  const world = element(container, '#graph-world');
  const edgeLayer = element(container, '#graph-edges');
  const nodeLayer = element(container, '#graph-nodes');
  const mobileList = element(container, '#graph-mobile-list');
  const errorMessage = element(container, '#graph-error');
  const retryButton = element(container, '#graph-retry');
  const status = element(container, '#graph-status');
  const rootLabel = element(container, '#graph-root-label');
  const edgeInfo = element(container, '#graph-edge-info');
  const nodeActions = element(container, '#graph-node-actions');
  const expandButton = element(container, '#graph-expand');
  const rootButton = element(container, '#graph-set-root');
  const relationshipControls = [...container.querySelectorAll('[data-relationship-filter]')];
  const depthControl = element(container, '#graph-depth');
  const zoomIn = element(container, '#graph-zoom-in');
  const zoomOut = element(container, '#graph-zoom-out');
  const zoomReset = element(container, '#graph-zoom-reset');
  const returnButton = element(container, '#graph-return-timeline');
  const announcement = element(container, '#graph-announcement');

  let index = null;
  let rootId = null;
  let selectedId = null;
  let depth = Number(depthControl.value) || 1;
  let relationshipTypes = new Set(DEFAULT_RELATIONSHIPS);
  let expandedNodes = new Set();
  let neighborhood = null;
  let positions = new Map();
  let labelPlacements = new Map();
  let transform = { x: 0, y: 0, scale: 1 };
  let fittedTransform = { ...transform };
  let mobileScale = 1;
  let userAdjustedView = false;
  let activePointers = new Map();
  let gesture = null;

  function updateTransform() {
    world.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
    mobileList.style.setProperty('--graph-mobile-scale', mobileScale);
    const scaleLabel = `${Math.round(transform.scale * 100)}%`;
    zoomReset.setAttribute('aria-label', `Reset graph view, current zoom ${scaleLabel}`);
  }

  function setStatus(message) {
    status.textContent = message;
    announcement.textContent = message;
  }

  function describeProvenance(edge) {
    const sourceRecords = edge.records.map((record) => {
      const provenance = record.provenance;
      const sourceNode = index.nodes.get(provenance?.eventId);
      const sourceName = sourceNode?.title ?? provenance?.eventId ?? 'Unknown source';
      return `${record.id}: ${sourceName} (${provenance?.field ?? 'relationship'})`;
    });
    edgeInfo.hidden = false;
    edgeInfo.textContent = `${edge.type}${edge.count > 1 ? ` · ${edge.count} source records` : ''}. ${sourceRecords.join('; ')}`;
  }

  function edgePath(edge) {
    const source = positions.get(edge.source.id);
    const target = positions.get(edge.target.id);
    const sourceRadius = edge.source.id === rootId ? 34 : 25;
    const targetRadius = edge.target.id === rootId ? 34 : 25;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const sx = source.x + ux * sourceRadius;
    const sy = source.y + uy * sourceRadius;
    const tx = target.x - ux * targetRadius;
    const ty = target.y - uy * targetRadius;
    const offset = edge.type === 'RELATED_TO' ? 14 : -12;
    const cx = (sx + tx) / 2 - uy * offset;
    const cy = (sy + ty) / 2 + ux * offset;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
  }

  function renderEdges() {
    edgeLayer.replaceChildren();
    for (const edge of neighborhood.edges) {
      const group = svgElement('g', {
        class: `graph-edge graph-edge--${edge.type.toLowerCase()}`,
        role: 'button',
        tabindex: '0',
        'aria-label': edgeDescription(edge, index),
        'data-edge-id': edge.id,
      });
      const title = svgElement('title');
      title.textContent = edgeDescription(edge, index);
      const path = svgElement('path', {
        class: 'graph-edge-hitarea',
        d: edgePath(edge),
      });
      const visiblePath = svgElement('path', {
        class: 'graph-edge-line',
        d: edgePath(edge),
        ...(edge.type === 'CAUSES' ? { 'marker-end': 'url(#graph-cause-arrow)' } : {}),
      });
      group.append(title, path, visiblePath);
      if (edge.count > 1) {
        const source = positions.get(edge.source.id);
        const target = positions.get(edge.target.id);
        const badge = svgElement('text', {
          class: 'graph-edge-count',
          x: (source.x + target.x) / 2,
          y: (source.y + target.y) / 2 - 8,
          'text-anchor': 'middle',
        });
        badge.textContent = `×${edge.count}`;
        group.append(badge);
      }
      edgeLayer.append(group);
    }
  }

  function renderNode(entry) {
    const node = entry.node;
    const point = positions.get(node.id);
    const isRoot = node.id === rootId;
    const isSelected = node.id === selectedId;
    const group = svgElement('g', {
      class: `graph-node graph-node--${entry.branch}${isRoot ? ' is-root' : ''}${isSelected ? ' is-selected' : ''}`,
      role: 'button',
      tabindex: isSelected ? '0' : '-1',
      'aria-pressed': String(isSelected),
      'aria-label': `${node.title}, ${node.displayYear ?? node.year ?? 'date unknown'}${isRoot ? ', graph root' : ''}. Select to view event details.`,
      'data-node-id': node.id,
      transform: `translate(${point.x} ${point.y})`,
    });
    const title = svgElement('title');
    title.textContent = `${node.title} · ${node.displayYear ?? node.year ?? 'Date unknown'}`;
    const circle = svgElement('circle', { class: 'graph-node-core', r: isRoot ? 31 : 23 });
    const placement = labelPlacements.get(node.id)?.side ?? 'below';
    const metrics = labelMetrics(node, isRoot);
    const labelLines = metrics.lines;
    const lineAdvance = metrics.lineAdvance;
    const textX = placement === 'left' ? -(isRoot ? 41 : 33) : placement === 'right' ? (isRoot ? 41 : 33) : 0;
    const textAnchor = placement === 'left' ? 'end' : placement === 'right' ? 'start' : 'middle';
    let titleBaseline = isRoot ? 48 : 40;
    let yearBaseline = Math.max(isRoot ? 78 : 69, titleBaseline + (labelLines.length - 1) * lineAdvance + 21);
    if (placement === 'above') {
      titleBaseline = -(isRoot ? 41 : 33) - (labelLines.length - 1) * lineAdvance;
      yearBaseline = titleBaseline - 16;
    } else if (placement === 'left' || placement === 'right') {
      titleBaseline = -((labelLines.length - 1) * lineAdvance) / 2;
      yearBaseline = titleBaseline + (labelLines.length - 1) * lineAdvance + 19;
    }
    const text = svgElement('text', { class: 'graph-node-label', 'text-anchor': textAnchor, y: titleBaseline });
    labelLines.forEach((line, lineIndex) => {
      const span = svgElement('tspan', { x: textX, dy: lineIndex === 0 ? 0 : lineAdvance });
      span.textContent = line;
      text.append(span);
    });
    const year = svgElement('text', { class: 'graph-node-year', 'text-anchor': textAnchor, y: yearBaseline, x: textX });
    year.textContent = node.displayYear ?? String(node.year ?? '');
    const caption = svgElement('g', { class: `graph-node-caption graph-node-caption--${placement}` });
    caption.append(text, year);
    group.append(title, circle, caption);
    return group;
  }

  function renderNodes() {
    nodeLayer.replaceChildren();
    for (const entry of neighborhood.nodes.values()) nodeLayer.append(renderNode(entry));
  }

  function fitGraphToContent({ force = false } = {}) {
    if (!neighborhood?.nodes.size) return;
    const bounds = world.getBBox();
    if (!bounds.width || !bounds.height) return;
    const paddedWidth = bounds.width + FIT_PADDING * 2;
    const paddedHeight = bounds.height + FIT_PADDING * 2;
    const maximumScale = neighborhood.nodes.size === 1 ? 0.95 : neighborhood.nodes.size <= 2 ? 1.25 : 1.85;
    const scale = Math.min(
      maximumScale,
      WIDTH * FIT_COVERAGE / paddedWidth,
      HEIGHT * FIT_COVERAGE / paddedHeight,
    );
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    fittedTransform = {
      x: WIDTH / 2 - centerX * scale,
      y: HEIGHT / 2 - centerY * scale,
      scale,
    };
    if (force || !userAdjustedView) {
      transform = { ...fittedTransform };
      userAdjustedView = false;
      updateTransform();
    }
  }

  function updateSelectedNode() {
    for (const node of nodeLayer.querySelectorAll('[data-node-id]')) {
      const selected = node.dataset.nodeId === selectedId;
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
      node.setAttribute('tabindex', selected ? '0' : '-1');
    }
    const selectedEntry = neighborhood?.nodes.get(selectedId);
    if (!selectedEntry) {
      nodeActions.hidden = true;
      return;
    }
    nodeActions.hidden = false;
    const expanded = expandedNodes.has(selectedId);
    expandButton.textContent = expanded ? 'Collapse branch' : 'Expand connections';
    expandButton.setAttribute('aria-expanded', String(expanded));
    rootButton.disabled = selectedId === rootId;
  }

  function renderMobileList() {
    mobileList.replaceChildren();
    const groups = [
      ['precursors', 'Causal precursors'],
      ['outcomes', 'Causal outcomes'],
      ['context', 'Contextual connections'],
    ];
    for (const [key, label] of groups) {
      const members = [...neighborhood.nodes.values()]
        .filter((entry) => entry.branch === key)
        .sort((left, right) => (left.node.year ?? 0) - (right.node.year ?? 0) || left.node.id.localeCompare(right.node.id));
      if (!members.length) continue;
      const section = document.createElement('section');
      section.className = `graph-mobile-group graph-mobile-group--${key}`;
      const headingText = document.createElement('h3');
      headingText.textContent = label;
      section.append(headingText);
      const list = document.createElement('ol');
      for (const entry of members) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'graph-mobile-node';
        button.dataset.nodeId = entry.node.id;
        button.setAttribute('aria-pressed', String(entry.node.id === selectedId));
        const title = document.createElement('span');
        title.className = 'graph-mobile-node-title';
        title.textContent = entry.node.title;
        const year = document.createElement('span');
        year.className = 'graph-mobile-node-year';
        year.textContent = entry.node.displayYear ?? String(entry.node.year ?? 'Date unknown');
        button.append(title, year);
        button.addEventListener('click', () => selectNode(entry.node.id));
        item.append(button);
        list.append(item);
      }
      section.append(list);
      mobileList.append(section);
    }

    if (neighborhood.edges.length) {
      const connections = document.createElement('section');
      connections.className = 'graph-mobile-connections';
      const headingText = document.createElement('h3');
      headingText.textContent = 'Connection records';
      connections.append(headingText);
      const list = document.createElement('ol');
      for (const edge of neighborhood.edges) {
        const item = document.createElement('li');
        const disclosure = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = edgeDescription(edge, index);
        const provenance = document.createElement('ul');
        for (const record of edge.records) {
          const sourceNode = index.nodes.get(record.provenance?.eventId);
          const entry = document.createElement('li');
          entry.textContent = `${record.id} · ${sourceNode?.title ?? record.provenance?.eventId ?? 'Unknown source'} (${record.provenance?.field ?? 'relationship'})`;
          provenance.append(entry);
        }
        disclosure.append(summary, provenance);
        item.append(disclosure);
        list.append(item);
      }
      connections.append(list);
      mobileList.append(connections);
    }
  }

  function rebuild() {
    if (!index || !rootId) return;
    try {
      neighborhood = selectNeighborhood(index, rootId, {
        depth,
        expandedNodes,
        relationshipTypes,
        nodeCap: 100,
      });
      positions = calculateRadialLayout(neighborhood, { width: WIDTH, height: HEIGHT }).positions;
      labelPlacements = placeNodeLabels(neighborhood, positions);
      rootLabel.textContent = index.nodes.get(rootId).title;
      svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
      renderEdges();
      renderNodes();
      fitGraphToContent({ force: true });
      renderMobileList();
      updateSelectedNode();
      edgeInfo.hidden = true;
      const capMessage = neighborhood.limited ? ' · 100-node limit reached. Narrow filters or collapse branches to explore more.' : '';
      setStatus(`${neighborhood.nodes.size} events · ${neighborhood.edges.length} connections${capMessage}`);
    } catch (error) {
      showError(`The history graph could not be rendered. ${error.message}`);
    }
  }

  function showError(message) {
    errorMessage.hidden = false;
    errorMessage.querySelector('[data-graph-error-message]').textContent = message;
    retryButton.hidden = typeof onRetry !== 'function';
    svgStage.hidden = true;
    mobileList.hidden = true;
    nodeActions.hidden = true;
    setStatus('Connections are unavailable. The timeline remains available.');
  }

  function setGraphData(data) {
    try {
      index = createGraphIndex(data);
      errorMessage.hidden = true;
      svgStage.hidden = false;
      mobileList.hidden = false;
      if (!rootId || !index.nodes.has(rootId)) rootId = index.nodes.keys().next().value ?? null;
      if (!rootId) {
        showError('No valid event connections are available. Return to the timeline and choose another event.');
        return false;
      }
      expandedNodes = new Set([rootId]);
      if (!selectedId || !index.nodes.has(selectedId)) selectedId = rootId;
      rebuild();
      return true;
    } catch (error) {
      showError(`Connection data could not be prepared. ${error.message}`);
      return false;
    }
  }

  function selectNode(id, { focus = false } = {}) {
    if (!neighborhood?.nodes.has(id)) return false;
    selectedId = id;
    onSelectNode?.(id);
    updateSelectedNode();
    renderMobileList();
    if (focus) nodeLayer.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
    setStatus(`${index.nodes.get(id).title} selected · ${neighborhood.nodes.size} events visible`);
    return true;
  }

  function setRoot(id) {
    if (!index?.nodes.has(id)) return false;
    rootId = id;
    selectedId = id;
    expandedNodes = new Set([id]);
    mobileScale = 1;
    userAdjustedView = false;
    onSelectNode?.(id);
    rebuild();
    return true;
  }

  function toggleExpansion() {
    if (!selectedId) return;
    if (expandedNodes.has(selectedId)) expandedNodes.delete(selectedId);
    else expandedNodes.add(selectedId);
    rebuild();
    updateSelectedNode();
    setStatus(`${index.nodes.get(selectedId).title} ${expandedNodes.has(selectedId) ? 'expanded' : 'collapsed'}`);
  }

  function changeZoom(factor, center = { x: WIDTH / 2, y: HEIGHT / 2 }) {
    if (window.matchMedia('(max-width: 700px)').matches) {
      mobileScale = Math.min(1.5, Math.max(0.8, mobileScale * factor));
      updateTransform();
      return;
    }
    const nextScale = Math.min(2.5, Math.max(0.55, transform.scale * factor));
    const ratio = nextScale / transform.scale;
    transform.x = center.x - (center.x - transform.x) * ratio;
    transform.y = center.y - (center.y - transform.y) * ratio;
    transform.scale = nextScale;
    userAdjustedView = true;
    updateTransform();
  }

  function focusDirectionalNode(currentId, key) {
    const current = positions.get(currentId);
    const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
    if (!direction) return;
    const candidates = [...neighborhood.nodes.keys()].filter((id) => id !== currentId).map((id) => {
      const point = positions.get(id);
      const dx = point.x - current.x;
      const dy = point.y - current.y;
      const projection = dx * direction[0] + dy * direction[1];
      return { id, projection, distance: Math.hypot(dx, dy) };
    }).filter((item) => item.projection > 0)
      .sort((left, right) => {
        const leftAlignment = left.distance / left.projection;
        const rightAlignment = right.distance / right.projection;
        const alignmentDifference = leftAlignment - rightAlignment;
        return Math.abs(alignmentDifference) > 1e-6 ? alignmentDifference : left.distance - right.distance;
      });
    const nextId = candidates[0]?.id;
    if (nextId) {
      selectNode(nextId);
      nodeLayer.querySelector(`[data-node-id="${CSS.escape(nextId)}"]`)?.focus();
    }
  }

  function onNodeKeydown(event) {
    const node = event.target.closest?.('[data-node-id]');
    if (!node) return;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      focusDirectionalNode(node.dataset.nodeId, event.key);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectNode(rootId);
      nodeLayer.querySelector(`[data-node-id="${CSS.escape(rootId)}"]`)?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(node.dataset.nodeId);
    }
  }

  function onEdgeActivate(event) {
    const group = event.target.closest?.('[data-edge-id]');
    if (!group) return;
    const edge = neighborhood.edges.find((item) => item.id === group.dataset.edgeId);
    if (edge) describeProvenance(edge);
  }

  function pointFromEvent(event) {
    const bounds = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * WIDTH,
      y: ((event.clientY - bounds.top) / bounds.height) * HEIGHT,
    };
  }

  function onPointerDown(event) {
    if (event.target.closest?.('[data-node-id], [data-edge-id]')) return;
    event.preventDefault();
    try { svg.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events have no capture target. */ }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      gesture = { type: 'pan', x: event.clientX, y: event.clientY, transformX: transform.x, transformY: transform.y };
    } else if (activePointers.size === 2) {
      const points = [...activePointers.values()];
      gesture = { type: 'pinch', distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), scale: transform.scale };
    }
  }

  function onPointerMove(event) {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture?.type === 'pan' && activePointers.size === 1) {
      const point = pointFromEvent(event);
      const origin = pointFromEvent({ clientX: gesture.x, clientY: gesture.y });
      transform.x = gesture.transformX + (point.x - origin.x);
      transform.y = gesture.transformY + (point.y - origin.y);
      userAdjustedView = true;
      updateTransform();
    } else if (gesture?.type === 'pinch' && activePointers.size === 2) {
      const points = [...activePointers.values()];
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      transform.scale = Math.min(2.5, Math.max(0.55, gesture.scale * distance / Math.max(1, gesture.distance)));
      userAdjustedView = true;
      updateTransform();
    }
  }

  function onPointerUp(event) {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) gesture = null;
    else if (activePointers.size === 1) {
      const [point] = activePointers.values();
      gesture = { type: 'pan', x: point.x, y: point.y, transformX: transform.x, transformY: transform.y };
    }
  }

  function onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 1.1 : 0.9, pointFromEvent(event));
  }

  function returnToTimeline() {
    onReturn?.(selectedId ?? rootId);
  }

  nodeLayer.addEventListener('click', (event) => {
    const node = event.target.closest?.('[data-node-id]');
    if (node) selectNode(node.dataset.nodeId);
  });
  nodeLayer.addEventListener('keydown', onNodeKeydown);
  edgeLayer.addEventListener('click', onEdgeActivate);
  edgeLayer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onEdgeActivate(event);
    }
  });
  expandButton.addEventListener('click', toggleExpansion);
  rootButton.addEventListener('click', () => setRoot(selectedId));
  depthControl.addEventListener('change', () => {
    depth = Number(depthControl.value) || 1;
    rebuild();
  });
  for (const checkbox of relationshipControls) {
    checkbox.addEventListener('change', () => {
      relationshipTypes = new Set(relationshipControls.filter((control) => control.checked).map((control) => control.value));
      rebuild();
    });
  }
  zoomIn.addEventListener('click', () => changeZoom(1.2));
  zoomOut.addEventListener('click', () => changeZoom(1 / 1.2));
  zoomReset.addEventListener('click', () => {
    mobileScale = 1;
    transform = { ...fittedTransform };
    userAdjustedView = false;
    updateTransform();
  });
  returnButton.addEventListener('click', returnToTimeline);
  retryButton.addEventListener('click', async () => {
    retryButton.disabled = true;
    try {
      const nextData = await onRetry?.();
      if (nextData?.graphData) {
        setGraphData(nextData.graphData);
        if (nextData.rootId) setRoot(nextData.rootId);
      } else if (nextData) setGraphData(nextData);
    } catch (error) {
      showError(`Connection data is still unavailable. ${error.message}`);
    } finally {
      retryButton.disabled = false;
    }
  });
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  const stageObserver = new ResizeObserver(() => fitGraphToContent());
  stageObserver.observe(svgStage);
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      returnToTimeline();
    }
    if (event.target === container && event.key === 'Home' && rootId) {
      selectNode(rootId);
      nodeLayer.querySelector(`[data-node-id="${CSS.escape(rootId)}"]`)?.focus();
    }
  });

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  svgStage.dataset.reducedMotion = String(motionPreference.matches);
  motionPreference.addEventListener?.('change', (event) => { svgStage.dataset.reducedMotion = String(event.matches); });
  updateTransform();

  const api = {
    setRoot,
    selectNode,
    setGraphData,
    getRoot: () => rootId,
    getSelected: () => selectedId,
    getVisibleGraph: () => neighborhood,
  };
  if (graphData) setGraphData(graphData);
  else showError('Relationship data could not be loaded. You can retry or return to the timeline.');
  heading.tabIndex = -1;
  return api;
}
