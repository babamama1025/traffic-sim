# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step is required. Open `index.html` directly in a browser, or serve with any static file server:

```
npx serve .
# or
python -m http.server 8080
```

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
  }],
  links: [{ from, to }]  // node IDs
}
```

Each node is a signalized intersection modeled with **N arms** (the "Option C" n-arm model that replaced the old fixed EB/WB/NB/SB 4-direction model). `arms` lists each approach with a compass `bearing` and a `label`. A `plan` has a variable number of `phases`; each phase runs `green` → `yellow` → `allRed` seconds, and `cycle` is the sum of all phase durations. Each phase's `movements` array is index-aligned with `arms`, each entry holding `{ thru, left, right }` booleans for allowed turns on that arm.

Factory helpers: `defaultArms()` (4 arms EB/WB/NB/SB), `defaultMovements(n)`, `defaultPhase()`, `defaultPlan(n)`.

Runtime objects:
- `markers` — `{ [nodeId]: L.Marker }` — Leaflet marker for each intersection
- `polylines` — `L.Polyline[]` — rendered road links
- `lastIconState` — `{ [nodeId]: stateKey }` — caches last rendered icon to skip redundant `setIcon` DOM swaps
- `tsdPhaseSelection` — `{ [nodeId]: number[] }` — which phases each node shows in the time-space diagram (multi-select)
- `tsdTimeOffset` — time-space diagram scrub offset in seconds (0 = follow sim, negative = look back, min −600)
- Green-band state: `gbEnabled`, `gbSpeed` (km/h), `gbDirection` (`'EB'`/`'WB'`), `gbSelectedIds`

### Interaction Modes

`mode` is a string: `'ADD_NODE'` | `'ADD_LINK'` | `'SELECT'`. Map clicks and marker clicks are gated on the current mode. `linkStartNode` holds the first selected node when building a link. Markers are draggable to reposition nodes.

### Intersection Editor

`openEditor(node)` opens the side panel. `renderArmsEditor` lets you add/remove arms and set each arm's bearing/label (arms array and every phase's `movements` are kept length-synced). `renderPhaseEditor` / `createPhaseBlock` let you add, remove, and reorder phases and toggle per-arm thru/left/right movements. `deleteNode(nodeId)` removes a node, its connected links, and its marker. `applyPlan` (`#btn-save-plan`) commits edits back to `state`.

### Conflict Detection (`detectConflicts`)

For a phase's movements, `detectConflicts` geometrically tests whether enabled movement paths cross (`segmentsIntersect`, `getMovementSegment`, `findExitArm`, `armEndpoints`). Used to warn of conflicting movements within a phase (`validateAndShowConflicts`).

### Signal Engine (`updateSignals`)

Called each simulation tick and after plan edits. For each node computes `localTime = ((simulationTime - offset) % cycle + cycle) % cycle`, then `getDetailedPhaseInfo` resolves the active phase and sub-interval (green/yellow/allRed). `buildSignalSVG` renders the marker as an SVG icon: a red circle for all-red, or directional green/yellow arrows drawn from each arm's geometry for the active phase.

### Time-Space Diagram (`updateTimeSpaceDiagram`)

Canvas-rendered (`#ts-canvas`). Intersections sorted by longitude on the Y-axis; X-axis is a 240-second sliding window. Each pixel column is colored by evaluating signal state (`getPhaseColorForDisplay`, honoring `tsdPhaseSelection`). Supports drag-to-scroll with momentum (`tsdDragStart/Move/End`, `startTsdMomentum`) and look-back scrubbing via `tsdTimeOffset`. An arterial **green band** overlay (`computeGreenBands` / `drawGreenBands`) visualizes progression at `gbSpeed` in `gbDirection` across selected nodes.

### Save / Load

`#btn-save` serializes `state` as JSON and triggers a download. `#file-load` reads a JSON file, clears all markers/polylines, and rebuilds the map. On load it **migrates older formats**: nodes without `arms` get default arms (`migratePlan` upgrades the oldest `p1Green/p1Dirs` plans; `migrateMovements` converts old `{ebThru,…}` movement objects to the per-arm array). After load the map auto-fits to node bounds.
