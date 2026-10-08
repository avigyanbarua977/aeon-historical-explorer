const EVENT_TYPE = 'event';
const EDGE_TYPES = new Set(['CAUSES', 'RELATED_TO']);

function endpointKey(endpoint) {
  return `${endpoint?.type}:${endpoint?.id}`;
}

function edgeKey(edge) {
  return `${edge.type}|${endpointKey(edge.source)}|${endpointKey(edge.target)}`;
}

function pairKey(edge) {
  return [endpointKey(edge.source), endpointKey(edge.target)].sort().join('|');
}

function findCausalCycles(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (edge?.type !== 'CAUSES' || typeof edge.source?.id !== 'string' || typeof edge.target?.id !== 'string') continue;
    if (!adjacency.has(edge.source.id)) adjacency.set(edge.source.id, []);
    adjacency.get(edge.source.id).push(edge);
  }

  const state = new Map();
  const stack = [];
  const cycles = [];
  const cycleKeys = new Set();
  function visit(id) {
    state.set(id, 1);
    for (const edge of adjacency.get(id) ?? []) {
      const target = edge.target.id;
      if (!state.has(target)) {
        stack.push(edge);
        visit(target);
        stack.pop();
      } else if (state.get(target) === 1) {
        const start = stack.findIndex((item) => item.source.id === target);
        const cycle = [...stack.slice(Math.max(0, start)), edge];
        const key = cycle.map(edgeKey).sort().join(';');
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          cycles.push(cycle);
        }
      }
    }
    state.set(id, 2);
  }
  const ids = new Set(edges.filter((edge) => edge.type === 'CAUSES').flatMap((edge) => [edge.source.id, edge.target.id]));
  for (const id of ids) if (!state.has(id)) visit(id);
  return cycles;
}

export function normalizeLegacyRelationships(events) {
  if (!Array.isArray(events)) throw new TypeError('Events must be an array.');
  const relationships = [];
  for (const event of events) {
    for (const [field, type, direction] of [
      ['causes', 'CAUSES', 'inbound'],
      ['consequences', 'CAUSES', 'outbound'],
      ['relatedEvents', 'RELATED_TO', 'outbound'],
    ]) {
      const targets = event[field] ?? [];
      if (!Array.isArray(targets)) continue;
      for (const relatedId of targets) {
        const sourceId = direction === 'inbound' ? relatedId : event.id;
        const targetId = direction === 'inbound' ? event.id : relatedId;
        const [canonicalSource, canonicalTarget] = type === 'RELATED_TO'
          ? [sourceId, targetId].sort((left, right) => left.localeCompare(right))
          : [sourceId, targetId];
        relationships.push({
          id: `relationship-${String(relationships.length + 1).padStart(4, '0')}`,
          source: { type: EVENT_TYPE, id: canonicalSource },
          target: { type: EVENT_TYPE, id: canonicalTarget },
          type,
          provenance: { eventId: event.id, field },
        });
      }
    }
  }
  return relationships;
}

