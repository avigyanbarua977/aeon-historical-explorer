const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'did', 'do', 'does', 'for', 'from', 'how', 'in', 'is', 'it', 'me', 'of', 'on', 'show', 'tell', 'that', 'the', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'with']);

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('en').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value) {
  return normalize(value).split(/\s+/).filter((token) => token && !STOP_WORDS.has(token));
}

function matchEra(text, eras) {
  const normalized = normalize(text);
  const padded = ` ${normalized} `;
  return eras.find((era) => {
    const title = normalize(era.title);
    const titleWithoutArticle = title.replace(/^the\s+/, '');
    const id = normalize(era.id);
    const titleMatch = padded.includes(` ${title} `) || (titleWithoutArticle !== title && padded.includes(` ${titleWithoutArticle} `));
    const explicitIdMatch = normalized === id || new RegExp(`\\b(?:in|during|era|period)\\s+(?:the\\s+)?${id}\\b`).test(normalized) || new RegExp(`\\b${id}\\s+(?:era|period|age)\\b`).test(normalized);
    return titleMatch || explicitIdMatch;
  }) ?? null;
}

function extractYears(text) {
  const matches = [...String(text).matchAll(/\b(\d{1,7}(?:,\d{3})*)(?:\s*(BCE|BC|CE|AD))?\b/gi)];
  return matches.map((match) => {
    const absolute = Number(match[1].replaceAll(',', ''));
    const era = match[2]?.toUpperCase();
    return { year: era === 'BCE' || era === 'BC' ? -absolute : absolute, display: match[0] };
  }).filter((value) => Number.isFinite(value.year));
}

function eventCandidatesFor(text, events) {
  const normalized = ` ${normalize(text)} `;
  return events.filter((event) => {
    const title = normalize(event.title);
    const id = normalize(event.id).replaceAll('-', ' ');
    return (title.length > 2 && normalized.includes(` ${title} `)) || (id.length > 2 && normalized.includes(` ${id} `));
  }).map((event) => event.id);
}

function intentFor(text) {
  const normalized = normalize(text);
  if (/\bhow did\b.*\b(lead to|result in|cause)\b/.test(normalized)) return { intent: 'historical_path', direction: 'forward', relationshipType: null, explanationType: 'historical_path' };
  if (/\b(after|followed by|came next|what came next)\b/.test(normalized)) return { intent: 'what_after', direction: 'forward', relationshipType: null, explanationType: 'chronology' };
  if (/\b(before|preceded|what came before|earlier than)\b/.test(normalized)) return { intent: 'what_before', direction: 'backward', relationshipType: null, explanationType: 'chronology' };
  if (/\b(path|connection|connect|link)\b/.test(normalized) && /\b(between|from|to)\b/.test(normalized)) return { intent: 'historical_path', direction: 'forward', relationshipType: null, explanationType: 'historical_path' };
  if (/\b(caus(e|es|ed|ing)|why did)\b/.test(normalized)) return { intent: 'cause_explanation', direction: 'incoming', relationshipType: 'CAUSES', explanationType: 'causes' };
  if (/\b(consequence|consequences|result|results|impact|led to|lead to|followed from)\b/.test(normalized)) return { intent: 'consequence_lookup', direction: 'outgoing', relationshipType: 'CAUSES', explanationType: 'consequences' };
  if (/\b(related|connection|connected|context)\b/.test(normalized)) return { intent: 'related_events', direction: 'both', relationshipType: 'RELATED_TO', explanationType: 'context' };
  if (/\b(era|period|age)\b/.test(normalized)) return { intent: 'era_overview', direction: 'none', relationshipType: null, explanationType: 'era_overview' };
  if (/\b(what happened|during|in|around)\b/.test(normalized) && /\b\d/.test(text)) return { intent: 'date_lookup', direction: 'none', relationshipType: null, explanationType: 'date_lookup' };
  if (/\b(event|events|tell me about|what is|who is|when was|when did)\b/.test(normalized)) return { intent: 'event_lookup', direction: 'none', relationshipType: null, explanationType: 'event' };
  return null;
}

export function interpretQuery(question, { eras = [], events = [] } = {}) {
  const text = String(question ?? '').trim();
  if (!text) return { status: 'unsupported', reason: 'empty_query', intent: null, eventCandidates: [], eraId: null, timeRange: null, relationshipType: null, direction: null, depth: 3, explanationType: null, tokens: [] };

  const detected = intentFor(text);
  const era = matchEra(text, eras);
  const years = extractYears(text);
  const queryTokens = tokens(text);
  const eventCandidates = eventCandidatesFor(text, events);
  const hasEventPhrase = events.some((event) => {
    const normalizedText = normalize(text);
    const title = normalize(event.title);
    const id = normalize(event.id);
    return (title.length > 2 && normalizedText.includes(title)) || (id.length > 2 && normalizedText.includes(id));
  });
  const searchTokens = new Set(events.flatMap((event) => [...tokens(event.title), ...tokens(event.id), ...tokens(event.description)]));
  const hasEventKeyword = queryTokens.some((token) => searchTokens.has(token));
  if (!detected && (hasEventPhrase || hasEventKeyword || (!era && years.length) || queryTokens.length <= 2)) {
    const fallback = years.length && !hasEventPhrase
      ? { intent: 'date_lookup', direction: 'none', relationshipType: null, explanationType: 'date_lookup' }
      : { intent: 'event_lookup', direction: 'none', relationshipType: null, explanationType: 'event' };
    return { status: 'supported', reason: null, raw: text, intent: fallback.intent, eventCandidates, eraId: era?.id ?? null, timeRange: years.length ? { startYear: years[0].year, endYear: years.at(-1).year, label: years.map((value) => value.display).join('–') } : null, relationshipType: fallback.relationshipType, direction: fallback.direction, depth: 4, explanationType: fallback.explanationType, tokens: queryTokens };
  }
  if (!detected && !era && !years.length) return { status: 'unsupported', reason: 'unsupported_intent', raw: text, intent: null, eventCandidates: [], eraId: null, timeRange: null, relationshipType: null, direction: null, depth: 3, explanationType: null, tokens: queryTokens };

  const inferred = detected ?? { intent: 'era_overview', direction: 'none', relationshipType: null, explanationType: 'era_overview' };
  const pathWords = /\b(between|connect|connection|path)\b/.test(normalize(text));
  const mentions = pathWords ? queryTokens.join(' ').split(/\b(?:and|to|with)\b/).map((part) => part.trim()).filter(Boolean) : [];
  const status = inferred.intent === 'historical_path' && mentions.length < 2 && queryTokens.length < 2 ? 'ambiguous' : 'supported';

  return {
    status,
    reason: status === 'ambiguous' ? 'path_endpoints_unclear' : null,
    raw: text,
    intent: inferred.intent,
    eventCandidates,
    eraId: era?.id ?? null,
    timeRange: years.length ? { startYear: years[0].year, endYear: years.at(-1).year, label: years.map((value) => value.display).join('–') } : null,
    relationshipType: inferred.relationshipType,
    direction: inferred.direction,
    depth: 4,
    explanationType: inferred.explanationType,
    tokens: queryTokens,
  };
}

export { normalize, tokens };
