# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step is required. Run `start-local.bat` (or `python server.py [port]`, default 8080). `server.py` is a stdlib-only static server bound to 127.0.0.1 that also exposes `GET /api/ping` and `POST /api/save` (`{ path, data }`, JSON content-type and same-origin required; only `projects/**.json` may be written, atomically, pretty-printed). Any other static server (`npx serve .`, `python -m http.server`) also works, but then saving falls back to downloads. The write-back server is **single-user / local only**; deploying to other engineers needs a different storage backend.

Leaflet.js is loaded from CDN (`unpkg.com/leaflet@1.9.4`) — an internet connection is needed for the library. Map tiles come from ArcGIS/Esri (`World_Street_Map`); alternative tile providers are noted in `DOC/map-tile-providers.md`.

---

## Architecture

This is a single-page, zero-dependency (no npm, no bundler) vanilla JS traffic signal simulation tool. All logic lives in three files: `index.html`, `style.css`, `app.js`.

### Core Data Model (`app.js`)

```js
state = {
  nodes: [{
    id, name, lat, lng,
    arms: [{ bearing, label }],      // N approach arms, bearing in degrees (0=N, 90=E…)
    plan: {
      cycle,                         // derived: sum of all phase durations
      offset,                        // shifts phase start relative to sim time
      phases: [
        { green, yellow, allRed,     // seconds for each sub-interval
          movements: [{ thru, left, right }]  // one entry per arm, index-aligned to arms[]
        }
      ]
    }
  }]
}
```

Each node is a signalized intersection modeled with **N arms** (the "Option C" n-arm model that replaced the old fixed EB/WB/NB/SB 4-direction model). `arms` lists each approach with a compass `bearing` and a `label`. A `plan` has a variable number of `phases`; each phase runs `green` → `yellow` → `allRed` seconds, and `cycle` is the sum of all phase durations. Each phase's `movements` array is index-aligned with `arms`, each entry holding `{ thru, left, right }` booleans for allowed turns on that arm.

Factory helpers: `defaultArms()` (4 arms EB/WB/NB/SB), `defaultMovements(n)`, `defaultPhase()`, `defaultPlan(n)`.

Runtime objects:
- `markers` — `{ [nodeId]: L.Marker }` — Leaflet marker for each intersection
- `lastIconState` — `{ [nodeId]: stateKey }` — caches last rendered icon to skip redundant `setIcon` DOM swaps
- `tsdPhaseSelection` — `{ [nodeId]: number[] }` — which phases each node shows in the time-space diagram (multi-select)
- `tsdTimeOffset` — time-space diagram scrub offset in seconds (0 = follow sim, negative = look back, min −600)
- Green-band state: `gbEnabled`, `gbSpeed` (km/h), `gbDirection` (`'EB'`/`'WB'`), `gbSelectedIds`

### Interaction Modes

`mode` is a string: `'ADD_NODE'` | `'SELECT'`. Map clicks are gated on the current mode. Markers are draggable to reposition nodes.

### Intersection Editor

`openEditor(node)` opens the side panel. `renderArmsEditor` lets you add/remove arms and set each arm's bearing/label (arms array and every phase's `movements` are kept length-synced). `renderPhaseEditor` / `createPhaseBlock` let you add, remove, and reorder phases and toggle per-arm thru/left/right movements. `deleteNode(nodeId)` removes a node and its marker. `applyPlan` (`#btn-save-plan`) commits edits back to `state`.

### Conflict Detection (`detectConflicts`)

For a phase's movements, `detectConflicts` geometrically tests whether enabled movement paths cross (`segmentsIntersect`, `getMovementSegment`, `findExitArm`, `armEndpoints`). Used to warn of conflicting movements within a phase (`validateAndShowConflicts`).

### Signal Engine (`updateSignals`)

Called each simulation tick and after plan edits. For each node computes `localTime = ((simulationTime - offset) % cycle + cycle) % cycle`, then `getDetailedPhaseInfo` resolves the active phase and sub-interval (green/yellow/allRed). `buildSignalSVG` renders the marker as an SVG icon: a red circle for all-red, or directional green/yellow arrows drawn from each arm's geometry for the active phase.

