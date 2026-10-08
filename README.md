# AEON — The Story of Humanity

AEON is a cinematic, data-driven experience for exploring human history from deep time to 2026. It combines a curated timeline and local relationship graph with a deterministic historical question explorer grounded in AEON's event and relationship data.

## Current features

- Cinematic landing page and Begin Journey transition.
- Six era filters and an All history view, generated from local era data.
- Selected-event context is retained when moving between eras and can be reopened after closing its details; restored moments align with a clear timeline gutter.
- 80 chronological milestones with approximate dates labeled where appropriate.
- Desktop horizontal timeline and dedicated vertical mobile timeline.
- Selectable, closable event details with date, description, era, and importance; mobile uses a compact detail dock.
- Small cause, consequence, and related-event links for selected milestones.
- Keyboard event navigation, visible focus, and reduced-motion support.
- Data validation and an on-page error message if timeline data is unavailable or inconsistent.
- A local History Graph opened from the selected event, with grouped causal and contextual connections.
- A deterministic Ask AEON explorer for event, date, era, cause, consequence, chronology, related-event, and path questions.
- An optional Phase 4B AI explanation endpoint for eligible, evidence-backed historical paths; deterministic answers remain the default fallback.
- Grounded answers link to existing timeline events and can open the existing History Graph. The optional Phase 4B provider path is implemented; deterministic answers remain available when the provider is unavailable.

## Folder structure

```text
AEON/
├── assets/                 # Future local fonts, icons, and imagery
├── css/
│   ├── animation.css        # Page and detail transitions
│   └── style.css            # Design tokens, timeline, details, responsive styles
├── data/
│   ├── eras.json            # Era IDs, labels, and inclusive year ranges
│   ├── events.json          # Chronological milestones and legacy relationship fields
│   └── relationships.json   # Canonical typed relationships with migration provenance
├── js/
│   ├── main.js              # App startup and landing/timeline navigation
│   ├── timeline.js          # Era navigation, rendering, selection
│   ├── relationship-engine.js # Legacy normalization, validation, graph-ready API
│   ├── graph-layout.js      # Adjacency index, bounded neighborhoods, radial positions
│   ├── graph.js             # SVG graph, controls, keyboard and touch interactions
│   ├── search.js            # Public deterministic query/retrieval exports
│   ├── query-interpreter.js # Deterministic natural-language intent parsing
│   ├── event-retrieval.js   # Local event ranking and query retrieval
│   ├── relationship-traversal.js # Canonical relationship indexes and bounded paths
│   ├── answer-grounding.js  # Event and relationship reference validation
│   ├── historical-answer.js # Deterministic structured answer builder
│   ├── ai-eligibility.js    # Deterministic rules for optional AI use
│   ├── ai-explanation.js    # Optional explanation orchestration/fallback
│   ├── provider-client.js  # Browser client for the AEON endpoint only
│   └── dataset-version.js  # Shared canonical data fingerprint
│   └── explorer.js          # Ask AEON UI and pipeline coordination
├── server/
│   ├── worker.js            # Cloudflare Worker endpoint and request validation
│   ├── evidence.js          # Canonical data loading and evidence construction
│   ├── prompt.js            # Grounded provider-neutral prompt
│   ├── answer-schema.js     # Versioned schema and grounding validation
│   ├── provider-adapter.js  # Provider-neutral generation boundary
│   └── providers/openai.js  # Single provider adapter
├── tests/
│   ├── history-graph.html   # Browser-run graph harness
│   ├── history-graph.test.js # Layout and graph integration checks
│   ├── relationship-engine.html # Relationship validation harness
│   ├── relationship-engine.test.js
│   ├── historical-explorer.html # Deterministic explorer harness
│   ├── historical-explorer.test.js
│   ├── phase4b-contract.html
│   └── phase4b-contract.test.js
├── wrangler.toml            # Worker runtime/assets/rate-limit configuration
├── .gitignore               # Local secrets and runtime artifacts
└── .dev.vars.example        # Empty local secret template
└── index.html               # Semantic page shell
```

Events require `id`, `title`, numeric `year` (negative for BCE), `displayYear`, `era`, `description`, and `importance`. The legacy `causes`, `consequences`, and `relatedEvents` event-ID arrays remain supported by the timeline. Phase 3A canonical relationships are stored in `data/relationships.json` as typed source/target endpoints with `CAUSES` or `RELATED_TO` types. Migrated records retain provenance back to the legacy event field.

## Relationship engine

