const EDGE_TYPES = new Set(['CAUSES', 'RELATED_TO']);
const DEFAULT_TYPES = ['CAUSES', 'RELATED_TO'];

function endpointId(endpoint) {
  return endpoint?.id;
}

function relationKey(edge) {
  const source = endpointId(edge.source);
  const target = endpointId(edge.target);
  const endpoints = edge.type === 'RELATED_TO' ? [source, target].sort() : [source, target];
  return `${edge.type}|${endpoints[0]}|${endpoints[1]}`;
}

function sortByDateThenId(left, right) {
  const yearDifference = (left.year ?? 0) - (right.year ?? 0);
  return yearDifference || left.id.localeCompare(right.id);
}

export function createGraphIndex(graphData) {
  if (!Array.isArray(graphData?.nodes) || !Array.isArray(graphData?.edges)) {
    throw new TypeError('Graph data must include node and edge arrays.');
  }

  const nodes = new Map();
  for (const node of graphData.nodes) {
    if (node?.type === 'event' && typeof node.id === 'string' && !nodes.has(node.id)) nodes.set(node.id, node);
  }

  const grouped = new Map();
  for (const record of graphData.edges) {
    if (!EDGE_TYPES.has(record?.type)) continue;
    const source = endpointId(record.source);
    const target = endpointId(record.target);
    if (!nodes.has(source) || !nodes.has(target) || source === target) continue;
    const key = relationKey(record);
    if (!grouped.has(key)) {
      const [canonicalSource, canonicalTarget] = record.type === 'RELATED_TO'
        ? [source, target].sort((left, right) => left.localeCompare(right))
        : [source, target];
      grouped.set(key, {
        id: key,
        type: record.type,
        source: { type: 'event', id: canonicalSource },
        target: { type: 'event', id: canonicalTarget },
        records: [],
      });
    }
    grouped.get(key).records.push(record);
  }

  const edges = [...grouped.values()].map((edge) => ({
    ...edge,
    records: [...edge.records].sort((left, right) => left.id.localeCompare(right.id)),
    count: edge.records.length,
  }));
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.source.id).push(edge);
    if (edge.target.id !== edge.source.id) adjacency.get(edge.target.id).push(edge);
  }
  for (const [id, incident] of adjacency) {
    incident.sort((left, right) => {
      const leftId = left.source.id === id ? left.target.id : left.source.id;
      const rightId = right.source.id === id ? right.target.id : right.source.id;
      return sortByDateThenId(nodes.get(leftId), nodes.get(rightId)) || left.type.localeCompare(right.type);
    });
  }
  return { nodes, edges, adjacency };
}

export function selectNeighborhood(index, rootId, {
  depth = 1,
  expandedNodes,
  relationshipTypes = new Set(DEFAULT_TYPES),
  nodeCap = 100,
} = {}) {
  if (!index.nodes.has(rootId)) throw new Error(`Graph root was not found: ${rootId}`);
  const maxDepth = Math.max(1, Math.floor(depth));
  const cap = Math.max(1, Math.floor(nodeCap));
  const expanded = expandedNodes ?? new Set([rootId]);
  const visibleNodes = new Map([[rootId, { node: index.nodes.get(rootId), depth: 0, branch: 'root', parentId: null }]]);
  const visibleEdges = new Map();
  const queue = [rootId];
  let limited = false;

  while (queue.length) {
    const currentId = queue.shift();
    const current = visibleNodes.get(currentId);
    const canExpand = currentId === rootId
      ? expanded.has(rootId)
      : current.depth < maxDepth || expanded.has(currentId);
    if (!canExpand) continue;
    for (const edge of index.adjacency.get(currentId) ?? []) {
      if (!relationshipTypes.has(edge.type)) continue;
      const nextId = edge.source.id === currentId ? edge.target.id : edge.source.id;
      if (!visibleNodes.has(nextId)) {
        if (visibleNodes.size >= cap) {
          limited = true;
          continue;
        }
        let branch = current.branch;
        if (currentId === rootId) {
          branch = edge.type === 'RELATED_TO' ? 'context'
            : edge.target.id === rootId ? 'precursors' : 'outcomes';
        }
        visibleNodes.set(nextId, {
          node: index.nodes.get(nextId),
          depth: current.depth + 1,
          branch,
          parentId: currentId,
        });
        queue.push(nextId);
      }
      visibleEdges.set(edge.id, edge);
    }
  }

  const edges = [...visibleEdges.values()].filter((edge) => visibleNodes.has(edge.source.id) && visibleNodes.has(edge.target.id));
  return { rootId, nodes: visibleNodes, edges, limited, nodeCap: cap, depth: maxDepth };
}

export function calculateRadialLayout(neighborhood, { width = 1200, height = 760 } = {}) {
  const center = { x: width / 2, y: height / 2 };
  const positions = new Map([[neighborhood.rootId, { ...center, depth: 0, branch: 'root' }]]);
  const branches = ['precursors', 'outcomes', 'context'];
  const centers = { precursors: Math.PI, outcomes: 0, context: -Math.PI / 2 };

  for (const branch of branches) {
    const members = [...neighborhood.nodes.values()]
      .filter((entry) => entry.node.id !== neighborhood.rootId && entry.branch === branch)
      .sort((left, right) => sortByDateThenId(left.node, right.node) || left.depth - right.depth);
    members.forEach((entry, index) => {
      const spread = Math.min(2.65, Math.max(0.7, members.length * 0.4));
      const fraction = members.length === 1 ? 0.5 : index / (members.length - 1);
      const angle = centers[branch] - spread / 2 + spread * fraction;
      const radius = Math.min(Math.min(width, height) * 0.45, 270 + (entry.depth - 1) * 125);
      positions.set(entry.node.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        depth: entry.depth,
        branch,
      });
    });
  }
  return { width, height, positions };
}

export function createSyntheticGraphData(nodeCount = 1200, linksPerNode = 2) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `synthetic-${index}`,
    type: 'event',
    title: `Synthetic milestone ${index}`,
    year: -2500000 + index * 2000,
    displayYear: `c. ${index}`,
    era: 'synthetic',
  }));
  const edges = [];
  for (let index = 0; index < nodeCount; index += 1) {
    for (let offset = 1; offset <= linksPerNode; offset += 1) {
      const targetIndex = index + offset;
      if (targetIndex >= nodeCount) continue;
      edges.push({
        id: `synthetic-edge-${edges.length}`,
        source: { type: 'event', id: nodes[index].id },
        target: { type: 'event', id: nodes[targetIndex].id },
        type: offset % 2 ? 'CAUSES' : 'RELATED_TO',
        provenance: { eventId: nodes[index].id, field: 'synthetic' },
      });
    }
  }
  return { nodes, edges };
}