### Time-Space Diagram (`updateTimeSpaceDiagram`)

Canvas-rendered (`#ts-canvas`). Intersections sorted by longitude on the Y-axis; X-axis is a 240-second sliding window. Each pixel column is colored by evaluating signal state (`getPhaseColorForDisplay`, honoring `tsdPhaseSelection`). Node spacing uses cumulative distance from `getVisibleChain`: segment lengths come from the user-entered `tsdSegDist` (`{ [segKey]: m }`, key = the two node ids sorted, so it survives reversing the sort; edited in ③ via `buildSegmentRow`), else — when hidden nodes lie between two visible nodes and every sub-segment was entered — their sum, else the straight-line `haversineM` between the two visible nodes (`segmentLength`). The same distances drive green-band travel times. Supports drag-to-scroll with momentum (`tsdDragStart/Move/End`, `startTsdMomentum`) and look-back scrubbing via `tsdTimeOffset`. An arterial **green band** overlay (`computeGreenBands` / `drawGreenBands`) visualizes progression at `gbSpeed` in `gbDirection` across selected nodes.

### Save / Load

`#btn-save`: when `server.py` is available (`saveApi`) and a catalog project is loaded, it writes back to `projects/` (`saveToCatalog`): `project.json` gets only node geometry `{ id, name, lat, lng, arms }`, and the current plan's `plans/<planId>.json` gets timing + `tsdPresets` (`buildTimingPlansData`). A project with no plans keeps timing and `tsdPresets` in `project.json`. Otherwise it downloads the full `state`. `#btn-save-as-plan`（＋ 另存新方案, server only) writes a new plan file and registers it in `index.json`. **Unsaved changes** are detected by snapshot comparison (`snapshotState` of `nodes` + `tsdPresets` vs. `savedSnapshot`, polled every second by `updateSaveUI` → `#btn-save.dirty`); switching project/plan, opening a local file, and closing the tab ask for confirmation (`confirmDiscard`, `beforeunload`).

`#file-load` reads a JSON file, clears all markers, and rebuilds the map. On load it **migrates older formats**: nodes without `arms` get default arms (`migratePlan` upgrades the oldest `p1Green/p1Dirs` plans; `migrateMovements` converts old `{ebThru,…}` movement objects to the per-arm array); nodes without `plan` get `defaultPlan`; legacy `links` and `node.bearing` are dropped. After load the map auto-fits to node bounds.

The TSD panel keeps multiple named **arterial presets** in `state.tsdPresets = [{ id, name, hiddenIds, phaseSelection, segDist, sortMode, gbEnabled, gbDirection, gbSpeed }]`, holding only the currently loaded plan's presets (they are stored in that plan file). After a load / plan switch the first preset is applied (`applyPresetForCurrentPlan`; none → defaults). Legacy formats: a single `state.tsdSettings` becomes a preset named「預設」; presets in `project.json` carrying a `planId` are used for that plan when its plan file has no `tsdPresets`. 📥 匯入 applies a timing file to the *current* plan (including its `tsdPresets` if present); 📤 匯出 includes `tsdPresets`.

### Project / Plan Catalog

Shared projects live under `projects/`: `projects/index.json` lists `{ id, name, plans: [{ id, name }] }`; each project has `projects/<id>/project.json` (node geometry; timing only when the project has no plans) and `projects/<id>/plans/<planId>.json` (`{ type: 'timing-plans', savedAt, plans: { [nodeId]: { arms, plan } }, tsdPresets }`). Timing has a single source: when a project has plans, `#select-plan` lists only those (default = first plan); 「專案內建時制」 appears only for projects without plans. On startup the sidebar selects (`#select-project`, `#select-plan`) are filled from the catalog and `?project=<id>&plan=<planId>` picks what to load (`loadFromCatalog`; each switch re-fetches `project.json` then applies the plan via `applyTimingPlans`). The URL is kept in sync with `history.replaceState`, so the address bar is always a shareable link. Loading a local file clears the selection/URL; a failed load or a cancelled switch restores the selects (`restoreSelects`).
