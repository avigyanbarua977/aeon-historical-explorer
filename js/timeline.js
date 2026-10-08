const EVENTS_URL = new URL('../data/events.json', import.meta.url);
const ERAS_URL = new URL('../data/eras.json', import.meta.url);
const RELATION_FIELDS = ['causes', 'consequences', 'relatedEvents'];

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required timeline element not found: #${id}`);
  return element;
}

function safeText(value) {
  return String(value ?? '');
}

function formatYear(year) {
  const absolute = Math.abs(year);
  if (absolute >= 1_000_000) return `${(absolute / 1_000_000).toFixed(absolute % 1_000_000 ? 1 : 0)} million ${year < 0 ? 'BCE' : 'CE'}`;
  return `${absolute.toLocaleString('en-US')} ${year < 0 ? 'BCE' : 'CE'}`;
}

function formatEraRange(era) {
  const start = formatYear(era.startYear);
  const end = era.endYear >= 2026 ? '2026' : formatYear(era.endYear);
  return `${start} — ${end}`;
}

function validateData(events, eras) {
  if (!Array.isArray(events) || !events.length) throw new Error('No historical events were found.');
  if (!Array.isArray(eras) || !eras.length) throw new Error('No historical eras were found.');

  const eraIds = new Set();
  for (const era of eras) {
    if (!era.id || !era.title || !Number.isFinite(era.startYear) || !Number.isFinite(era.endYear) || era.startYear > era.endYear) {
      throw new Error('A historical era has an invalid range or is missing its title.');
    }
    if (eraIds.has(era.id)) throw new Error(`The era id “${era.id}” appears more than once.`);
    eraIds.add(era.id);
  }
  const eventIds = new Set();
  for (const event of events) {
    for (const field of ['id', 'title', 'displayYear', 'description', 'importance']) {
      if (!event[field]) throw new Error(`A historical event is missing its ${field}.`);
    }
    if (!Number.isFinite(event.year)) throw new Error(`Event “${event.title}” has an invalid year.`);
    if (!eraIds.has(event.era)) throw new Error(`Event “${event.title}” refers to an unknown era.`);
    const era = eras.find((item) => item.id === event.era);
    if (event.year < era.startYear || event.year > era.endYear) throw new Error(`Event “${event.title}” falls outside its era's date range.`);
    if (eventIds.has(event.id)) throw new Error(`The event id “${event.id}” appears more than once.`);
    eventIds.add(event.id);
  }

  for (const event of events) {
    for (const field of RELATION_FIELDS) {
      if (event[field] !== undefined && !Array.isArray(event[field])) {
        throw new Error(`Event “${event.title}” has invalid ${field} data.`);
      }
      for (const relatedId of event[field] ?? []) {
        if (relatedId === event.id || !eventIds.has(relatedId)) {
          throw new Error(`Event “${event.title}” has an invalid ${field} reference.`);
        }
      }
    }
  }

  return {
    events: [...events].sort((a, b) => a.year - b.year || a.title.localeCompare(b.title)),
    eras: [...eras].sort((a, b) => a.startYear - b.startYear),
  };
}

export async function loadTimelineData() {
  let responses;
  try {
    responses = await Promise.all([fetch(EVENTS_URL), fetch(ERAS_URL)]);
  } catch {
    throw new Error('Historical data could not be reached. Start the local server and try again.');
  }

  if (!responses[0].ok) throw new Error('The events data could not be loaded.');
  if (!responses[1].ok) throw new Error('The eras data could not be loaded.');

  let events;
  let eras;
  try {
    [events, eras] = await Promise.all(responses.map((response) => response.json()));
  } catch {
    throw new Error('Historical data is not valid JSON.');
  }
  return validateData(events, eras);
}

