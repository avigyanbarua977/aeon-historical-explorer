// Stable public entry point for deterministic query interpretation and retrieval.
// Relationship traversal and answer grounding remain in their own modules.
export { interpretQuery } from './query-interpreter.js';
export { rankEventCandidates, retrieveEvents } from './event-retrieval.js';