Phase 3A stores canonical event relationships in `data/relationships.json`. Each relationship has a stable ID, typed `source` and `target` endpoints, a `CAUSES` or `RELATED_TO` type, and provenance pointing to its legacy event field. `causes` is normalized as related event → event; `consequences` as event → outcome; `relatedEvents` remains contextual. Legacy arrays stay intact for Phase 2 timeline compatibility.

`js/relationship-engine.js` exports `normalizeLegacyRelationships(events)` and `createRelationshipEngine({ events, relationships })`. The engine returns graph-ready typed event nodes and relationship edges plus diagnostics for missing endpoints, unsupported types, duplicate edges, reciprocal contextual edges, self-links, causal cycles, and suspicious chronology. It retains questionable relationships and exposes invalid edges through `getGraphData({ includeInvalid: true })` for review.

Run the relationship engine harness at `/tests/relationship-engine.html` from the local server. It exercises migration, graph output, and validation cases without additional packages. The harness currently passes 13 checks.

## History Graph (Phase 3B)

From an event's detail view, choose **Explore connections** to open the graph with that event as its root. The graph asks `relationship-engine.js` for graph-ready nodes and edges; `graph-layout.js` builds a one-time adjacency index and calculates a deterministic radial neighborhood. Graph visualization code never reads the legacy `causes`, `consequences`, or `relatedEvents` fields.

The root sits at the center. Causal precursors, outcomes, and contextual events occupy separate areas, ordered by historical date. Radial distance is for navigation and does not represent elapsed time. The default view is a bounded local neighborhood; users can adjust depth, expand or collapse branches, or make a selected event the new root. At most 100 nodes are visible, with a notice when the cap limits further expansion.

The SVG automatically frames the visible nodes with consistent breathing room, so small neighborhoods use the stage more effectively. Zoom controls work relative to that fitted view, and Reset restores the current content framing. Event titles have stronger contrast and hierarchy than dates and relationship metadata; causal edges use a clearer warm stroke and arrowhead.

`CAUSES` uses a solid warm line and arrowhead to show direction. `RELATED_TO` uses a muted dashed line without an arrowhead. Visually identical records are grouped into one edge; its count and source provenance remain inspectable. These line styles and accessible descriptions distinguish the relationship types without relying on color.

Graph controls include relationship filters, depth, zoom in/out/reset, and return to timeline. Drag or touch-drag pans the desktop/tablet SVG; pinch zoom is supported on touch. Keyboard users can move between nodes, select, expand/collapse, change root, operate filters and zoom controls, and exit with Escape. Returning preserves the selected event and restores focus to its graph-entry control. Event details reuse the existing timeline detail panel.

Desktop and tablet use the radial SVG stage. On mobile, the graph becomes a vertical, expandable list of connections with readable labels and usable event details. Motion respects `prefers-reduced-motion`. Graph loading/rendering errors provide retry and timeline-return actions while leaving the timeline usable.