export function initTimeline({ events, eras, onSelect, onOpenGraph } = {}) {
  const data = validateData(events, eras);
  const track = getElement('timeline-track');
  const shell = getElement('timeline-shell');
  const eraNavigation = getElement('era-navigation');
  const status = getElement('timeline-status');
  const detail = getElement('event-detail');
  const detailTitle = getElement('detail-title');
  const detailYear = getElement('detail-year');
  const detailEra = getElement('detail-era');
  const detailDescription = getElement('detail-description');
  const detailImportance = getElement('detail-importance');
  const detailClose = getElement('detail-close');
  const graphEntry = getElement('open-history-graph');
  const relationshipSection = getElement('relationship-section');
  const relationshipList = getElement('relationship-list');
  const eraById = new Map(data.eras.map((era) => [era.id, era]));
  const eventById = new Map(data.events.map((event) => [event.id, event]));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activeEra = 'all';
  let visibleEvents = data.events;
  let selectedEvent = null;
  let selectedButton = null;
  let eraButtons = new Map();
  const lastSelectedByEra = new Map();
  let closeTimer = 0;

  function updateStatus() {
    const selectedIndex = visibleEvents.findIndex((event) => event.id === selectedEvent?.id);
    const position = selectedIndex >= 0 ? ` · Moment ${selectedIndex + 1} of ${visibleEvents.length}` : '';
    const eraLabel = activeEra === 'all' ? 'All history' : eraById.get(activeEra).title;
    status.textContent = `${visibleEvents.length} moments · ${eraLabel}${position}`;
  }

  function closeDetail({ animate = true } = {}) {
    if (detail.hidden) return;
    window.clearTimeout(closeTimer);
    detail.inert = true;
    detail.classList.remove('is-open');
    if (animate && !reduceMotion.matches) {
      detail.classList.add('is-closing');
      closeTimer = window.setTimeout(() => {
        detail.hidden = true;
        detail.classList.remove('is-closing');
        closeTimer = 0;
      }, 220);
    } else {
      detail.hidden = true;
      detail.classList.remove('is-closing');
    }
    updateStatus();
  }

  function updateRelationships(event) {
    relationshipList.replaceChildren();
    const labels = { causes: 'Caused by', consequences: 'Followed by', relatedEvents: 'Related to' };
    let relationCount = 0;

    for (const field of RELATION_FIELDS) {
      for (const relatedId of event[field] ?? []) {
        const relatedEvent = eventById.get(relatedId);
        if (!relatedEvent) continue;
        const item = document.createElement('li');
        const relation = document.createElement('span');
        relation.className = 'relationship-type';
        relation.textContent = labels[field];
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'relationship-link';
        link.textContent = relatedEvent.title;
        link.addEventListener('click', () => {
          if (activeEra !== relatedEvent.era) setActiveEra(relatedEvent.era);
          const targetButton = [...track.querySelectorAll('.timeline-moment')].find((button) => button.dataset.eventId === relatedEvent.id);
          if (targetButton) selectEvent(relatedEvent, targetButton);
        });
        item.append(relation, link);
        relationshipList.append(item);
        relationCount += 1;
      }
    }

    relationshipSection.hidden = relationCount === 0;
  }

  function selectEvent(event, button, { scrollIntoView = true } = {}) {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    detail.classList.remove('is-closing');
    if (selectedButton && selectedButton !== button) selectedButton.setAttribute('aria-pressed', 'false');
    selectedEvent = event;
    selectedButton = button;
    lastSelectedByEra.set(event.era, event.id);
    button.setAttribute('aria-pressed', 'true');
    detailTitle.textContent = safeText(event.title);
    detailYear.textContent = safeText(event.displayYear);
    detailEra.textContent = safeText(eraById.get(event.era)?.title ?? event.era);
    detailDescription.textContent = safeText(event.description);
    detailImportance.textContent = safeText(event.importance).replaceAll('-', ' ');
    updateRelationships(event);
    graphEntry.hidden = false;
    detail.hidden = false;
    detail.inert = false;
    detail.classList.remove('is-open');
    requestAnimationFrame(() => detail.classList.add('is-open'));
    if (scrollIntoView) {
      const isMobile = window.matchMedia('(max-width: 700px)').matches;
      button.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: isMobile ? 'center' : 'nearest', inline: 'center' });
    }
    updateStatus();
    onSelect?.(event);
  }

  function renderEraNavigation() {
    eraNavigation.replaceChildren();
    eraButtons = new Map();
    const eraCounts = new Map(data.eras.map((era) => [era.id, 0]));
    data.events.forEach((event) => eraCounts.set(event.era, (eraCounts.get(event.era) ?? 0) + 1));
    const choices = [{ id: 'all', title: 'All history', range: '2.5 million years → 2026', count: data.events.length },
      ...data.eras.map((era) => ({ id: era.id, title: era.title, range: formatEraRange(era), count: eraCounts.get(era.id) }))];

    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'era-button';
      button.dataset.eraId = choice.id;
      button.setAttribute('aria-pressed', String(choice.id === activeEra));
      button.setAttribute('aria-label', `${choice.title}, ${choice.count} moments, ${choice.range}`);
      const title = document.createElement('span');
      title.className = 'era-name';
      title.textContent = choice.title;
      const range = document.createElement('span');
      range.className = 'era-range';
      range.textContent = choice.range;
      const count = document.createElement('span');
      count.className = 'era-count';
      count.textContent = String(choice.count).padStart(2, '0');
      button.append(title, range, count);
      button.addEventListener('click', () => setActiveEra(choice.id));
      eraNavigation.append(button);
      eraButtons.set(choice.id, button);
    }
  }

  function renderEvents() {
    track.replaceChildren();
    visibleEvents = activeEra === 'all' ? data.events : data.events.filter((event) => event.era === activeEra);
    visibleEvents.forEach((event, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'timeline-moment';
      button.dataset.eventId = event.id;
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', `${event.title}, ${event.displayYear}, moment ${index + 1} of ${visibleEvents.length}`);
      const eventYear = document.createElement('span');
      eventYear.className = 'moment-year';
      eventYear.textContent = safeText(event.displayYear);
      const eventTitle = document.createElement('span');
      eventTitle.className = 'moment-title';
      eventTitle.textContent = safeText(event.title);
      button.append(eventYear, eventTitle);
      button.addEventListener('click', () => selectEvent(event, button));
      track.append(button);
    });
    updateStatus();
  }

  function handleTimelineKeys(event) {
    const currentButton = event.target.closest?.('.timeline-moment');
    if (!currentButton) return;
    const currentIndex = [...track.querySelectorAll('.timeline-moment')].indexOf(currentButton);
    const offsets = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -currentIndex, End: visibleEvents.length - currentIndex - 1 };
    if (!(event.key in offsets)) return;
    const nextIndex = Math.max(0, Math.min(visibleEvents.length - 1, currentIndex + offsets[event.key]));
    const nextButton = track.querySelectorAll('.timeline-moment')[nextIndex];
    if (!nextButton || nextButton === currentButton) return;
    event.preventDefault();
    nextButton.focus();
    selectEvent(visibleEvents[nextIndex], nextButton);
  }

  function setActiveEra(eraId) {
    if (eraId !== 'all' && !eraById.has(eraId)) return false;
    const previousId = selectedEvent?.id;
    const previousEvent = previousId ? eventById.get(previousId) : null;
    const restoreId = eraId === 'all' || previousEvent?.era === eraId
      ? previousId
      : lastSelectedByEra.get(eraId);
    if (selectedButton) selectedButton.setAttribute('aria-pressed', 'false');
    selectedEvent = null;
    selectedButton = null;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    detail.classList.remove('is-open', 'is-closing');
    detail.hidden = true;
    detail.inert = true;
    graphEntry.hidden = true;
    activeEra = eraId;
    for (const [id, button] of eraButtons) button.setAttribute('aria-pressed', String(id === activeEra));
    renderEvents();
    shell.scrollTo({ left: 0, behavior: 'auto' });
    const eventToRestore = restoreId ? eventById.get(restoreId) : null;
    if (eventToRestore && (activeEra === 'all' || eventToRestore.era === activeEra)) {
      const button = [...track.querySelectorAll('.timeline-moment')].find((item) => item.dataset.eventId === eventToRestore.id);
      if (button) {
        selectedEvent = eventToRestore;
        selectedButton = button;
        button.setAttribute('aria-pressed', 'true');
        button.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: window.matchMedia('(max-width: 700px)').matches ? 'center' : 'nearest', inline: 'start' });
        updateStatus();
      }
    }
    return true;
  }

  renderEraNavigation();
  renderEvents();
  detail.hidden = true;
  detail.inert = true;
  track.addEventListener('keydown', handleTimelineKeys);
  detailClose.addEventListener('click', () => {
    const previousButton = selectedButton;
    closeDetail();
    previousButton?.focus();
  });
  graphEntry.addEventListener('click', () => {
    if (selectedEvent) onOpenGraph?.(selectedEvent.id);
  });
  getElement('timeline-view').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !detail.hidden) {
      const previousButton = selectedButton;
      closeDetail();
      previousButton?.focus();
    }
  });

  return {
    getActiveEra: () => activeEra,
    getSelectedEvent: () => selectedEvent,
    getEvents: () => [...data.events],
    selectById(id, { scrollIntoView = true } = {}) {
      const event = eventById.get(id);
      if (!event) return false;
      if (activeEra !== 'all' && activeEra !== event.era) setActiveEra(event.era);
      const button = [...track.querySelectorAll('.timeline-moment')].find((item) => item.dataset.eventId === id);
      if (!button) return false;
      selectEvent(event, button, { scrollIntoView });
      return true;
    },
    setActiveEra,
    closeDetail,
  };
}