export function createRelationshipEngine({ events, relationships, entities = {} } = {}) {
  if (!Array.isArray(events) || !Array.isArray(relationships)) {
    throw new TypeError('The relationship engine requires event and relationship arrays.');
  }
  const eventById = new Map(events.filter((event) => typeof event.id === 'string').map((event) => [event.id, event]));
  const entityMaps = new Map([[EVENT_TYPE, eventById]]);
  for (const [type, records] of Object.entries(entities)) {
    if (type !== EVENT_TYPE && Array.isArray(records)) {
      entityMaps.set(type, new Map(records.filter((record) => typeof record.id === 'string').map((record) => [record.id, record])));
    }
  }
  const endpointExists = (endpoint) => typeof endpoint?.type === 'string'
    && typeof endpoint.id === 'string'
    && entityMaps.get(endpoint.type)?.has(endpoint.id) === true;
  const diagnostics = [];
  const add = (code, severity, relationship, message) => diagnostics.push({
    code, severity, relationshipId: relationship?.id ?? null, message,
  });
  const ids = new Set();
  const seenEdges = new Map();
  const seenPairs = new Map();

  for (const edge of relationships) {
    if (!edge || typeof edge !== 'object') {
      add('INVALID_EDGE', 'error', null, 'Relationship entry must be an object.');
      continue;
    }
    if (!edge.id || ids.has(edge.id)) add('DUPLICATE_ID', 'error', edge, `Relationship id is missing or duplicated: ${edge.id ?? '(missing)'}.`);
    ids.add(edge.id);
    if (!EDGE_TYPES.has(edge.type)) add('INVALID_TYPE', 'error', edge, `Unsupported relationship type: ${edge.type ?? '(missing)'}.`);
    const sourceExists = endpointExists(edge.source);
    const targetExists = endpointExists(edge.target);
    if (!sourceExists || !targetExists) add('MISSING_ENDPOINT', 'error', edge, 'Relationship source or target does not resolve to an event.');
    if (sourceExists && targetExists && edge.source.id === edge.target.id) add('SELF_LINK', 'error', edge, 'An event cannot be related to itself.');

    const exactKey = edgeKey(edge);
    if (seenEdges.has(exactKey)) add('DUPLICATE_EDGE', 'warning', edge, `Duplicates ${seenEdges.get(exactKey)}.`);
    else seenEdges.set(exactKey, edge.id);

    if (edge.type === 'RELATED_TO') {
      const key = pairKey(edge);
      const previous = seenPairs.get(key);
      const reverseDirection = previous && endpointKey(edge.source) !== endpointKey(previous.source);
      const reciprocalLegacyEntry = previous
        && edge.provenance?.eventId !== previous.provenance?.eventId
        && edge.provenance?.field === 'relatedEvents'
        && previous.provenance?.field === 'relatedEvents';
      if (previous && (reverseDirection || reciprocalLegacyEntry)) {
        add('RECIPROCAL_DUPLICATE', 'warning', edge, `Reciprocal of ${previous.id}; keep both records until reviewed.`);
      } else if (!seenPairs.has(key)) seenPairs.set(key, edge);
    }

    if (edge.type === 'CAUSES' && sourceExists && targetExists) {
      const sourceYear = eventById.get(edge.source.id).year;
      const targetYear = eventById.get(edge.target.id).year;
      if (Number.isFinite(sourceYear) && Number.isFinite(targetYear) && targetYear < sourceYear) {
        add('SUSPICIOUS_CHRONOLOGY', 'warning', edge, 'A cause is dated after its stated outcome; review this relationship.');
      }
    }
  }

  for (const cycle of findCausalCycles(relationships)) {
    const path = [cycle[0]?.source.id, ...cycle.map((edge) => edge.target.id)].filter(Boolean).join(' → ');
    for (const edge of cycle) add('CAUSAL_CYCLE', 'warning', edge, `Causal cycle detected: ${path}.`);
  }

  const validNodes = [...entityMaps].flatMap(([type, records]) => [...records.values()]
    .filter((record) => typeof record.title === 'string')
    .map((record) => ({ ...record, type })));
  return Object.freeze({
    getDiagnostics: () => diagnostics.map((item) => ({ ...item })),
    getGraphData({ includeInvalid = false } = {}) {
      const graphEdges = includeInvalid ? relationships : relationships.filter((edge) => {
        const edgeDiagnostics = diagnostics.filter((item) => item.relationshipId === edge.id);
        return !edgeDiagnostics.some((item) => item.severity === 'error');
      });
      return {
        nodes: validNodes.map((record) => ({
          id: record.id,
          type: record.type,
          title: record.title,
          ...(Number.isFinite(record.year) ? { year: record.year } : {}),
          ...(record.displayYear ? { displayYear: record.displayYear } : {}),
          ...(record.era ? { era: record.era } : {}),
        })),
        edges: graphEdges.map((edge) => ({ ...edge, source: { ...edge.source }, target: { ...edge.target } })),
      };
    },
  });
}