Run the graph harness at `/tests/history-graph.html`. It covers layout, cycles, grouping/provenance, depth, expansion/collapse, the visible-node cap, graph interactions, and a runtime-only synthetic graph (not part of AEON's history data). Serve it over HTTP as described above.

Known limits: the graph is an event-only local neighborhood with a 100-node visible cap; radial positions are navigational, not a historical time scale. Whole-history graph exploration, entity nodes (people, civilizations, inventions, locations), geographic graph views, and richer graph search remain future work. The validated relationship engine and dataset are unchanged by the visual layer.

## Historical Explorer Engine (Phase 4A)

Choose **Ask AEON** from the timeline to ask a deterministic question over the current 80-event dataset. `query-interpreter.js` produces a structured intent; `event-retrieval.js` ranks local title, ID, description, era, and date matches; `relationship-traversal.js` indexes only graph-ready nodes and edges from the relationship engine and finds bounded paths. `answer-grounding.js` validates event and relationship references before `historical-answer.js` returns a structured response for `explorer.js` to render.

Supported questions include event lookup, date and era lookup, recorded causes and consequences, contextual relationships, before/after chronology, and paths between events. Exact `CAUSES` edges remain distinct from undirected `RELATED_TO` context. A path can contain both types, and AEON labels each step. When evidence is missing, ambiguous, unsupported, or absent, the explorer says so rather than inventing a connection. Event references open the existing timeline selection behavior; **Explore Connection** opens the existing History Graph at a real result event.

Answers are grounded in AEON event descriptions and canonical relationships. The current dataset does not include an external bibliography, so those records are not independent scholarly citations. Phase 4A itself makes no external requests and uses no AI, API key, embeddings, or vector search. Optional provider integration is handled separately by the Phase 4B Worker.

Run the deterministic explorer harness at `/tests/historical-explorer.html`. Its 33 checks cover query types, event/date/era matching, relationship direction and paths, ambiguity, unsupported and no-match questions, grounding, duplicate relationships, navigation callbacks, keyboard form behavior, and canonical data. It requires only the local HTTP server.

## AI Provider Integration (Phase 4B)

Phase 4B keeps the completed Phase 4A query interpretation and retrieval in front of the optional model call. Only a supported historical-path query with a validated path is currently eligible; event, date, era, chronology, direct cause/consequence, ambiguous, unsupported, and no-match queries stay deterministic. Provider failure or rejected output returns the already-built deterministic answer.

The browser calls only `POST /v1/explain` on the AEON endpoint and sends the question, structured intent, event IDs, relationship IDs, and dataset fingerprint. The Cloudflare Worker re-runs Phase 4A interpretation/retrieval using the same query modules, resolves IDs against its canonical asset snapshot, checks endpoints/types/direction, and constructs evidence from trusted event descriptions and graph-ready relationships. The Worker does not accept descriptions or relationship definitions from the browser. Its `ASSETS` binding points directly at `./data`; no manually maintained copy of the historical JSON exists.

The provider boundary is `generateGroundedExplanation(input)`. Phase 4B currently includes one OpenAI adapter using the Responses API with strict JSON Schema output. Configure `OPENAI_MODEL` in Worker variables and `OPENAI_API_KEY` as a Worker secret. The browser schema remains provider-neutral. The model schema separates exact copied `dataset_fact` records from cited `explanation` statements, relationship claims, validated path steps, and uncertainty. The server and browser validate references, evidence scope, relationship type/endpoints/direction, path continuity and endpoints, exact fact text, causal wording, and output bounds before any model answer is rendered. The client never sends provider authorization headers.

### Local development

Run the static frontend on one origin, for example:

```powershell
python -m http.server 8000
```

Install/use the Cloudflare Wrangler CLI in your development environment, then run the Worker separately:

```powershell
npx wrangler dev --port 8787
```

Set the public endpoint URL in the `aeon-api-endpoint` meta tag in `index.html` to `http://localhost:8787` for local integration. The local `ALLOWED_ORIGINS` value in `wrangler.toml` allows the frontend origins on port 8000. The endpoint fails safely if the provider key is absent.

For a provider-free browser-to-Worker integration test, start the test-only fake provider Worker instead:

```powershell
npx wrangler dev --local --config tests/wrangler.fake-provider.toml --port 8787
```

This wrapper uses the production request validation and grounding pipeline with a deterministic fake explanation adapter. It does not call OpenAI and must not be deployed. The Phase 4B browser harness supplies this endpoint to its isolated AEON iframe; the checked-in application endpoint meta remains empty by default.

For local provider development, copy `.dev.vars.example` to `.dev.vars` and set `OPENAI_API_KEY` only in that ignored local file. Never place a real key in `.dev.vars.example`, `wrangler.toml`, browser code, tests, or committed files. `.dev.vars` is local-only and is not part of the repository. Core tests use fake adapters and do not require a key or external network. A separate controlled real-provider request was made once; the Worker returned HTTP 503 `PROVIDER_UNAVAILABLE`, and local Wrangler did not retain the provider's HTTP status or error metadata. No successful real-provider response or grounding validation has been verified.

Run the Worker contract harness at <http://localhost:8000/tests/phase4b-contract.html>; it has 50 deterministic checks and uses a local Wrangler fake-provider path without a key or external provider. Run <http://localhost:8000/tests/relationship-engine.html> (13 checks), <http://localhost:8000/tests/history-graph.html> (27 checks, including the synthetic 1,800-node case), and <http://localhost:8000/tests/historical-explorer.html> (33 checks). There is no separate Phase 2 harness; Phase 4B browser checks cover the landing-to-timeline flow and event selection. Syntax-check JavaScript with `node --check` on files under `js/`, `server/`, and `tests/`.

### Production deployment and security

Keep AEON's frontend on GitHub Pages and deploy the Worker separately. Before production deployment:

1. Set the production `ALLOWED_ORIGINS` value to the exact GitHub Pages origin (or custom domain origin), with no wildcard. The checked-in Wrangler configuration is for localhost development and must not be used unchanged for production.
2. Set the public `aeon-api-endpoint` meta value to the HTTPS endpoint URL. This URL is public configuration, not a secret.
3. Add `OPENAI_API_KEY` with the Cloudflare secret manager, for example `npx wrangler secret put OPENAI_API_KEY --env production`; do not put it in `[vars]` or frontend configuration. For local development, omit `--env production` and use the ignored `.dev.vars` file.
4. Configure `OPENAI_MODEL`, the production rate-limit binding, provider usage limits, and monitoring. Select a unique rate-limit namespace ID for the Cloudflare account.
5. Deploy and verify the frontend and endpoint use the same dataset fingerprint.

CORS is restricted to exact configured origins, but it is not authentication; non-browser clients can still call a public endpoint. Requests and evidence are size-bounded, provider calls have a timeout and output cap, and rate limiting is applied per client IP. Cloudflare's rate limiter is an abuse-control mechanism, not an absolute billing cap. Operational code does not log raw questions and AEON does not persist queries or answers by default. The Ask AEON form discloses before submission that eligible questions and selected public AEON evidence are sent to AEON's server and OpenAI. Provider-side handling follows the provider's terms; AEON makes no broader retention promise.

The dataset fingerprint is SHA-256 over ID-sorted canonical `events.json`, `eras.json`, and `relationships.json` values. The browser and Worker compute it from their loaded data. A mismatch rejects the provider request, preserving deterministic results rather than silently answering against different records.

## Run locally

The app uses JavaScript modules and `fetch()`, so serve it over HTTP instead of opening it with `file://`.

Start the static frontend from the project root:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. For the isolated Phase 4B browser integration harness, start the fake Worker in a second terminal:

```bash
npx wrangler dev --local --config tests/wrangler.fake-provider.toml --port 8787
```

Open the test pages listed above. This fake provider is only for local tests and must not be deployed. For local real-provider development only, use `npx wrangler dev --local --port 8787` after setting the key in ignored `.dev.vars`; never paste a key into a command or commit it.

Run JavaScript syntax checks from PowerShell with (excluding Wrangler's generated files):

```powershell
Get-ChildItem js,server,tests -Recurse -File -Filter '*.js' | Where-Object { $_.FullName -notmatch '[\\/]\.wrangler[\\/]' } | ForEach-Object { node --check $_.FullName }
```

## Roadmap

- **Phase 1 — Landing and timeline foundation:** implemented.
- **Phase 2 — Historical exploration: COMPLETE.** Era navigation, event exploration, expanded milestones, and relationship references are implemented and manually verified in Chrome across desktop, laptop, tablet, and mobile. Full non-linear timeline zoom is explicitly deferred as future work.
- **Phase 3A — Relationship Engine: COMPLETE.** Canonical typed relationships, legacy migration, diagnostics, graph-ready output, and the 13-check harness are implemented.
- **Phase 3B — Visual History Graph: COMPLETE.** Native SVG graph, bounded deterministic neighborhoods, relationship filters, node exploration, responsive mobile connections, keyboard access, and browser verification are implemented. See the History Graph section and `AGENTS.md` acceptance checklist.
- **Phase 4A — Historical Explorer Engine: COMPLETE.** Deterministic query interpretation, retrieval, canonical relationship traversal, grounding validation, structured answers, and timeline/graph navigation are implemented. No provider or external service is connected.
- **Phase 4B — AI Provider Integration: IMPLEMENTED; REAL PROVIDER VERIFICATION BLOCKED.** The provider Worker, canonical evidence reconstruction, structured output validation, grounding checks, and deterministic fallback are implemented. Regression harnesses pass (50 / 33 / 13 / 27 checks), and syntax checks pass for all 27 project JavaScript files. One controlled local request reached the provider adapter but the Worker returned HTTP 503 `PROVIDER_UNAVAILABLE`; local Wrangler did not retain the underlying provider HTTP status/error, and no grounded AI answer was received. The deterministic Phase 4A result remains available. `.dev.vars` is ignored and local-only; no API key is committed. Production origin configuration remains a placeholder. No production deployment has been performed. Do not mark Phase 4B complete until a real provider response passes grounding validation and all acceptance criteria are verified.
- **Phase 5 — Interactive Historical Map: DEFERRED.** Geographic history remains planned future work.
- Later phases: Humanity in One Day visualization, cinematic polish, and deployment.

The dataset is curated for exploration, not a complete historical reference. Dates with meaningful uncertainty use approximate language; fact-level sourcing and review should continue as the dataset grows.
