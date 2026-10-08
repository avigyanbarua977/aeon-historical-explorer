const MAX_DATA_BYTES = 2_500_000;
const MAX_EVIDENCE_BYTES = 18_000;

async function readAssetJson(assetBinding, url) {
  if (!assetBinding?.fetch) throw new Error('Canonical data assets are unavailable.');
  const response = await assetBinding.fetch(new Request(url));
  if (!response.ok) throw new Error('Canonical data assets are unavailable.');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DATA_BYTES) throw new Error('Canonical data asset exceeds its safety limit.');
  try { return JSON.parse(text); } catch { throw new Error('Canonical data asset is invalid.'); }
}

export async function loadCanonicalDataset(assetBinding, requestUrl) {
  const base = new URL(requestUrl);
  const [events, eras, relationships] = await Promise.all([
    readAssetJson(assetBinding, new URL('/events.json', base)),
    readAssetJson(assetBinding, new URL('/eras.json', base)),
    readAssetJson(assetBinding, new URL('/relationships.json', base)),
  ]);
  if (![events, eras, relationships].every(Array.isArray)) throw new Error('Canonical data snapshot is invalid.');
  return { events, eras, relationships };
}

export function buildEvidencePacket({ eventIds, relationshipIds, events = [], graphData } = {}) {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const edgeById = new Map((graphData?.edges ?? []).map((edge) => [edge.id, edge]));
  const selectedEvents = eventIds.map((id) => {
    const event = eventById.get(id);
    if (!event) throw new Error('An event reference could not be resolved.');
    return { id: event.id, title: event.title, year: event.year, displayYear: event.displayYear, era: event.era, description: event.description };
  });
  const selectedRelationships = relationshipIds.map((id) => {
    const edge = edgeById.get(id);
    if (!edge || !['CAUSES', 'RELATED_TO'].includes(edge.type)
      || !eventById.has(edge.source?.id) || !eventById.has(edge.target?.id)) {
      throw new Error('A relationship reference could not be resolved.');
    }
    if (!eventIds.includes(edge.source.id) || !eventIds.includes(edge.target.id)) {
      throw new Error('Relationship endpoints are outside the evidence event scope.');
    }
    return {
      id: edge.id,
      type: edge.type,
      sourceEventId: edge.source.id,
      targetEventId: edge.target.id,
      provenance: edge.provenance ?? null,
    };
  });
  const packet = { events: selectedEvents, relationships: selectedRelationships };
  if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error('Evidence exceeds the maximum size.');
  }
  return packet;
}

export const EVIDENCE_LIMITS = Object.freeze({ maxEvents: 12, maxRelationships: 24, maxBytes: MAX_EVIDENCE_BYTES });
