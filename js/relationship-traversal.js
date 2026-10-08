const TYPES = new Set(['CAUSES', 'RELATED_TO']);

function groupKey(edge) {
  const [source, target] = edge.type === 'RELATED_TO'
    ? [edge.source.id, edge.target.id].sort()
    : [edge.source.id, edge.target.id];
  return `${edge.type}|${source}|${target}`;
}

export function createRelationshipIndex(graphData) {
  if (!Array.isArray(graphData?.nodes) || !Array.isArray(graphData?.edges)) throw new TypeError('Graph-ready nodes and edges are required.');
  const nodes = new Map(graphData.nodes.filter((node) => node?.type === 'event' && typeof node.id === 'string').map((node) => [node.id, node]));
  const grouped = new Map();
  for (const edge of graphData.edges) {
    if (!TYPES.has(edge?.type) || !nodes.has(edge.source?.id) || !nodes.has(edge.target?.id)) continue;
    const key = groupKey(edge);
    if (!grouped.has(key)) grouped.set(key, { id: key, type: edge.type, source: edge.source.id, target: edge.target.id, relationshipIds: [], records: [] });
    const group = grouped.get(key);
    group.relationshipIds.push(edge.id);
    group.records.push(edge);
  }
  const edges = [...grouped.values()];
  const incomingCauses = new Map([...nodes.keys()].map((id) => [id, []]));
  const outgoingCauses = new Map([...nodes.keys()].map((id) => [id, []]));
  const contextual = new Map([...nodes.keys()].map((id) => [id, []]));
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.source).push(edge);
    if (edge.target !== edge.source) adjacency.get(edge.target).push(edge);
    if (edge.type === 'CAUSES') {
      outgoingCauses.get(edge.source).push(edge);
      incomingCauses.get(edge.target).push(edge);
    } else {
      contextual.get(edge.source).push(edge);
      contextual.get(edge.target).push(edge);
    }
  }
  return { nodes, edges, adjacency, incomingCauses, outgoingCauses, contextual };
}

export function adjacentRelationships(index, eventId, { type, direction = 'both' } = {}) {
  if (!index?.nodes.has(eventId)) return [];
  let result;
  if (type === 'CAUSES' && direction === 'incoming') result = index.incomingCauses.get(eventId);
  else if (type === 'CAUSES' && direction === 'outgoing') result = index.outgoingCauses.get(eventId);
  else if (type === 'RELATED_TO') result = index.contextual.get(eventId);
  else result = index.adjacency.get(eventId);
  return [...new Map((result ?? []).map((edge) => [edge.id, edge])).values()];
}

export function findHistoricalPath(index, startId, endId, { maxDepth = 4, causesOnly = false } = {}) {
  if (!index?.nodes.has(startId) || !index?.nodes.has(endId)) return { found: false, nodes: [], edges: [] };
  if (startId === endId) return { found: true, nodes: [startId], edges: [] };
  const queue = [{ id: startId, pathNodes: [startId], pathEdges: [] }];
  const visitedDepth = new Map([[startId, 0]]);
  while (queue.length) {
    const current = queue.shift();
    if (current.pathEdges.length >= maxDepth) continue;
    const edges = (index.adjacency.get(current.id) ?? []).filter((edge) => !causesOnly || edge.type === 'CAUSES');
    for (const edge of edges) {
      if (causesOnly && edge.type === 'CAUSES' && edge.source !== current.id) continue;
      const nextId = edge.source === current.id ? edge.target : edge.source;
      const nextDepth = current.pathEdges.length + 1;
      if (visitedDepth.has(nextId) && visitedDepth.get(nextId) <= nextDepth) continue;
      const pathNodes = [...current.pathNodes, nextId];
      const pathEdges = [...current.pathEdges, edge];
      if (nextId === endId) return { found: true, nodes: pathNodes, edges: pathEdges };
      visitedDepth.set(nextId, nextDepth);
      queue.push({ id: nextId, pathNodes, pathEdges });
    }
  }
  return { found: false, nodes: [], edges: [] };
}

export function getChronologicalNeighbors(index, eventId, direction) {
  const event = index?.nodes.get(eventId);
  if (!event) return [];
  return [...index.nodes.values()]
    .filter((candidate) => direction === 'forward' ? candidate.year > event.year : candidate.year < event.year)
    .sort((left, right) => Math.abs(left.year - event.year) - Math.abs(right.year - event.year) || left.id.localeCompare(right.id))
    .slice(0, 6);
}
