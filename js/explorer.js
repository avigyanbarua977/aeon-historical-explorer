import { interpretQuery } from './query-interpreter.js';
import { createRelationshipIndex } from './relationship-traversal.js';
import { retrieveEvents } from './event-retrieval.js';
import { buildHistoricalAnswer } from './historical-answer.js';
import { getAIEnhancedAnswer, isAIEligible } from './ai-explanation.js';

function required(container, selector) {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`Explorer interface element missing: ${selector}`);
  return element;
}

export function initExplorer({ container, openButton, events = [], eras = [], graphData, datasetVersion = null, requestExplanation, onOpen, onOpenTimeline, onOpenGraph, onReturn } = {}) {
  if (!container || !openButton) throw new TypeError('The explorer view and entry button are required.');
  const form = required(container, '#explorer-form');
  const input = required(container, '#explorer-question');
  const status = required(container, '#explorer-status');
  const result = required(container, '#explorer-result');
  const resultType = required(container, '#explorer-result-type');
  const resultHeading = required(container, '#explorer-result-heading');
  const shortAnswer = required(container, '#explorer-short-answer');
  const statements = required(container, '#explorer-statements');
  const pathList = required(container, '#explorer-path');
  const evidence = required(container, '#explorer-evidence');
  const scope = required(container, '#explorer-scope');
  const graphButton = required(container, '#explorer-open-graph');
  const returnButton = required(container, '#explorer-return');
  const examples = [...container.querySelectorAll('[data-explorer-example]')];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const erasById = new Map(eras.map((era) => [era.id, era]));
  let relationships = null;
  let lastAnswer = null;
  let lastQuery = null;
  let submissionId = 0;
  let activeRequest = null;

  try {
    relationships = createRelationshipIndex(graphData ?? { nodes: [], edges: [] });
  } catch (error) {
    status.textContent = `Historical connections are unavailable. Event lookup remains available. ${error.message}`;
  }

  function createEventButton(eventId, label = 'Open in Timeline') {
    const event = eventById.get(eventId);
    if (!event) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'explorer-event-reference';
    button.dataset.eventId = event.id;
    button.setAttribute('aria-label', `${label}: ${event.title}, ${event.displayYear}`);
    const title = document.createElement('span');
    title.className = 'explorer-event-title';
    title.textContent = event.title;
    const date = document.createElement('span');
    date.className = 'explorer-event-date';
    date.textContent = event.displayYear;
    button.append(title, date);
    button.addEventListener('click', () => onOpenTimeline?.(event.id));
    return button;
  }

  function renderAnswer(answer) {
    lastAnswer = answer;
    result.hidden = false;
    resultType.textContent = `${answer.heading}${answer.answerMode === 'ai' ? ' · AI explanation' : ''}`;
    resultHeading.textContent = answer.status === 'supported' || answer.status === 'insufficient_evidence' ? 'What AEON’s record shows' : 'Refine your question';
    shortAnswer.textContent = answer.shortAnswer;
    if (answer.answerMode === 'ai') resultHeading.textContent = 'AEON evidence, explained';
    statements.replaceChildren();
    statements.hidden = !Array.isArray(answer.statements) || !answer.statements.length;
    for (const statement of answer.statements ?? []) {
      const section = document.createElement('section');
      section.className = `explorer-statement explorer-statement--${statement.kind}`;
      const label = document.createElement('p');
      label.className = 'explorer-statement-kind';
      label.textContent = statement.kind === 'dataset_fact' ? 'AEON record' : 'Explanation';
      const text = document.createElement('p');
      text.className = 'explorer-statement-text';
      text.textContent = statement.text;
      section.append(label, text);
      const citations = document.createElement('div');
      citations.className = 'explorer-citations';
      for (const eventId of statement.eventIds) {
        const button = createEventButton(eventId, 'Evidence event');
        if (button) citations.append(button);
      }
      if (statement.relationshipIds.length) {
        const relationRefs = document.createElement('span');
        relationRefs.className = 'explorer-relationship-citations';
        relationRefs.textContent = `Relationship records: ${statement.relationshipIds.join(', ')}`;
        citations.append(relationRefs);
      }
      section.append(citations);
      statements.append(section);
    }
    scope.textContent = answer.uncertainty || answer.sourceScope;
    pathList.replaceChildren();
    pathList.hidden = !answer.path.length;
    for (const step of answer.path) {
      const item = document.createElement('li');
      const from = eventById.get(step.fromEventId);
      const to = eventById.get(step.toEventId);
      const relation = document.createElement('span');
      relation.className = `explorer-relation explorer-relation--${step.type.toLowerCase()}`;
      relation.textContent = step.type === 'CAUSES' ? 'CAUSES →' : 'RELATED TO ···';
      const source = createEventButton(from?.id, 'Open in Timeline');
      const target = createEventButton(to?.id, 'Open in Timeline');
      if (source) item.append(source);
      item.append(relation);
      if (target) item.append(target);
      const provenance = document.createElement('span');
      provenance.className = 'explorer-provenance';
      provenance.textContent = `${step.relationshipIds.length} validated relationship record${step.relationshipIds.length === 1 ? '' : 's'}`;
      item.append(provenance);
      pathList.append(item);
    }

    evidence.replaceChildren();
    const evidenceIds = answer.status === 'ambiguous'
      ? [...new Set(answer.candidates.map((candidate) => candidate.eventId))]
      : [...new Set(answer.eventIds)];
    if (evidenceIds.length) {
      const heading = document.createElement('h4');
      heading.textContent = answer.status === 'ambiguous' ? 'Possible event matches' : 'AEON event references';
      evidence.append(heading);
      const list = document.createElement('ul');
      for (const id of evidenceIds) {
        const eventButton = createEventButton(id);
        if (eventButton) {
          const item = document.createElement('li');
          item.append(eventButton);
          list.append(item);
        }
      }
      evidence.append(list);
    }

    const rootId = answer.navigation.graph?.rootEventId;
    graphButton.hidden = !rootId || !relationships?.nodes.has(rootId);
    if (rootId) graphButton.dataset.rootEventId = rootId;
    status.textContent = answer.status === 'supported' ? 'Answer grounded in AEON records.' : answer.status === 'insufficient_evidence' ? 'The available records do not establish the requested connection.' : answer.status === 'ambiguous' ? 'Several records may match. Choose a possible event or refine the question.' : answer.status === 'no_match' ? 'No matching AEON event was found.' : answer.status === 'unsupported' ? 'This question is outside the explorer’s supported historical queries.' : 'The answer did not pass evidence validation.';
  }

  function submitQuestion(question = input.value) {
    const text = String(question ?? '').trim();
    if (!text) {
      status.textContent = 'Enter a historical question to begin.';
      input.focus();
      return null;
    }
    status.textContent = 'Searching AEON’s historical record…';
    result.hidden = true;
    const query = interpretQuery(text, { eras, events });
    lastQuery = query;
    const retrieved = retrieveEvents(query, { events, eras, relationshipIndex: relationships });
    const answer = buildHistoricalAnswer(query, retrieved, { events, eras, graphData: graphData ?? { nodes: [], edges: [] } });
    renderAnswer(answer);
    return answer;
  }

  async function submitQuestionWithExplanation(question = input.value) {
    const currentSubmission = ++submissionId;
    activeRequest?.abort();
    activeRequest = new AbortController();
    const deterministicAnswer = submitQuestion(question);
    if (!deterministicAnswer || !isAIEligible(lastQuery, deterministicAnswer)) return deterministicAnswer;
    status.textContent = 'Preparing an optional explanation from validated AEON evidence…';
    const result = await getAIEnhancedAnswer({
      query: lastQuery,
      deterministicAnswer,
      datasetVersion,
      events,
      graphData: graphData ?? { nodes: [], edges: [] },
      requestExplanation,
      signal: activeRequest.signal,
    });
    if (currentSubmission !== submissionId) return deterministicAnswer;
    renderAnswer(result.answer);
    if (result.usedAI) status.textContent = 'AI explanation validated against AEON event and relationship records.';
    else if (result.fallback) status.textContent = "Showing AEON's deterministic result; AI explanation is unavailable.";
    activeRequest = null;
    return result.answer;
  }

  openButton.addEventListener('click', () => {
    onOpen?.();
    container.hidden = false;
    required(container, '#explorer-question').focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitQuestionWithExplanation();
  });
  examples.forEach((button) => button.addEventListener('click', () => {
    input.value = button.dataset.explorerExample;
    void submitQuestionWithExplanation(input.value);
  }));
  graphButton.addEventListener('click', () => {
    const rootId = graphButton.dataset.rootEventId;
    if (rootId && relationships?.nodes.has(rootId)) onOpenGraph?.(rootId);
  });
  returnButton.addEventListener('click', () => onReturn?.());
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !container.hidden) {
      event.preventDefault();
      onReturn?.();
    }
  });

  return {
    submitQuestion,
    submitQuestionWithExplanation,
    getLastAnswer: () => lastAnswer,
    focusQuestion: () => input.focus({ preventScroll: true }),
    focusGraphAction: () => graphButton.hidden ? input.focus({ preventScroll: true }) : graphButton.focus({ preventScroll: true }),
    getEvent: (id) => eventById.get(id) ?? null,
    getEra: (id) => erasById.get(id) ?? null,
  };
}
