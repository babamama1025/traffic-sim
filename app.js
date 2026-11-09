// 初始化地圖
const map = L.map('map').setView([24.960, 121.225], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012'
}).addTo(map);

// 系統核心狀態
let state = { nodes: [] };
let mode = 'SELECT';
let selectedNodeId = null;
let currentPopup = null;
let justClosedPopup = false;
let markers = {};
let lastIconState = {}; // { [nodeId]: stateKey } — 避免無謂的 setIcon DOM 替換
let tsdPhaseSelection = {}; // { [nodeId]: number[] } — 時空圖各路口顯示時相（可多選）
let tsdTimeOffset = 0;      // 時空圖時間偏移（秒）；0 = 跟隨模擬，負值 = 回顧過去（最多 -600）
let tsdSortMode   = 'WE';        // 時空圖路口排序：'WE' 西→東 | 'EW' 東→西 | 'SN' 南→北 | 'NS' 北→南
let gbEnabled     = false;
let gbSpeed       = 40;          // 設計速率 (km/h)
let gbDirection   = 'FWD';       // 'FWD' 順排序方向 | 'REV' 逆排序方向
let tsdHiddenIds  = new Set();   // 使用者手動從時空圖隱藏的路口 id
let tsdSegDist    = {};          // { [segKey]: 公尺 } 使用者輸入的路段長度，未輸入的路段用直線距離

// 模擬與時間變數
let simulationTime = 0;
let simMaxTime = 0;      // 已模擬到的最遠時間（時間軸可回溯的上限）
let simInterval = null;
let simSpeed = 1;
let simStarted = false; // true after play pressed, false after reset
const clockEl = document.getElementById('clock');
const simTimeline = document.getElementById('sim-timeline');
const timelineLabel = document.getElementById('timeline-label');

function updateTimelineUI() {
    simTimeline.max = simMaxTime;
    simTimeline.value = simulationTime;
    timelineLabel.textContent = `${simulationTime} / ${simMaxTime} 秒`;
}

// 時空圖 Canvas
const canvas = document.getElementById('ts-canvas');
const ctx = canvas.getContext('2d');
const tsdScrollbar = document.getElementById('tsd-scrollbar');
const tsdScrollInner = document.getElementById('tsd-scroll-inner');
tsdScrollbar.addEventListener('scroll', () => updateTimeSpaceDiagram());
document.getElementById('tsd-canvas-wrap').addEventListener('wheel', (e) => {
    e.preventDefault();
    tsdScrollbar.scrollTop += e.deltaY;
}, { passive: false });

// ── TSD 拖曳捲動時間軸（含慣性）─────────────────────────────────────────────
let tsdDragStartX    = null;
let tsdDragStartOffset = null;
let tsdLastMoveX     = null;
let tsdLastMoveTime  = null;
let tsdVelocity      = 0;     // 秒/毫秒，正 = 往後，負 = 往前
let tsdMomentumRAF   = null;
const TSD_FRICTION   = 0.95;  // 每 16ms 保留的速度比例
const TSD_STOP_THRESHOLD = 0.0003; // 秒/毫秒，低於此值停止慣性

function tsdSecondsPerPixel() {
    return 240 / (canvas.width - 72 - 20);
}

function applyTsdOffset(newOffset) {
    const clamped = Math.min(0, Math.max(-600, newOffset));
    tsdTimeOffset = clamped;
    updateTimeSpaceDiagram();
    return clamped === newOffset; // false = 碰到邊界
}

function startTsdMomentum() {
    if (tsdMomentumRAF) cancelAnimationFrame(tsdMomentumRAF);
    let lastTime = performance.now();
    function step(now) {
        const dt = Math.min(now - lastTime, 50);
        lastTime = now;
        tsdVelocity *= Math.pow(TSD_FRICTION, dt / 16);
        if (Math.abs(tsdVelocity) < TSD_STOP_THRESHOLD) {
            tsdMomentumRAF = null;
            return;
        }
        const withinBounds = applyTsdOffset(tsdTimeOffset + tsdVelocity * dt);
        if (!withinBounds) { tsdMomentumRAF = null; return; }
        tsdMomentumRAF = requestAnimationFrame(step);
    }
    tsdMomentumRAF = requestAnimationFrame(step);
}

function tsdDragStart(clientX) {
    if (tsdMomentumRAF) { cancelAnimationFrame(tsdMomentumRAF); tsdMomentumRAF = null; }
    tsdDragStartX     = clientX;
    tsdDragStartOffset = tsdTimeOffset;
    tsdLastMoveX      = clientX;
    tsdLastMoveTime   = performance.now();
    tsdVelocity       = 0;
}

function tsdDragMove(clientX) {
    if (tsdDragStartX === null) return;
    const spp = tsdSecondsPerPixel();
    applyTsdOffset(tsdDragStartOffset - (clientX - tsdDragStartX) * spp);

    // 追蹤即時速度（EMA 平滑）
    const now = performance.now();
    const dt  = now - tsdLastMoveTime;
    if (dt > 0) {
        const instant = -(clientX - tsdLastMoveX) * spp / dt;
        tsdVelocity = tsdVelocity * 0.5 + instant * 0.5;
    }
    tsdLastMoveX   = clientX;
    tsdLastMoveTime = now;
}

function tsdDragEnd() {
    if (tsdDragStartX === null) return;
    tsdDragStartX = null;
    canvas.style.cursor = 'grab';
    if (Math.abs(tsdVelocity) > TSD_STOP_THRESHOLD * 5) startTsdMomentum();
}

canvas.style.cursor = 'grab';
canvas.addEventListener('mousedown',  (e) => { tsdDragStart(e.clientX); canvas.style.cursor = 'grabbing'; });
window.addEventListener('mousemove',  (e) => { tsdDragMove(e.clientX); });
window.addEventListener('mouseup',    ()  => { tsdDragEnd(); });
canvas.addEventListener('touchstart', (e) => { tsdDragStart(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove',  (e) => { tsdDragMove(e.touches[0].clientX);  e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend',   ()  => { tsdDragEnd(); });

// ─── 幾何工具與衝突偵測 ─────────────────────────────────────────────────────

// 回傳臂在 40×40 SVG 座標系（圓心 20,20）中的端點與方向向量
// 方位角 bearing：順時針自北，0=北, 90=東, 180=南, 270=西
function armEndpoints(bearing, re = 16) {
    const rad = bearing * Math.PI / 180;
    const s = Math.sin(rad), c = Math.cos(rad);
    return {
        entry:     { x: 20 - re * s, y: 20 + re * c },  // 進入端（來車方向）
        thruExit:  { x: 20 + re * s, y: 20 - re * c },  // 直行出口
        leftExit:  { x: 20 - re * c, y: 20 - re * s },  // 左轉出口
        rightExit: { x: 20 + re * c, y: 20 + re * s },  // 右轉出口
        thruDir:   { x: s,  y: -c },   // 直行方向向量
        leftDir:   { x: -c, y: -s },   // 左轉方向向量
        rightDir:  { x: c,  y: s  },   // 右轉方向向量
    };
}

function f(n) { return n.toFixed(1); }

// SVG 箭頭頂端 V 形，回傳可直接接在 path d 後的片段
function svgArrow(tx, ty, dx, dy, ws = 4) {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return '';
    dx /= len; dy /= len;
    return `M ${f(tx - dx * ws - dy * ws * 0.6)},${f(ty - dy * ws + dx * ws * 0.6)} L ${f(tx)},${f(ty)} L ${f(tx - dx * ws + dy * ws * 0.6)},${f(ty - dy * ws - dx * ws * 0.6)}`;
}

// 線段相交判斷（兩端保留 5% 不計，避免共端點誤報）
function segmentsIntersect(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / cross;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / cross;
    return t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95;
}

// 找 bearing 最接近 targetBearing 的臂（排除 fromIdx 自身）
function findExitArm(fromIdx, targetBearing, arms) {
    let bestIdx = -1, bestDiff = Infinity;
    arms.forEach((arm, j) => {
        if (j === fromIdx) return;
        const d = Math.abs(((arm.bearing - targetBearing + 540) % 360) - 180);
        if (d < bestDiff) { bestDiff = d; bestIdx = j; }
    });
    return bestIdx;
}

// 偵測時相內衝突（直行 + 左轉；右轉為讓行不列入）
function detectConflicts(arms, movements) {
    if (!arms || !movements) return [];
    const list = [];
    arms.forEach((arm, i) => {
        const m = movements[i];
        if (!m) return;
        if (m.thru) list.push({ arm, i, type: 'thru', label: `${arm.label} 直行` });
        if (m.left) list.push({ arm, i, type: 'left', label: `${arm.label} 左轉` });
    });
    const out = [];
    const OPPOSING_TOL = 10; // 度，方位角相差 180°±此值視為對向直行，不算衝突
    for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
            if (list[a].i === list[b].i) continue;
            if (list[a].type === 'thru' && list[b].type === 'thru') {
                const diff = Math.abs(((list[a].arm.bearing - list[b].arm.bearing + 540) % 360) - 180);
                if (diff <= OPPOSING_TOL) continue;
            }
            const sa = getMovementSegment(list[a].arm, list[a].type, list[a].i, arms);
            const sb = getMovementSegment(list[b].arm, list[b].type, list[b].i, arms);
            if (segmentsIntersect(sa.p1, sa.p2, sb.p1, sb.p2))
                out.push(`${list[a].label} ✕ ${list[b].label}`);
        }
    return out;
}

function getMovementSegment(arm, turnType, armIdx, arms) {
    const r = 13;
    const ep = armEndpoints(arm.bearing, r);
    let exitPt;
    if (turnType === 'thru') {
        exitPt = ep.thruExit;
    } else { // left（右轉不進入衝突偵測）
        const targetBearing = ((arm.bearing - 90) + 360) % 360;
        const exitIdx = (armIdx != null && arms) ? findExitArm(armIdx, targetBearing, arms) : -1;
        exitPt = exitIdx >= 0 ? armEndpoints(arms[exitIdx].bearing, r).thruExit : ep.leftExit;
    }
    return { p1: ep.entry, p2: exitPt };
}

// ─── 資料模型工廠 ────────────────────────────────────────────────────────────

function defaultArms() {
    return [
        { bearing: 90,  label: 'EB' },
        { bearing: 270, label: 'WB' },
        { bearing: 0,   label: 'NB' },
        { bearing: 180, label: 'SB' },
    ];
}

function defaultMovements(numArms = 4) {
    return Array.from({ length: numArms }, () => ({ thru: false, left: false, right: false }));
}

function defaultPhase(green = 45, yellow = 3, allRed = 1, numArms = 4) {
    return { green, yellow, allRed, movements: defaultMovements(numArms) };
}

function defaultPlan(numArms = 4) {
    const p1 = defaultPhase(45, 3, 1, numArms);
    if (numArms >= 1) p1.movements[0].thru = true;  // EB
    if (numArms >= 2) p1.movements[1].thru = true;  // WB
    const p2 = defaultPhase(45, 3, 1, numArms);
    if (numArms >= 3) p2.movements[2].thru = true;  // NB
    if (numArms >= 4) p2.movements[3].thru = true;  // SB
    const phases = [p1, p2];
    return { cycle: phases.reduce((s, p) => s + p.green + p.yellow + p.allRed, 0), offset: 0, phases };
}

// 舊版 movements 物件（ebThru/wbLeft/…）轉為新版陣列格式
// 假設臂順序為 [EB, WB, NB, SB]（defaultArms 預設順序）
function migrateMovements(old, numArms) {
    const arr = defaultMovements(numArms);
    if (!old) return arr;
    if (numArms >= 1) arr[0] = { thru: !!old.ebThru, left: !!old.ebLeft, right: !!old.ebRight };
    if (numArms >= 2) arr[1] = { thru: !!old.wbThru, left: !!old.wbLeft, right: !!old.wbRight };
    if (numArms >= 3) arr[2] = { thru: !!old.nbThru, left: !!old.nbLeft, right: !!old.nbRight };
    if (numArms >= 4) arr[3] = { thru: !!old.sbThru, left: !!old.sbLeft, right: !!old.sbRight };
    return arr;
}

// 最舊格式（p1Green/p2Green/p1Dirs）轉換
function migratePlan(old, numArms = 4) {
    const p1 = defaultPhase(old.p1Green || 45, 3, 1, numArms);
    const p2 = defaultPhase(old.p2Green || 45, 3, 1, numArms);
    if (old.p1Dirs) {
        if (old.p1Dirs.thruEW) { if (numArms >= 1) p1.movements[0].thru = true; if (numArms >= 2) p1.movements[1].thru = true; }
        if (old.p1Dirs.thruNS) { if (numArms >= 3) p1.movements[2].thru = true; if (numArms >= 4) p1.movements[3].thru = true; }
        if (old.p1Dirs.leftEW) { if (numArms >= 1) p1.movements[0].left = true;  if (numArms >= 2) p1.movements[1].left = true; }
        if (old.p1Dirs.leftNS) { if (numArms >= 3) p1.movements[2].left = true;  if (numArms >= 4) p1.movements[3].left = true; }
    }
    if (old.p2Dirs) {
        if (old.p2Dirs.thruEW) { if (numArms >= 1) p2.movements[0].thru = true; if (numArms >= 2) p2.movements[1].thru = true; }
        if (old.p2Dirs.thruNS) { if (numArms >= 3) p2.movements[2].thru = true; if (numArms >= 4) p2.movements[3].thru = true; }
        if (old.p2Dirs.leftEW) { if (numArms >= 1) p2.movements[0].left = true;  if (numArms >= 2) p2.movements[1].left = true; }
        if (old.p2Dirs.leftNS) { if (numArms >= 3) p2.movements[2].left = true;  if (numArms >= 4) p2.movements[3].left = true; }
    }
    return { cycle: old.cycle || 98, offset: old.offset || 0, phases: [p1, p2] };
}

// ─── UI 模式切換 ─────────────────────────────────────────────────────────────

document.getElementById('btn-add-node').onclick = (e) => setMode('ADD_NODE', e.target);
document.getElementById('btn-select').onclick = (e) => setMode('SELECT', e.target);

function setMode(newMode, btnEl) {
    mode = newMode;
    selectedNodeId = null;
    map.closePopup();
    document.querySelectorAll('.segmented button').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    document.getElementById('editor-panel').style.display = 'none';
}

// ─── 建立路口 ────────────────────────────────────────────────────────────────

map.on('click', function(e) {
    if (mode === 'ADD_NODE' && !justClosedPopup) {
        const id = 'N_' + Date.now().toString().slice(-4);
        const arms = defaultArms();
        const nodeData = { id, name: '', lat: e.latlng.lat, lng: e.latlng.lng, arms, plan: defaultPlan(arms.length) };
        state.nodes.push(nodeData);
        drawNode(nodeData);
        updateSignals();
        rebuildTsdControls();
        updateTimeSpaceDiagram();
    }
});

function drawNode(nodeData) {
    const icon = L.divIcon({
        className: 'intersection-icon',
        html: `<svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="14" fill="#dc3545"/></svg>`,
        iconSize: [44, 44],
    });
    const marker = L.marker([nodeData.lat, nodeData.lng], { icon, draggable: true }).addTo(map);
    markers[nodeData.id] = marker;
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectNode(nodeData);
    });
    marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        nodeData.lat = lat;
        nodeData.lng = lng;
        lastFlowKey = {}; // 位置改變影響自身與鄰近路口的臂長
        updateSignals();
        updateTimeSpaceDiagram();
    });
}

function selectNode(node) {
    selectedNodeId = node.id;
    updateSignals();
    updateNodeStatusPanel();
    if (document.getElementById('editor-panel').style.display !== 'none') {
        openEditor(node);
    }
    const marker = markers[node.id];
    const latlng = marker ? marker.getLatLng() : [node.lat, node.lng];
    const actionBtns = simInterval
        ? ''
        : `<button class="nap-btn nap-btn-edit" id="nap-edit">編輯路口屬性</button>
           <button class="nap-btn nap-btn-danger" id="nap-delete">刪除路口</button>`;
    const popup = L.popup({ closeButton: false, className: 'node-popup', offset: [0, -22] })
        .setLatLng(latlng)
        .setContent(`
            <div class="node-action-popup">
                <div class="nap-id">${node.name ? node.name : node.id}</div>
                ${actionBtns}
            </div>
        `);
    currentPopup = popup;
    popup.openOn(map);
}

// ─── 時制計畫編輯器 ──────────────────────────────────────────────────────────

let editingNodeId = null;

function openEditor(node) {
    editingNodeId = node.id;
    document.getElementById('editor-panel').style.display = 'block';
    document.getElementById('input-node-id').value = node.id;
    document.getElementById('input-node-name').value = node.name || '';
    document.getElementById('input-offset').value = node.plan.offset;
    renderArmsEditor(node);
    renderPhaseEditor(node.plan);

    document.getElementById('btn-add-arm').onclick = () => {
        const n = state.nodes.find(n => n.id === editingNodeId);
        if (!n) return;
        n.arms.push({ bearing: 0, label: `臂${n.arms.length + 1}` });
        n.plan.phases.forEach(ph => ph.movements.push({ thru: false, left: false, right: false }));
        renderArmsEditor(n);
        renderPhaseEditor(n.plan);
    };

    // 刪除路口
    document.getElementById('btn-delete-node').onclick = () => {
        if (confirm(`確定要刪除路口 ${node.id}？此操作無法復原。`)) deleteNode(node.id);
    };
}

function renderArmsEditor(node) {
    const container = document.getElementById('arms-container');
    container.innerHTML = '';
    const arms = node.arms || [];
    arms.forEach((arm, i) => {
        const row = document.createElement('div');
        row.className = 'arm-row';

        const numSpan = document.createElement('span');
        numSpan.className = 'arm-num';
        numSpan.textContent = `#${i + 1}`;
        row.appendChild(numSpan);

        const bearingInput = document.createElement('input');
        bearingInput.type = 'number';
        bearingInput.className = 'arm-bearing';
        bearingInput.value = arm.bearing;
        bearingInput.min = 0; bearingInput.max = 359; bearingInput.step = 1;
        bearingInput.title = '方位角（0=北,90=東,180=南,270=西）';
        bearingInput.addEventListener('input', () => {
            const raw = parseInt(bearingInput.value);
            arm.bearing = isNaN(raw) ? 0 : ((raw % 360) + 360) % 360;
            updateSignals();
            refreshAllPhasePreviews();
        });
        row.appendChild(bearingInput);

        const degSpan = document.createElement('span');
        degSpan.textContent = '°';
        row.appendChild(degSpan);

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'arm-label';
        labelInput.value = arm.label;
        labelInput.maxLength = 6;
        labelInput.placeholder = 'EB';
        labelInput.addEventListener('input', () => {
            arm.label = labelInput.value.trim() || `臂${i + 1}`;
            renderPhaseEditor(node.plan);
        });
        row.appendChild(labelInput);

        if (arms.length > 2) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-del-arm';
            delBtn.textContent = '✕';
            delBtn.title = '刪除此臂';
            delBtn.addEventListener('click', () => {
                node.arms.splice(i, 1);
                node.plan.phases.forEach(ph => ph.movements.splice(i, 1));
                renderArmsEditor(node);
                renderPhaseEditor(node.plan);
                updateSignals();
            });
            row.appendChild(delBtn);
        }
        container.appendChild(row);
    });
}

function deleteNode(nodeId) {
    if (markers[nodeId]) { map.removeLayer(markers[nodeId]); delete markers[nodeId]; }
    delete lastIconState[nodeId];
    clearNodeFlow(nodeId);
    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    editingNodeId = null;
    selectedNodeId = null;
    currentPopup = null;
    document.getElementById('editor-panel').style.display = 'none';
    rebuildTsdControls();
    updateTimeSpaceDiagram();
}

function refreshAllPhasePreviews() {
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (!node) return;
    const arms = node.arms || defaultArms();
    document.querySelectorAll('.phase-block').forEach((div, idx) => {
        const phase = node.plan.phases[idx];
        if (!phase) return;
        const previewEl = div.querySelector('.phase-preview');
        if (previewEl) previewEl.innerHTML = buildSignalSVG('green', phase.movements, arms, false, idx);
    });
}

function renderPhaseEditor(plan) {
    const container = document.getElementById('phases-container');
    container.innerHTML = '';
    plan.phases.forEach((phase, idx) => {
        container.appendChild(createPhaseBlock(phase, idx, plan.phases.length));
    });
    refreshCycleDisplay(plan);
}

function refreshCycleDisplay(plan) {
    plan.cycle = plan.phases.reduce((s, p) => s + p.green + p.yellow + p.allRed, 0);
    document.getElementById('display-cycle').textContent = plan.cycle + ' 秒';
}

function createPhaseBlock(phase, idx, totalPhases) {
    const node = state.nodes.find(n => n.id === editingNodeId);
    const arms = node ? (node.arms || defaultArms()) : defaultArms();

    // 確保 movements 陣列長度與 arms 一致
    while (phase.movements.length < arms.length)
        phase.movements.push({ thru: false, left: false, right: false });
    phase.movements.length = arms.length;

    const div = document.createElement('div');
    div.className = 'phase-block';
    div.dataset.phaseIdx = idx;

    const upBtn   = idx > 0              ? `<button class="btn-phase-move" data-dir="-1" title="上移">↑</button>` : '';
    const downBtn = idx < totalPhases - 1 ? `<button class="btn-phase-move" data-dir="1"  title="下移">↓</button>` : '';
    const delBtn  = totalPhases > 1       ? `<button class="btn-del-phase">✕</button>` : '';

    div.innerHTML = `
        <div class="phase-header">
            <strong>時相 ${idx + 1}</strong>
            <div class="phase-header-btns">${upBtn}${downBtn}${delBtn}</div>
        </div>
        <div class="phase-timing">
            <label>綠燈 <input type="number" class="phase-input" data-field="green" value="${phase.green}" min="5" max="240"> 秒</label>
            <label>黃燈 <input type="number" class="phase-input" data-field="yellow" value="${phase.yellow}" min="2" max="6"> 秒</label>
            <label>全紅 <input type="number" class="phase-input" data-field="allRed" value="${phase.allRed}" min="0" max="5"> 秒</label>
            <span class="phase-total">= <strong class="phase-duration">${phase.green + phase.yellow + phase.allRed}</strong> 秒</span>
        </div>
        <table class="movement-table">
            <thead><tr><th>進向</th><th>直行</th><th>左轉</th><th>右轉</th></tr></thead>
            <tbody></tbody>
        </table>
        <div class="phase-preview"></div>
        <div class="conflict-warning" style="display:none;"></div>
    `;

    const tbody = div.querySelector('tbody');
    arms.forEach((arm, i) => {
        const m = phase.movements[i] || { thru: false, left: false, right: false };
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="mov-arm-label">${arm.label}</td>` +
            ['thru', 'left', 'right'].map(turn =>
                `<td><input type="checkbox" class="mov-cb" data-arm="${i}" data-turn="${turn}" ${m[turn] ? 'checked' : ''}></td>`
            ).join('');
        tbody.appendChild(tr);
    });

    const previewEl = div.querySelector('.phase-preview');
    function refreshPreview() {
        previewEl.innerHTML = buildSignalSVG('green', phase.movements, arms, false, idx);
    }
    refreshPreview();

    div.querySelectorAll('.phase-input').forEach(input => {
        input.addEventListener('input', () => {
            const g  = parseInt(div.querySelector('[data-field="green"]').value)  || 0;
            const y  = parseInt(div.querySelector('[data-field="yellow"]').value) || 0;
            const ar = parseInt(div.querySelector('[data-field="allRed"]').value) || 0;
            div.querySelector('.phase-duration').innerText = g + y + ar;
            syncPhaseFromDOM();
        });
    });

    div.querySelectorAll('.mov-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            syncPhaseFromDOM();
            validateAndShowConflicts();
            refreshPreview();
        });
    });

    div.querySelectorAll('.btn-phase-move').forEach(btn => {
        btn.addEventListener('click', () => {
            syncPhaseFromDOM();
            const nd = state.nodes.find(n => n.id === editingNodeId);
            if (!nd) return;
            const toIdx = idx + parseInt(btn.dataset.dir);
            if (toIdx < 0 || toIdx >= nd.plan.phases.length) return;
            [nd.plan.phases[idx], nd.plan.phases[toIdx]] = [nd.plan.phases[toIdx], nd.plan.phases[idx]];
            renderPhaseEditor(nd.plan);
        });
    });

    const delEl = div.querySelector('.btn-del-phase');
    if (delEl) {
        delEl.addEventListener('click', () => {
            syncPhaseFromDOM();
            const nd = state.nodes.find(n => n.id === editingNodeId);
            if (nd) {
                nd.plan.phases.splice(idx, 1);
                renderPhaseEditor(nd.plan);
            }
        });
    }

    return div;
}

// 將 DOM 目前狀態同步回 node.plan，並自動重算週期
function syncPhaseFromDOM() {
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (!node) return;

    // 路口編號變更
    const newId = document.getElementById('input-node-id').value.trim();
    if (newId && newId !== node.id) {
        if (state.nodes.some(n => n.id === newId)) {
            alert(`路口編號「${newId}」已存在，請使用其他編號。`);
            document.getElementById('input-node-id').value = node.id;
        } else {
            markers[newId] = markers[node.id];
            delete markers[node.id];
            node.id = newId;
            editingNodeId = newId;
        }
    }

    node.name = document.getElementById('input-node-name').value.trim();
    node.plan.offset = parseInt(document.getElementById('input-offset').value) || 0;

    document.querySelectorAll('.phase-block').forEach((div, idx) => {
        const phase = node.plan.phases[idx];
        if (!phase) return;
        phase.green  = parseInt(div.querySelector('[data-field="green"]').value)  || 0;
        phase.yellow = parseInt(div.querySelector('[data-field="yellow"]').value) || 0;
        phase.allRed = parseInt(div.querySelector('[data-field="allRed"]').value) || 0;
        div.querySelectorAll('.mov-cb').forEach(cb => {
            const ai = parseInt(cb.dataset.arm);
            const turn = cb.dataset.turn;
            if (!phase.movements[ai]) phase.movements[ai] = { thru: false, left: false, right: false };
            phase.movements[ai][turn] = cb.checked;
        });
    });
    refreshCycleDisplay(node.plan);
}

// 衝突驗證：在各時相區塊顯示警告，回傳是否有衝突
function validateAndShowConflicts() {
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (!node) return true;
    let hasConflict = false;
    document.querySelectorAll('.phase-block').forEach((div, idx) => {
        const phase = node.plan.phases[idx];
        if (!phase) return;
        const conflicts = detectConflicts(node.arms, phase.movements);
        const warnEl = div.querySelector('.conflict-warning');
        if (conflicts.length > 0) {
            hasConflict = true;
            warnEl.style.display = 'block';
            warnEl.innerHTML = `<strong>⚠️ 衝突動線：</strong><br>${conflicts.join('<br>')}`;
        } else {
            warnEl.style.display = 'none';
        }
    });
    return !hasConflict;
}

// 新增時相
document.getElementById('btn-add-phase').onclick = () => {
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (node) {
        node.plan.phases.push(defaultPhase(20, 3, 1, (node.arms || []).length));
        renderPhaseEditor(node.plan);
    }
};

// 套用設定
function applyPlan() {
    syncPhaseFromDOM();
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (!node) return;

    const isClean = validateAndShowConflicts();
    if (!isClean) {
        if (!confirm('存在衝突動線設定，確定仍要套用？')) return;
    }

    updateSignals();
    rebuildTsdControls();
    updateTimeSpaceDiagram();

    const btn = document.getElementById('btn-save-plan');
    btn.textContent = '✅ 已套用';
    setTimeout(() => { btn.textContent = '套用設定'; }, 1500);
}

document.getElementById('btn-save-plan').onclick = applyPlan;

document.getElementById('editor-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        applyPlan();
    }
});

// ─── 號誌狀態計算（含黃燈間隔）────────────────────────────────────────────

function getPhaseAtTime(plan, localTime) {
    let elapsed = 0;
    for (const phase of plan.phases) {
        const duration = phase.green + phase.yellow + phase.allRed;
        if (localTime < elapsed + phase.green) {
            return { sigState: 'green', movements: phase.movements };
        } else if (localTime < elapsed + phase.green + phase.yellow) {
            return { sigState: 'yellow', movements: phase.movements };
        } else if (localTime < elapsed + duration) {
            return { sigState: 'allRed', movements: null };
        }
        elapsed += duration;
    }
    return { sigState: 'allRed', movements: null }; // 週期剩餘未分配時間
}

// 回傳所選時相組（selectedPhases 為排序後的 index 陣列）的號誌顏色。
// 所有被選時相期間（含中間的黃燈/全紅）均顯示綠，只有最後一個被選時相的黃燈/全紅才如實呈現。
function getPhaseColorForDisplay(plan, localTime, selectedPhases) {
    if (!selectedPhases || selectedPhases.length === 0) return 'allRed';
    const lastSelected = selectedPhases[selectedPhases.length - 1];
    let elapsed = 0;
    for (let i = 0; i < plan.phases.length; i++) {
        const ph = plan.phases[i];
        const duration = ph.green + ph.yellow + ph.allRed;
        if (localTime < elapsed + duration) {
            if (!selectedPhases.includes(i)) return 'allRed';
            if (localTime < elapsed + ph.green) return 'green';
            if (i !== lastSelected) return 'green'; // 非最後選中時相：黃燈/全紅仍顯示綠
            if (localTime < elapsed + ph.green + ph.yellow) return 'yellow';
            return 'allRed';
        }
        elapsed += duration;
    }
    return 'allRed';
}

function getDetailedPhaseInfo(plan, localTime) {
    let elapsed = 0;
    for (let i = 0; i < plan.phases.length; i++) {
        const phase = plan.phases[i];
        const phaseDur = phase.green + phase.yellow + phase.allRed;
        if (localTime < elapsed + phase.green) {
            const e = localTime - elapsed;
            return { phaseIndex: i, sigState: 'green', movements: phase.movements,
                     elapsed: Math.floor(e), remaining: phase.green - Math.floor(e) };
        } else if (localTime < elapsed + phase.green + phase.yellow) {
            const e = localTime - elapsed - phase.green;
            return { phaseIndex: i, sigState: 'yellow', movements: phase.movements,
                     elapsed: Math.floor(e), remaining: phase.yellow - Math.floor(e) };
        } else if (localTime < elapsed + phaseDur) {
            const e = localTime - elapsed - phase.green - phase.yellow;
            return { phaseIndex: i, sigState: 'allRed', movements: phase.movements,
                     elapsed: Math.floor(e), remaining: phase.allRed - Math.floor(e) };
        }
        elapsed += phaseDur;
    }
    const e = localTime - elapsed;
    return { phaseIndex: -1, sigState: 'allRed', movements: null,
             elapsed: Math.floor(e), remaining: plan.cycle - Math.floor(localTime) };
}

function updateNodeStatusPanel() {
    const panel = document.getElementById('node-status-panel');
    if (!selectedNodeId) { panel.style.display = 'none'; return; }
    const node = state.nodes.find(n => n.id === selectedNodeId);
    if (!node) { panel.style.display = 'none'; return; }

    const plan = node.plan;
    let localTime = (simulationTime - plan.offset) % plan.cycle;
    if (localTime < 0) localTime += plan.cycle;

    const info = getDetailedPhaseInfo(plan, localTime);
    const stateLabels = { green: '🟢 綠燈', yellow: '🟡 黃燈', allRed: '🔴 全紅' };
    const phaseLabel = info.phaseIndex >= 0 ? `第 ${info.phaseIndex + 1} 時相` : '全紅（未分配）';
    const arms = node.arms || defaultArms();
    const movList = (info.sigState !== 'allRed' && info.movements && Array.isArray(info.movements))
        ? info.movements.flatMap((m, i) => {
            const lbl = arms[i] ? arms[i].label : `臂${i + 1}`;
            const parts = [];
            if (m.thru)  parts.push(`${lbl} 直行`);
            if (m.left)  parts.push(`${lbl} 左轉`);
            if (m.right) parts.push(`${lbl} 右轉`);
            return parts;
        }).join('、')
        : '';

    document.getElementById('node-status-content').innerHTML = `
        <div class="status-row"><span>路口</span><strong class="status-val">${node.name || node.id}</strong></div>
        <div class="status-row"><span>週期</span><span class="status-val">${plan.cycle} 秒</span></div>
        <div class="status-row"><span>時差</span><span class="status-val">${plan.offset} 秒</span></div>
        <div class="status-row"><span>本地時間</span><span class="status-val">${Math.floor(localTime)} / ${plan.cycle} 秒</span></div>
        <div class="status-divider"></div>
        <div class="status-row"><span>當前時相</span><strong class="status-val">${phaseLabel}</strong></div>
        <div class="status-row"><span>號誌狀態</span><strong class="status-val">${stateLabels[info.sigState]}</strong></div>
        <div class="status-row"><span>已執行</span><span class="status-val">${info.elapsed} 秒</span></div>
        <div class="status-row status-highlight"><span>剩餘</span><strong class="status-val">${info.remaining} 秒</strong></div>
        ${movList ? `<div class="status-movements">放行：${movList}</div>` : ''}
    `;
    panel.style.display = 'block';
}

// ─── 動態號誌 SVG 渲染 ───────────────────────────────────────────────────────

function updateSignals() {
    state.nodes.forEach(node => {
        const plan = node.plan;
        let localTime = (simulationTime - plan.offset) % plan.cycle;
        if (localTime < 0) localTime += plan.cycle;
        const { sigState, movements, phaseIndex } = getDetailedPhaseInfo(plan, localTime);
        const isSelected = node.id === selectedNodeId;

        // 只有狀態實際改變時才替換 DOM icon，避免高速模擬下滑鼠事件被中斷
        const movKey = (movements && Array.isArray(movements))
            ? movements.map((m, i) => `${i}:${m.thru ? 't' : ''}${m.left ? 'l' : ''}${m.right ? 'r' : ''}`).join(',')
            : '';
        const armsKey = (node.arms || []).map(a => a.bearing).join(',');
        const stateKey = `${sigState}|${movKey}|${isSelected}|${armsKey}|${phaseIndex}`;
        if (lastIconState[node.id] !== stateKey) {
            lastIconState[node.id] = stateKey;
            const marker = markers[node.id];
            if (marker) marker.setIcon(L.divIcon({
                className: 'intersection-icon',
                html: buildSignalSVG(sigState, movements, node.arms, isSelected, phaseIndex),
                iconSize: [44, 44],
            }));
        }
        updateNodeFlow(node, sigState, movements, `${sigState}|${movKey}|${armsKey}|${node.lat},${node.lng}`);
    });
    updateNodeStatusPanel();
}

function buildSignalSVG(sigState, movements, arms, selected = false, phaseIndex = -1) {
    const selRing = selected
        ? `<circle cx="20" cy="20" r="18" fill="none" stroke="#007bff" stroke-width="2.5" stroke-dasharray="5 2"/>`
        : '';
    const phaseTag = phaseIndex >= 0
        ? `<rect x="26" y="1" width="13" height="13" rx="2.5" fill="#333" opacity="0.82"/>` +
          `<text x="32.5" y="7.5" font-size="11" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="monospace">${phaseIndex + 1}</text>`
        : '';

    if (!movements || !arms) {
        // 無對應時相（如週期未分配時間）：先畫道路線段，再疊紅圈，露出路口形狀
        const armLines = (arms || defaultArms()).map(arm => {
            const ep = armEndpoints(arm.bearing, 18);
            return `<line x1="${f(ep.entry.x)}" y1="${f(ep.entry.y)}" x2="${f(ep.thruExit.x)}" y2="${f(ep.thruExit.y)}" stroke="#888" stroke-width="4" stroke-linecap="round"/>`;
        }).join('');
        return `<svg width="40" height="40" viewBox="0 0 40 40">${armLines}<circle cx="20" cy="20" r="14" fill="#dc3545"/>${selRing}${phaseTag}</svg>`;
    }

    const clr = sigState === 'yellow' ? '#ffc107' : sigState === 'allRed' ? '#dc3545' : '#28a745';
    const bg  = sigState === 'yellow' ? '#fffbe6' : sigState === 'allRed' ? '#fdecea' : 'white';
    const strokeAttrs = `stroke="${clr}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

    let p = `<circle cx="20" cy="20" r="16" fill="none" stroke="${clr}" stroke-width="2.5"/>`;

    arms.forEach((arm, i) => {
        const m = movements[i];
        if (!m) return;
        const ep = armEndpoints(arm.bearing);
        const si = Math.sin(arm.bearing * Math.PI / 180);
        const ci = Math.cos(arm.bearing * Math.PI / 180);
        // 向行進右側偏移，讓對向車道分開
        const ox = ci * 4, oy = si * 4;
        const ex = ep.entry.x + ox, ey = ep.entry.y + oy;

        if (m.thru) {
            const tx = ep.thruExit.x + ox, ty = ep.thruExit.y + oy;
            const arr = svgArrow(tx, ty, ep.thruDir.x, ep.thruDir.y);
            p += `<path d="M ${f(ex)},${f(ey)} L ${f(tx)},${f(ty)} ${arr}" ${strokeAttrs} stroke-width="2.5"/>`;
        }
        if (m.left) {
            const exitIdx = findExitArm(i, ((arm.bearing - 90) + 360) % 360, arms);
            const eep = exitIdx >= 0 ? armEndpoints(arms[exitIdx].bearing) : ep;
            const exitPt = exitIdx >= 0 ? eep.thruExit : ep.leftExit;
            const exitDir = exitIdx >= 0 ? eep.thruDir : ep.leftDir;
            const arr = svgArrow(exitPt.x, exitPt.y, exitDir.x, exitDir.y);
            p += `<path d="M ${f(ex)},${f(ey)} Q 20,20 ${f(exitPt.x)},${f(exitPt.y)} ${arr}" ${strokeAttrs} stroke-width="2"/>`;
        }
        if (m.right) {
            const exitIdx = findExitArm(i, (arm.bearing + 90) % 360, arms);
            const exitBearing = exitIdx >= 0 ? arms[exitIdx].bearing : (arm.bearing + 90) % 360;
            const eep = exitIdx >= 0 ? armEndpoints(exitBearing) : ep;
            const exitPt = exitIdx >= 0 ? eep.thruExit : ep.rightExit;
            const exitDir = exitIdx >= 0 ? eep.thruDir : ep.rightDir;
            // 三次貝茲：沿進臂切線出發，沿出臂切線抵達，形成緊角弧（不穿越圓心）
            const t = 7;
            const sk = Math.sin(exitBearing * Math.PI / 180);
            const ck = Math.cos(exitBearing * Math.PI / 180);
            const cp1x = ex + t * si, cp1y = ey - t * ci;
            const cp2x = exitPt.x - t * sk, cp2y = exitPt.y + t * ck;
            const arr = svgArrow(exitPt.x, exitPt.y, exitDir.x, exitDir.y);
            p += `<path d="M ${f(ex)},${f(ey)} C ${f(cp1x)},${f(cp1y)} ${f(cp2x)},${f(cp2y)} ${f(exitPt.x)},${f(exitPt.y)} ${arr}" ${strokeAttrs} stroke-width="2"/>`;
        }
    });

    return `<svg width="40" height="40" viewBox="0 0 40 40" style="background:${bg}; border-radius:50%;">${p}${selRing}${phaseTag}</svg>`;
}

// ─── 車流動線動畫圖層 ────────────────────────────────────────────────────────
// 在地圖上以像素尺寸繪製各路口當前放行動線：寬色帶 + 流動虛線 + 出口箭頭
// 放在地圖底圖之上、路口圖示之下；路口中心被圖示遮住，露出進入與離開兩段

map.createPane('flowPane');
map.getPane('flowPane').style.zIndex = 450;
map.getPane('flowPane').style.pointerEvents = 'none';
const flowRenderer = L.svg({ pane: 'flowPane', padding: 0.5 });
let flowEnabled = true;
let flowLayers = {};   // { [nodeId]: L.LayerGroup }
let lastFlowKey = {};  // { [nodeId]: key } — 狀態未變則不重繪

const FLOW_INNER = 12;     // 動線在路口內的起訖半徑（px）
const FLOW_LANE_OFF = 8;   // 靠右偏移（px），分開對向車流
const FLOW_MIN_LEN = 34;   // 臂長小於此值（圖示外露太少）則不顯示

// 臂長（px）：隨縮放變化，且不超過與最近路口距離的一半，避免互相重疊
function flowArmLength(node) {
    const p = map.latLngToLayerPoint([node.lat, node.lng]);
    let nearest = Infinity;
    state.nodes.forEach(o => {
        if (o.id === node.id) return;
        const d = p.distanceTo(map.latLngToLayerPoint([o.lat, o.lng]));
        if (d < nearest) nearest = d;
    });
    return Math.min(90, nearest * 0.5);
}

// 回傳各放行動線的像素路徑（相對路口中心，y 向下）
function buildFlowPaths(arms, movements, len) {
    const dir = b => { const r = b * Math.PI / 180; return { x: Math.sin(r), y: -Math.cos(r) }; };
    const paths = [];
    arms.forEach((arm, i) => {
        const m = movements[i];
        if (!m) return;
        const d = dir(arm.bearing);
        const n = { x: -d.y, y: d.x };  // 行進方向右側
        const start = { x: -d.x * len + n.x * FLOW_LANE_OFF, y: -d.y * len + n.y * FLOW_LANE_OFF };
        const p1 = { x: -d.x * FLOW_INNER + n.x * FLOW_LANE_OFF, y: -d.y * FLOW_INNER + n.y * FLOW_LANE_OFF };
        const add = (exitBearing) => {
            const e = dir(exitBearing);
            const ne = { x: -e.y, y: e.x };
            const p2 = { x: e.x * FLOW_INNER + ne.x * FLOW_LANE_OFF, y: e.y * FLOW_INNER + ne.y * FLOW_LANE_OFF };
            const end = { x: e.x * len + ne.x * FLOW_LANE_OFF, y: e.y * len + ne.y * FLOW_LANE_OFF };
            const pts = [start];
            const k = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.5;
            const c1 = { x: p1.x + d.x * k, y: p1.y + d.y * k };
            const c2 = { x: p2.x - e.x * k, y: p2.y - e.y * k };
            for (let s = 0; s <= 12; s++) {
                const t = s / 12, u = 1 - t;
                pts.push({
                    x: u*u*u*p1.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*p2.x,
                    y: u*u*u*p1.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*p2.y,
                });
            }
            pts.push(end);
            paths.push({ pts, endDir: e });
        };
        if (m.thru) add(arm.bearing);
        if (m.left) {
            const k = findExitArm(i, ((arm.bearing - 90) + 360) % 360, arms);
            add(k >= 0 ? arms[k].bearing : (arm.bearing + 270) % 360);
        }
        if (m.right) {
            const k = findExitArm(i, (arm.bearing + 90) % 360, arms);
            add(k >= 0 ? arms[k].bearing : (arm.bearing + 90) % 360);
        }
    });
    return paths;
}

function clearNodeFlow(nodeId) {
    if (flowLayers[nodeId]) { map.removeLayer(flowLayers[nodeId]); delete flowLayers[nodeId]; }
    delete lastFlowKey[nodeId];
}

function updateNodeFlow(node, sigState, movements, key) {
    const len = flowEnabled ? flowArmLength(node) : 0;
    const visible = len >= FLOW_MIN_LEN && sigState !== 'allRed' && Array.isArray(movements);
    const fullKey = `${visible}|${key}|${Math.round(len)}|${map.getZoom()}`;
    if (lastFlowKey[node.id] === fullKey) return;
    clearNodeFlow(node.id);
    lastFlowKey[node.id] = fullKey;
    if (!visible) return;

    const z = map.getZoom();
    const origin = map.project([node.lat, node.lng], z);
    const toLL = pt => map.unproject(origin.add([pt.x, pt.y]), z);
    const cls = sigState === 'yellow' ? 'flow-yellow' : 'flow-green';
    const color = sigState === 'yellow' ? '#f59e0b' : '#16a34a';
    const group = L.layerGroup();
    const opt = { renderer: flowRenderer, interactive: false, smoothFactor: 0, lineCap: 'round', lineJoin: 'round' };

    buildFlowPaths(node.arms || defaultArms(), movements, len).forEach(({ pts, endDir }) => {
        const lls = pts.map(toLL);
        L.polyline(lls, { ...opt, color: '#1f2937', weight: 14, opacity: 0.35, className: 'flow-casing' }).addTo(group);
        L.polyline(lls, { ...opt, color, weight: 10, opacity: 0.9, className: 'flow-band' }).addTo(group);
        L.polyline(lls, { ...opt, color: '#ffffff', weight: 3.5, opacity: 0.95, dashArray: '6 12', className: `flow-dash ${cls}` }).addTo(group);
        // 出口實心箭頭
        const tip = pts[pts.length - 1];
        const a = 20, w = 12;
        const nx = -endDir.y, ny = endDir.x;
        const head = [
            { x: tip.x + endDir.x * a * 0.55, y: tip.y + endDir.y * a * 0.55 },
            { x: tip.x - endDir.x * a * 0.45 + nx * w, y: tip.y - endDir.y * a * 0.45 + ny * w },
            { x: tip.x - endDir.x * a * 0.45 - nx * w, y: tip.y - endDir.y * a * 0.45 - ny * w },
        ].map(toLL);
        L.polygon(head, { ...opt, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 1, className: `flow-head ${cls}` }).addTo(group);
    });
    group.addTo(map);
    flowLayers[node.id] = group;
}

// 縮放後像素尺寸改變，全部重算
map.on('zoomend', () => { lastFlowKey = {}; updateSignals(); });

document.getElementById('chk-flow').addEventListener('change', (e) => {
    flowEnabled = e.target.checked;
    updateSignals();
});

// ─── 模擬引擎 ────────────────────────────────────────────────────────────────

const btnPlay = document.getElementById('btn-play');
const tsdBtnPlay = document.getElementById('tsd-btn-play');

// 播放/暫停合一按鈕：'idle' 未開始、'running' 執行中、'paused' 已暫停
const SIM_BTN_STATES = {
    idle:    { cls: 'btn-inactive',      text: '▶️ 開始模擬' },
    running: { cls: 'btn-play-active',   text: '⏸️ 暫停' },
    paused:  { cls: 'btn-pause-active',  text: '▶️ 繼續' },
};
function syncSimButtons(status) {
    const s = SIM_BTN_STATES[status];
    [btnPlay, tsdBtnPlay].forEach(b => { b.className = s.cls; b.textContent = s.text; });
}
const selectSpeed = document.getElementById('select-speed');

selectSpeed.oninput = () => {
    simSpeed = parseInt(selectSpeed.value);
    document.getElementById('speed-display').textContent = simSpeed + 'x';
    if (simInterval) { stopTimer(); startTimer(); }
};

// 幹道時空圖 overlay 開關
const tsdOverlay = document.getElementById('tsd-overlay');
function resizeTsdCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight || 300;
}
document.getElementById('btn-arterial').onclick = () => {
    tsdOverlay.classList.add('open');
    requestAnimationFrame(() => {
        resizeTsdCanvas();
        rebuildTsdControls();
        updateTimeSpaceDiagram();
    });
};
// 收合 / 展開左側設定欄，讓時空圖使用整個寬度
document.getElementById('btn-tsd-collapse').onclick = (e) => {
    const collapsed = document.getElementById('tsd-panel').classList.toggle('collapsed');
    e.currentTarget.textContent = collapsed ? '▶ 設定' : '◀ 設定';
    resizeTsdCanvas();
    updateTimeSpaceDiagram();
};
document.getElementById('btn-close-tsd').onclick = () => tsdOverlay.classList.remove('open');
tsdOverlay.addEventListener('click', e => { if (e.target === tsdOverlay) tsdOverlay.classList.remove('open'); });

// 綠寬帶控制
function setGbEnabled(on) {
    gbEnabled = on;
    const btn = document.getElementById('btn-gb-toggle');
    btn.classList.toggle('active', on);
    btn.textContent = on ? '🟢 綠寬帶（開）' : '🟢 繪製綠寬帶';
    document.getElementById('gb-settings').hidden = !on;
}
document.getElementById('btn-gb-toggle').addEventListener('click', () => {
    setGbEnabled(!gbEnabled);
    updateTsdSummary();
    updateTimeSpaceDiagram();
});
// 綠寬帶方向選項依排序方向顯示實際方位（FWD = 沿排序方向）
const SORT_DIR_LABEL = { WE: ['西', '東'], EW: ['東', '西'], SN: ['南', '北'], NS: ['北', '南'] };
function syncGbDirLabels() {
    const [from, to] = SORT_DIR_LABEL[tsdSortMode];
    const opts = document.getElementById('gb-dir').options;
    opts[0].textContent = `→ ${from}往${to}`;
    opts[1].textContent = `← ${to}往${from}`;
}
syncGbDirLabels();
document.getElementById('gb-dir').addEventListener('change', e => {
    gbDirection = e.target.value;
    updateTimeSpaceDiagram();
});
document.getElementById('tsd-sort-mode').addEventListener('change', e => {
    tsdSortMode = e.target.value;
    syncGbDirLabels();
    rebuildTsdControls();
    updateTimeSpaceDiagram();
});
document.getElementById('gb-speed-input').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (v > 0) { gbSpeed = v; updateTsdSummary(); updateTimeSpaceDiagram(); }
});

function playSim() {
    simStarted = true;
    startTimer();
    syncSimButtons('running');
    document.getElementById('editor-panel').style.display = 'none';
}

btnPlay.onclick = tsdBtnPlay.onclick = () => simInterval ? pauseSim() : playSim();

function pauseSim() {
    stopTimer();
    syncSimButtons('paused');
    if (editingNodeId) {
        const node = state.nodes.find(n => n.id === editingNodeId);
        if (node) openEditor(node);
    }
}


document.getElementById('btn-reset').onclick = () => {
    stopTimer();
    simStarted = false;
    simulationTime = 0;
    simMaxTime = 0;
    clockEl.innerText = 0;
    syncSimButtons('idle');
    document.getElementById('node-status-panel').style.display = 'none';
    if (editingNodeId) {
        const node = state.nodes.find(n => n.id === editingNodeId);
        if (node) openEditor(node);
    }
    updateSignals();
    updateTimeSpaceDiagram();
    updateTimelineUI();
};

function startTimer() {
    if (simInterval) return;
    simInterval = setInterval(() => {
        simulationTime += 1;
        if (simulationTime > simMaxTime) simMaxTime = simulationTime;
        clockEl.innerText = simulationTime;
        updateSignals();
        updateTimeSpaceDiagram();
        updateTimelineUI();
    }, 1000 / simSpeed);
}

function stopTimer() {
    clearInterval(simInterval);
    simInterval = null;
}

// ─── 時間軸拖曳（時光倒轉）───────────────────────────────────────────────────

simTimeline.addEventListener('pointerdown', () => {
    if (simInterval) pauseSim();
});
simTimeline.addEventListener('input', () => {
    simulationTime = parseInt(simTimeline.value) || 0;
    clockEl.innerText = simulationTime;
    updateSignals();
    updateTimeSpaceDiagram();
    timelineLabel.textContent = `${simulationTime} / ${simMaxTime} 秒`;
});

// ─── 時空圖繪製（含黃燈色帶）────────────────────────────────────────────────

function rebuildTsdControls() {
    if (!tsdOverlay.classList.contains('open')) return;
    rebuildPresetSelect();
    const container = document.getElementById('tsd-controls');
    const sortedNodes = getSortedNodes();
    // 清除已消失路口的隱藏紀錄（新路口預設顯示，不需特別處理）
    const valid = new Set(sortedNodes.map(n => n.id));
    tsdHiddenIds.forEach(id => { if (!valid.has(id)) tsdHiddenIds.delete(id); });
    const chain = getVisibleChain();
    const visibleIdx = new Map(chain.nodes.map((n, k) => [n.id, k]));
    container.innerHTML = '';
    sortedNodes.forEach(node => {
        // 顯示路口之間插入路段長度列（放在下一個顯示路口之前，中間的隱藏路口被跨過）
        const k = visibleIdx.get(node.id);
        if (k > 0) container.appendChild(buildSegmentRow(chain.nodes[k - 1], node, chain.segs[k], chain.cumDist[k]));

        const numPhases = node.plan.phases.length;
        // 初始化或清除超出範圍的索引
        if (!(node.id in tsdPhaseSelection) || !Array.isArray(tsdPhaseSelection[node.id])) {
            tsdPhaseSelection[node.id] = [0];
        } else {
            tsdPhaseSelection[node.id] = tsdPhaseSelection[node.id].filter(i => i < numPhases);
            if (tsdPhaseSelection[node.id].length === 0) tsdPhaseSelection[node.id] = [0];
        }

        const hidden = tsdHiddenIds.has(node.id);
        const row = document.createElement('div');
        row.className = 'tsd-phase-sel' + (hidden ? ' hidden-node' : '');

        // 顯示勾選框 + 路口名稱
        const label = document.createElement('label');
        label.title = node.name || node.id;
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !hidden;
        chk.addEventListener('change', () => {
            if (chk.checked) {
                tsdHiddenIds.delete(node.id);
            } else if (sortedNodes.filter(n => !tsdHiddenIds.has(n.id)).length <= 1) {
                chk.checked = true; return; // 至少保留一個路口
            } else {
                tsdHiddenIds.add(node.id);
            }
            rebuildTsdControls();
            updateTimeSpaceDiagram();
        });
        const nameSpan = document.createElement('span');
        nameSpan.textContent = node.name || node.id;
        label.append(chk, nameSpan);
        row.appendChild(label);

        for (let i = 0; i < numPhases; i++) {
            const btn = document.createElement('button');
            btn.className = 'tsd-phase-toggle' + (tsdPhaseSelection[node.id].includes(i) ? ' active' : '');
            btn.textContent = i + 1;
            btn.title = `時相 ${i + 1}`;
            btn.addEventListener('click', () => {
                const sel = tsdPhaseSelection[node.id];
                const pos = sel.indexOf(i);
                if (pos >= 0) {
                    sel.splice(pos, 1);
                    btn.classList.remove('active');
                } else {
                    sel.push(i);
                    sel.sort((a, b) => a - b);
                    btn.classList.add('active');
                }
                updateTimeSpaceDiagram();
            });
            row.appendChild(btn);
        }

        container.appendChild(row);
    });
}

// 路段長度列：「↓ [輸入] m  直線 148 m ↺   累計 313 m」
// 未輸入時欄位以淡字顯示目前採用的距離；修改後下游累計距離自動重算
function buildSegmentRow(a, b, seg, cum) {
    const key = segKey(a, b);
    const row = document.createElement('div');
    row.className = 'tsd-seg-row' + (seg.src === 'user' ? ' user' : '');
    row.title = `${a.name || a.id} → ${b.name || b.id} 的實際路段長度`;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.placeholder = Math.round(seg.m);
    if (seg.src === 'user') input.value = seg.m;
    input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (v > 0) tsdSegDist[key] = v; else delete tsdSegDist[key];
        rebuildTsdControls();
        updateTimeSpaceDiagram();
    });

    const hint = document.createElement('span');
    hint.className = 'tsd-seg-hint';
    hint.textContent = seg.src === 'user' ? `直線 ${Math.round(haversineM(a, b))} m`
                     : seg.src === 'sum'  ? '（各段加總）' : '（直線距離）';

    row.append('↓ ', input, ' m ', hint);
    if (seg.src === 'user') {
        const reset = document.createElement('button');
        reset.className = 'tsd-seg-reset';
        reset.textContent = '↺';
        reset.title = '清除，改用預設距離';
        reset.addEventListener('click', () => {
            delete tsdSegDist[key];
            rebuildTsdControls();
            updateTimeSpaceDiagram();
        });
        row.appendChild(reset);
    }
    const cumSpan = document.createElement('span');
    cumSpan.className = 'tsd-seg-cum';
    cumSpan.textContent = `累計 ${cum < 1000 ? Math.round(cum) + ' m' : (cum / 1000).toFixed(2) + ' km'}`;
    row.appendChild(cumSpan);
    return row;
}

// ─── 幹道綠寬帶 ─────────────────────────────────────────────────────────────

// 依方向回傳有序路口陣列（FWD 沿排序方向；REV 逆排序方向）
function gbGetOrderedNodes(sortedNodes) {
    return gbDirection === 'REV' ? [...sortedNodes].reverse() : sortedNodes;
}

// 回傳 plan 在 [searchMin, searchMax] 內的純綠燈區間（絕對時間）
function getGreenIntervals(plan, selectedPhases, searchMin, searchMax) {
    if (!plan || !plan.phases || plan.cycle <= 0 || !selectedPhases.length) return [];
    const intervals = [];
    const cycle = plan.cycle;
    const lastSelected = Math.max(...selectedPhases);
    // 從 searchMin 的前一個週期開始，確保不遺漏橫跨邊界的區間
    let base = Math.floor((searchMin - plan.offset) / cycle) * cycle + plan.offset - cycle;
    while (base <= searchMax) {
        let elapsed = 0;
        for (let i = 0; i < plan.phases.length; i++) {
            const ph = plan.phases[i];
            const duration = ph.green + ph.yellow + ph.allRed;
            if (selectedPhases.includes(i)) {
                // 與 getPhaseColorForDisplay 一致：非最後一個被選時相的黃燈/全紅
                // （通常是留給左轉早開等次要動作的清空時間）對幹道仍視為綠燈
                const gStart = base + elapsed;
                const gEnd   = gStart + (i === lastSelected ? ph.green : duration);
                if (gEnd > gStart && gEnd > searchMin && gStart < searchMax)
                    intervals.push({ start: gStart, end: gEnd });
            }
            elapsed += duration;
        }
        base += cycle;
    }
    return intervals;
}

// 兩組已排序、不重疊的區間取交集
function intersectIntervals(A, B) {
    const result = [];
    let ai = 0, bi = 0;
    while (ai < A.length && bi < B.length) {
        const s = Math.max(A[ai].start, B[bi].start);
        const e = Math.min(A[ai].end,   B[bi].end);
        if (s < e) result.push({ start: s, end: e });
        if (A[ai].end <= B[bi].end) ai++; else bi++;
    }
    return result;
}

// 計算綠寬帶區間（以進入第一個路口的時間表示）
// travelTimes[i] = 從 gbNodes[0] 到 gbNodes[i] 的行程時間（秒）
function computeGreenBands(gbNodes, travelTimes, searchMin, searchMax) {
    const sel0 = (tsdPhaseSelection[gbNodes[0].id] || [0])
        .filter(i => i < gbNodes[0].plan.phases.length);
    let feasible = getGreenIntervals(gbNodes[0].plan, sel0, searchMin, searchMax);
    for (let i = 1; i < gbNodes.length; i++) {
        const tt  = travelTimes[i];
        const sel = (tsdPhaseSelection[gbNodes[i].id] || [0])
            .filter(j => j < gbNodes[i].plan.phases.length);
        const greenI  = getGreenIntervals(gbNodes[i].plan, sel, searchMin + tt, searchMax + tt);
        const shifted = greenI.map(iv => ({ start: iv.start - tt, end: iv.end - tt }));
        feasible = intersectIntervals(feasible, shifted);
        if (!feasible.length) break;
    }
    // 合併首尾相接（例如左轉早開＋幹道對開被拆成兩段）的區間，避免多畫出一條分割線
    feasible = feasible.reduce((merged, iv) => {
        const last = merged[merged.length - 1];
        if (last && iv.start <= last.end + 0.01) last.end = Math.max(last.end, iv.end);
        else merged.push({ ...iv });
        return merged;
    }, []);
    return feasible.map(iv => ({ start: iv.start, end: iv.end, bw: iv.end - iv.start }));
}

// 在 canvas 上繪製綠寬帶（需在 clip context 內呼叫）
function drawGreenBands(sortedNodes, cumDist, yPositions, padL, drawW, padT, minTime, maxTime, timeWindow) {
    const orderedNodes = gbGetOrderedNodes(sortedNodes);
    if (orderedNodes.length < 2) return [];

    const speedMs = gbSpeed / 3.6;
    // 計算累積行程時間（距離與縱軸相同，含使用者輸入的路段長度）
    const cumMap = new Map(sortedNodes.map((n, i) => [n.id, cumDist[i]]));
    const travelTimes = [0];
    for (let i = 1; i < orderedNodes.length; i++)
        travelTimes.push(travelTimes[i - 1] +
            Math.abs(cumMap.get(orderedNodes[i].id) - cumMap.get(orderedNodes[i - 1].id)) / speedMs);
    const lastTT = travelTimes[travelTimes.length - 1];

    const bands = computeGreenBands(orderedNodes, travelTimes, minTime - lastTT - 5, maxTime + 5);
    if (!bands.length) return [];

    const yMap  = new Map(sortedNodes.map((n, i) => [n.id, yPositions[i]]));
    const tToX  = t => padL + ((t - minTime) / timeWindow) * drawW;

    ctx.save();
    bands.forEach(({ start, end, bw }) => {
        if (bw < 0.5) return;
        // 繪製各相鄰路口間的平行四邊形
        for (let i = 0; i < orderedNodes.length - 1; i++) {
            const nA = orderedNodes[i], nB = orderedNodes[i + 1];
            const ttA = travelTimes[i],  ttB = travelTimes[i + 1];
            const yA  = yMap.get(nA.id), yB  = yMap.get(nB.id);
            if (yA == null || yB == null) continue;
            const x1A = tToX(start + ttA), x2A = tToX(end + ttA);
            const x1B = tToX(start + ttB), x2B = tToX(end + ttB);

            // 填色
            ctx.fillStyle = 'rgba(40, 167, 69, 0.15)';
            ctx.beginPath();
            ctx.moveTo(x1A, yA); ctx.lineTo(x2A, yA);
            ctx.lineTo(x2B, yB); ctx.lineTo(x1B, yB);
            ctx.closePath();
            ctx.fill();

            // 前後緣斜線
            ctx.strokeStyle = 'rgba(30, 126, 52, 0.9)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(x1A, yA); ctx.lineTo(x1B, yB);
            ctx.moveTo(x2A, yA); ctx.lineTo(x2B, yB);
            ctx.stroke();
        }
        // 帶寬標籤（顯示於第一個路口中心上方）
        const yFirst = yMap.get(orderedNodes[0].id);
        if (yFirst != null) {
            const xMid = tToX(start + travelTimes[0] + bw / 2);
            if (xMid >= padL && xMid <= padL + drawW) {
                ctx.fillStyle = 'rgba(30, 126, 52, 0.95)';
                ctx.font = 'bold 10px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.round(bw)}s`, xMid, yFirst - 5);
                ctx.textAlign = 'left';
            }
        }
    });
    ctx.restore();
    return bands;
}

// 綠寬帶摘要：帶寬與帶寬效率（帶寬 / 週期；各路口週期不同時不計效率）
function updateGbSummary(sortedNodes, bands) {
    const el = document.getElementById('gb-summary');
    const bws = bands.map(b => b.bw).filter(bw => bw >= 0.5);
    let text;
    if (sortedNodes.length < 2) text = '需至少 2 個路口';
    else if (!bws.length) text = '⚠️ 此速率下無可通行綠寬帶';
    else {
        const maxBw = Math.round(Math.max(...bws)), minBw = Math.round(Math.min(...bws));
        const cycles = new Set(sortedNodes.map(n => n.plan.cycle));
        text = cycles.size === 1
            ? `帶寬 ${maxBw} 秒 · 效率 ${Math.round(maxBw / [...cycles][0] * 100)}%（週期 ${[...cycles][0]} 秒）`
            : `帶寬 ${minBw === maxBw ? maxBw : minBw + '–' + maxBw} 秒（各路口週期不同）`;
    }
    if (el.textContent !== text) el.textContent = text;
}

// ─── 幹道設定（多組，綁定時制方案）──────────────────────────────────────────
// state.tsdPresets = [{ id, name, hiddenIds, phaseSelection, sortMode, gbEnabled, gbDirection, gbSpeed }]
// 只放「目前載入的方案」的設定：目錄專案存於 plans/<planId>.json 的 tsdPresets，
// 沒有方案的專案或本機檔案則存於專案檔本身。
let tsdPresetId = '';  // 目前選取的設定 id（'' = 未儲存的設定）

function currentPlanName() {
    const opt = selPlan.options[selPlan.selectedIndex];
    return opt ? opt.textContent : '專案內建時制';
}
function presetsForPlan() {
    return state.tsdPresets || [];
}

function rebuildPresetSelect() {
    const sel = document.getElementById('tsd-preset-select');
    const list = presetsForPlan();
    if (!list.some(p => p.id === tsdPresetId)) tsdPresetId = '';
    sel.innerHTML = '<option value="">（未儲存的設定）</option>' +
        list.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.value = tsdPresetId;
    document.getElementById('tsd-preset-plan').textContent = `綁定方案：${currentPlanName()}`;
    document.getElementById('btn-tsd-preset-rename').disabled =
    document.getElementById('btn-tsd-preset-delete').disabled = !tsdPresetId;
    updateTsdSummary();
}

// 標題列一行摘要（設定欄收合時也能看到目前狀態）
function updateTsdSummary() {
    const preset = presetsForPlan().find(p => p.id === tsdPresetId);
    const [from, to] = SORT_DIR_LABEL[tsdSortMode];
    document.getElementById('tsd-summary').textContent =
        `${preset ? preset.name : '未儲存的設定'} · ${from}→${to}` +
        (gbEnabled ? ` · 綠寬帶 ${gbSpeed} km/h` : '');
}

function snapshotPreset() {
    return {
        hiddenIds: [...tsdHiddenIds],
        phaseSelection: JSON.parse(JSON.stringify(tsdPhaseSelection)),
        segDist: { ...tsdSegDist },
        sortMode: tsdSortMode, gbEnabled, gbDirection, gbSpeed,
    };
}

// 套用設定（p = null 時恢復預設值）
function applyPreset(p) {
    tsdPresetId       = p ? p.id : '';
    tsdHiddenIds      = new Set(p ? p.hiddenIds : []);
    tsdPhaseSelection = JSON.parse(JSON.stringify(p ? p.phaseSelection : {}));
    tsdSegDist        = { ...(p && p.segDist) };
    tsdSortMode       = p ? p.sortMode : 'WE';
    gbDirection       = p ? p.gbDirection : 'FWD';
    gbSpeed           = p ? p.gbSpeed : 40;
    setGbEnabled(p ? p.gbEnabled : false);
    document.getElementById('tsd-sort-mode').value = tsdSortMode;
    document.getElementById('gb-dir').value = gbDirection;
    document.getElementById('gb-speed-input').value = gbSpeed;
    syncGbDirLabels();
    rebuildTsdControls();
    updateTimeSpaceDiagram();
}

// 載入專案或切換方案後，自動套用該方案的第一組設定
function applyPresetForCurrentPlan() {
    applyPreset(presetsForPlan()[0] || null);
}

function showPresetMsg(text) {
    const el = document.getElementById('tsd-preset-msg');
    el.textContent = text;
    clearTimeout(showPresetMsg.timer);
    showPresetMsg.timer = setTimeout(() => { el.textContent = ''; }, 4000);
}
const SAVE_REMINDER = '，記得按側欄「💾 儲存」寫入檔案';

function savePresetAs() {
    const name = prompt('幹道設定名稱：', `幹道設定 ${presetsForPlan().length + 1}`);
    if (!name || !name.trim()) return;
    const preset = { id: 'tsd' + Date.now(), name: name.trim(), ...snapshotPreset() };
    (state.tsdPresets = state.tsdPresets || []).push(preset);
    tsdPresetId = preset.id;
    rebuildPresetSelect();
    showPresetMsg('✅ 已新增' + SAVE_REMINDER);
}

document.getElementById('tsd-preset-select').onchange = (e) => {
    const p = presetsForPlan().find(x => x.id === e.target.value);
    if (p) applyPreset(p);
    else { tsdPresetId = ''; rebuildPresetSelect(); } // 保留目前畫面，僅脫離已存設定
};
document.getElementById('btn-tsd-preset-save').onclick = () => {
    const p = presetsForPlan().find(x => x.id === tsdPresetId);
    if (!p) return savePresetAs();
    Object.assign(p, snapshotPreset());
    rebuildPresetSelect();
    showPresetMsg('✅ 已更新' + SAVE_REMINDER);
};
document.getElementById('btn-tsd-preset-saveas').onclick = savePresetAs;
document.getElementById('btn-tsd-preset-rename').onclick = () => {
    const p = presetsForPlan().find(x => x.id === tsdPresetId);
    if (!p) return;
    const name = prompt('新名稱：', p.name);
    if (!name || !name.trim()) return;
    p.name = name.trim();
    rebuildPresetSelect();
};
document.getElementById('btn-tsd-preset-delete').onclick = () => {
    const p = presetsForPlan().find(x => x.id === tsdPresetId);
    if (!p || !confirm(`確定刪除「${p.name}」？`)) return;
    state.tsdPresets = state.tsdPresets.filter(x => x !== p);
    tsdPresetId = '';
    rebuildPresetSelect();
    showPresetMsg('已刪除' + SAVE_REMINDER);
};

// 依 tsdSortMode 回傳排序後的路口陣列（全部路口）
function getSortedNodes() {
    const axis = (tsdSortMode === 'SN' || tsdSortMode === 'NS') ? 'lat' : 'lng';
    const asc = (tsdSortMode === 'WE' || tsdSortMode === 'SN');
    return [...state.nodes].sort((a, b) => asc ? a[axis] - b[axis] : b[axis] - a[axis]);
}

// ─── 路段長度（使用者輸入，存於幹道設定 segDist）───────────────────────────────
// 以兩端路口 id（不分方向）為鍵，換排序方向時仍有效
function segKey(a, b) { return [a.id, b.id].sort().join('|'); }

// all[iA] → all[iB] 的路段長度（兩者之間可能夾著隱藏路口）：
// 1. 使用者直接輸入此段 → 用輸入值
// 2. 中間有隱藏路口且各小段都有輸入 → 用加總
// 3. 否則 → 兩端直線距離（不繞經隱藏路口，避免繞到其他幹道上的路口）
function segmentLength(all, iA, iB) {
    const user = tsdSegDist[segKey(all[iA], all[iB])];
    if (user > 0) return { m: user, src: 'user' };
    if (iB - iA > 1) {
        const subs = [];
        for (let i = iA; i < iB; i++) subs.push(tsdSegDist[segKey(all[i], all[i + 1])]);
        if (subs.every(v => v > 0)) return { m: subs.reduce((s, v) => s + v, 0), src: 'sum' };
    }
    return { m: haversineM(all[iA], all[iB]), src: 'line' };
}

// 顯示於時空圖的路口與累計距離；segs[k] = 第 k-1 → k 個顯示路口的路段
function getVisibleChain() {
    const all = getSortedNodes();
    const idx = [];
    all.forEach((n, i) => { if (!tsdHiddenIds.has(n.id)) idx.push(i); });
    const nodes = idx.map(i => all[i]), cumDist = [0], segs = [null];
    for (let k = 1; k < idx.length; k++) {
        const seg = segmentLength(all, idx[k - 1], idx[k]);
        segs.push(seg);
        cumDist.push(cumDist[k - 1] + seg.m);
    }
    return { nodes, cumDist, segs };
}

function haversineM(n1, n2) {
    const R = 6371000;
    const φ1 = n1.lat * Math.PI / 180, φ2 = n2.lat * Math.PI / 180;
    const Δφ = (n2.lat - n1.lat) * Math.PI / 180;
    const Δλ = (n2.lng - n1.lng) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateTimeSpaceDiagram() {
    if (!tsdOverlay.classList.contains('open')) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.nodes.length === 0) return;

    // 累積距離（公尺；使用者輸入的路段長度優先），用於縱軸比例定位與綠寬帶行程時間
    const { nodes: sortedNodes, cumDist } = getVisibleChain();
    const numNodes = sortedNodes.length;
    const totalDist = cumDist[numNodes - 1] || 1;

    const padL = 72, padR = 20, padT = 20, padB = 30;
    const drawW = canvas.width - padL - padR;
    const drawH = canvas.height - padT - padB;
    const timeWindow = 240;
    const centerTime = simulationTime + tsdTimeOffset;
    const minTime = centerTime - timeWindow / 2;
    const maxTime = minTime + timeWindow;

    // 虛擬高度：路口數多時擴展，確保最小間距 50px；頂底各留 margin
    const MIN_SPACING = 50;
    const nodeTopMargin = 18, nodeBottomMargin = 30;
    const virtualDrawH = Math.max(drawH,
        numNodes <= 1 ? drawH : (numNodes - 1) * MIN_SPACING + nodeTopMargin + nodeBottomMargin);
    tsdScrollInner.style.height = (virtualDrawH + padT + padB) + 'px';
    const scrollY = Math.min(tsdScrollbar.scrollTop, Math.max(0, virtualDrawH - drawH));

    // 背景網格（固定於可視區，不隨 scrollY 移動）
    ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
    for (let t = Math.ceil(minTime / 30) * 30; t <= maxTime; t += 30) {
        const x = padL + ((t - minTime) / timeWindow) * drawW;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + drawH); ctx.stroke();
        ctx.fillStyle = '#666'; ctx.font = '10px sans-serif';
        ctx.fillText(t + 's', x - 10, padT + drawH + 15);
    }

    // 預先計算各路口 Y 座標（供號誌色帶與綠寬帶共用）
    const yPositions = sortedNodes.map((_, index) => {
        const ratio = numNodes === 1 ? 0.5 : cumDist[index] / totalDist;
        return padT + nodeTopMargin + ratio * (virtualDrawH - nodeTopMargin - nodeBottomMargin) - scrollY;
    });

    // 將各路口色帶與標籤裁剪在可視範圍內
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, padT, canvas.width, drawH);
    ctx.clip();

    // 各路口號誌色帶
    sortedNodes.forEach((node, index) => {
        const y = yPositions[index];

        // 可視範圍外跳過（留 15px 緩衝避免標籤截斷）
        if (y < padT - 15 || y > padT + drawH + 15) return;

        // 路口名稱
        ctx.fillStyle = '#333'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText(node.name || node.id, 4, y + 13);
        // 累積距離標籤
        ctx.fillStyle = '#888'; ctx.font = '9px sans-serif';
        const distLabel = cumDist[index] < 1000
            ? Math.round(cumDist[index]) + ' m'
            : (cumDist[index] / 1000).toFixed(2) + ' km';
        ctx.fillText(distLabel, 4, y + 24);

        const plan = node.plan;
        const selectedPhases = (Array.isArray(tsdPhaseSelection[node.id]) ? tsdPhaseSelection[node.id] : [0])
            .filter(i => i < plan.phases.length);
        for (let t = Math.floor(minTime); t <= maxTime; t++) {
            let localTime = (t - plan.offset) % plan.cycle;
            if (localTime < 0) localTime += plan.cycle;
            const sigState = getPhaseColorForDisplay(plan, localTime, selectedPhases);
            ctx.fillStyle =
                sigState === 'green'  ? 'rgba(40, 167, 69, 0.75)' :
                sigState === 'yellow' ? 'rgba(255, 193, 7, 0.85)' :
                                        'rgba(220, 53, 69, 0.65)';
            // 每秒填滿到下一秒的位置；取整數像素避免半透明色相鄰處出現接縫，並限制在繪圖區內
            const x1 = Math.round(Math.max(padL, padL + ((t - minTime) / timeWindow) * drawW));
            const x2 = Math.round(Math.min(padL + drawW, padL + ((t + 1 - minTime) / timeWindow) * drawW));
            if (x2 > x1) ctx.fillRect(x1, y + 2, x2 - x1, 10);
        }

        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + drawW, y); ctx.stroke();
    });

    // 綠寬帶（繪於號誌色帶上方，同在 clip 內）
    if (gbEnabled)
        updateGbSummary(sortedNodes, drawGreenBands(sortedNodes, cumDist, yPositions, padL, drawW, padT, minTime, maxTime, timeWindow));

    ctx.restore();

    // 當前時間線（畫在 clip 外，跨越完整繪圖高度）
    const curX = padL + ((simulationTime - minTime) / timeWindow) * drawW;
    if (curX >= padL && curX <= padL + drawW) {
        ctx.strokeStyle = '#007bff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(curX, padT - 5); ctx.lineTo(curX, padT + drawH + 5); ctx.stroke();
    }

    // 回顧模式提示
    if (tsdTimeOffset < -1) {
        const label = `◀ 回顧中（${Math.round(-tsdTimeOffset)}s 前）  左拖回到現在`;
        ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(220, 53, 69, 0.82)';
        ctx.beginPath();
        ctx.roundRect(padL + drawW - tw - 12, padT + 4, tw + 10, 18, 4);
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.fillText(label, padL + drawW - tw - 7, padT + 16);
    }
}

// 畫布大小自適應（僅在 overlay 開啟時執行）
window.addEventListener('resize', () => {
    if (tsdOverlay.classList.contains('open')) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight || 300;
        updateTimeSpaceDiagram();
    }
});

// ─── 路口總覽 ────────────────────────────────────────────────────────────────

const allNodesOverlay = document.getElementById('all-nodes-overlay');

document.getElementById('btn-all-nodes').onclick = () => {
    document.getElementById('editor-panel').style.display = 'none';
    allNodesOverlay.classList.add('open');
    buildAllNodesPanel();
};
document.getElementById('btn-close-all-nodes').onclick = () => allNodesOverlay.classList.remove('open');
allNodesOverlay.addEventListener('click', e => { if (e.target === allNodesOverlay) allNodesOverlay.classList.remove('open'); });
document.getElementById('all-nodes-panel').addEventListener('wheel', (e) => {
    e.preventDefault();
    document.getElementById('all-nodes-container').scrollTop += e.deltaY;
}, { passive: false });

document.getElementById('btn-apply-all-nodes').onclick = () => {
    updateSignals();
    rebuildTsdControls();
    updateTimeSpaceDiagram();
    const btn = document.getElementById('btn-apply-all-nodes');
    btn.textContent = '✅ 已套用';
    setTimeout(() => { btn.textContent = '套用全部'; }, 1500);
};

function buildAllNodesPanel() {
    const container = document.getElementById('all-nodes-container');
    container.innerHTML = '';
    if (state.nodes.length === 0) {
        container.innerHTML = '<p class="anc-empty">尚未建立任何路口，請先在地圖上新增路口。</p>';
        return;
    }
    state.nodes.forEach(node => container.appendChild(buildNodeCard(node)));
}

function buildNodeCard(node) {
    const card = document.createElement('div');
    card.className = 'anc-card';
    card.dataset.nodeId = node.id;

    // 卡片標題列
    const header = document.createElement('div');
    header.className = 'anc-card-header';
    header.textContent = node.name ? `${node.id}　${node.name}` : node.id;
    card.appendChild(header);

    // 基本欄位
    const body = document.createElement('div');
    body.className = 'anc-body';

    const fieldsDiv = document.createElement('div');
    fieldsDiv.className = 'anc-fields';
    fieldsDiv.innerHTML = `
        <label class="anc-field">編號
            <input type="text" class="anc-input anc-id" value="${node.id}">
        </label>
        <label class="anc-field">名稱
            <input type="text" class="anc-input anc-name" value="${node.name || ''}">
        </label>
        <label class="anc-field">時差
            <input type="number" class="anc-input anc-offset" value="${node.plan.offset}" min="0"> 秒
        </label>
        <span class="anc-cycle-display">週期：<strong class="anc-cycle">${node.plan.cycle}</strong> 秒</span>
    `;
    body.appendChild(fieldsDiv);

    const syncBasic = () => {
        const idInput = fieldsDiv.querySelector('.anc-id');
        const newId = idInput.value.trim();
        if (newId && newId !== node.id) {
            if (state.nodes.some(n => n.id === newId)) {
                idInput.value = node.id;
            } else {
                markers[newId] = markers[node.id]; delete markers[node.id];
                delete lastIconState[node.id];
                if (editingNodeId === node.id) editingNodeId = newId;
                if (selectedNodeId === node.id) selectedNodeId = newId;
                if (tsdPhaseSelection[node.id] !== undefined) {
                    tsdPhaseSelection[newId] = tsdPhaseSelection[node.id];
                    delete tsdPhaseSelection[node.id];
                }
                node.id = newId;
                card.dataset.nodeId = newId;
            }
        }
        node.name = fieldsDiv.querySelector('.anc-name').value.trim();
        header.textContent = node.name ? `${node.id}　${node.name}` : node.id;
        node.plan.offset = parseInt(fieldsDiv.querySelector('.anc-offset').value) || 0;
        updateSignals();
    };

    fieldsDiv.querySelector('.anc-id').addEventListener('change', syncBasic);
    fieldsDiv.querySelector('.anc-name').addEventListener('input', syncBasic);
    fieldsDiv.querySelector('.anc-offset').addEventListener('input', syncBasic);

    // 臂管理區
    const armsSection = document.createElement('div');
    armsSection.className = 'anc-arms-section';
    const armsListDiv = document.createElement('div');
    armsListDiv.className = 'anc-arms-list';
    armsSection.appendChild(armsListDiv);
    const addArmBtn = document.createElement('button');
    addArmBtn.className = 'anc-add-arm';
    addArmBtn.textContent = '＋ 新增臂';
    addArmBtn.onclick = () => {
        node.arms.push({ bearing: 0, label: `臂${node.arms.length + 1}` });
        node.plan.phases.forEach(ph => ph.movements.push({ thru: false, left: false, right: false }));
        rebuildCardArms(armsListDiv, node, card);
        refreshCardPhases(card, node);
        updateSignals();
    };
    armsSection.appendChild(addArmBtn);
    body.appendChild(armsSection);
    rebuildCardArms(armsListDiv, node, card);

    // 時相區
    const phasesDiv = document.createElement('div');
    phasesDiv.className = 'anc-phases';
    body.appendChild(phasesDiv);

    const addPhaseBtn = document.createElement('button');
    addPhaseBtn.className = 'anc-add-phase';
    addPhaseBtn.textContent = '＋ 新增時相';
    addPhaseBtn.onclick = () => {
        node.plan.phases.push(defaultPhase(20, 3, 1, (node.arms || []).length));
        refreshCardPhases(card, node);
        rebuildTsdControls();
    };
    body.appendChild(addPhaseBtn);

    card.appendChild(body);
    refreshCardPhases(card, node);
    return card;
}

function rebuildCardArms(armsListDiv, node, card) {
    armsListDiv.innerHTML = '';
    (node.arms || []).forEach((arm, i) => {
        const row = document.createElement('div');
        row.className = 'anc-arm-row';

        const numSpan = document.createElement('span');
        numSpan.className = 'anc-arm-num';
        numSpan.textContent = `#${i + 1}`;
        row.appendChild(numSpan);

        const bearingInput = document.createElement('input');
        bearingInput.type = 'number';
        bearingInput.className = 'anc-arm-bearing';
        bearingInput.value = arm.bearing;
        bearingInput.min = 0; bearingInput.max = 359;
        bearingInput.title = '方位角（0=北,90=東,180=南,270=西）';
        bearingInput.addEventListener('input', () => {
            const raw = parseInt(bearingInput.value);
            arm.bearing = isNaN(raw) ? 0 : ((raw % 360) + 360) % 360;
            updateSignals();
        });
        row.appendChild(bearingInput);
        row.appendChild(document.createTextNode('°'));

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'anc-arm-label';
        labelInput.value = arm.label;
        labelInput.maxLength = 6;
        labelInput.addEventListener('input', () => {
            arm.label = labelInput.value.trim() || `臂${i + 1}`;
            refreshCardPhases(card, node);
        });
        row.appendChild(labelInput);

        if (node.arms.length > 2) {
            const delBtn = document.createElement('button');
            delBtn.className = 'anc-arm-del';
            delBtn.textContent = '✕';
            delBtn.onclick = () => {
                node.arms.splice(i, 1);
                node.plan.phases.forEach(ph => ph.movements.splice(i, 1));
                rebuildCardArms(armsListDiv, node, card);
                refreshCardPhases(card, node);
                updateSignals();
            };
            row.appendChild(delBtn);
        }
        armsListDiv.appendChild(row);
    });
}

function refreshCardPhases(card, node) {
    const phasesDiv = card.querySelector('.anc-phases');
    phasesDiv.innerHTML = '';
    node.plan.phases.forEach((phase, idx) => {
        phasesDiv.appendChild(buildCardPhaseBlock(phase, idx, node, card));
    });
    updateCardCycle(card, node);
}

function buildCardPhaseBlock(phase, idx, node, card) {
    const arms = node.arms || defaultArms();

    // 確保 movements 陣列長度與 arms 一致
    while (phase.movements.length < arms.length)
        phase.movements.push({ thru: false, left: false, right: false });
    phase.movements.length = arms.length;

    const div = document.createElement('div');
    div.className = 'anc-phase-block';

    const canUp   = idx > 0;
    const canDown  = idx < node.plan.phases.length - 1;
    const canDel   = node.plan.phases.length > 1;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'anc-phase-header';
    headerDiv.innerHTML = `
        <span class="anc-phase-title">時相 ${idx + 1}</span>
        <div class="anc-phase-timing">
            <label>綠 <input type="number" class="anc-ph-input" data-field="green"  value="${phase.green}"  min="5"  max="240"> 秒</label>
            <label>黃 <input type="number" class="anc-ph-input" data-field="yellow" value="${phase.yellow}" min="2"  max="6"> 秒</label>
            <label>全紅 <input type="number" class="anc-ph-input" data-field="allRed" value="${phase.allRed}" min="0" max="5"> 秒</label>
            <span class="anc-ph-total">= <strong class="anc-ph-sum">${phase.green + phase.yellow + phase.allRed}</strong> 秒</span>
        </div>
        <div class="anc-phase-btns">
            ${canUp   ? '<button class="anc-ph-btn" data-dir="-1">↑</button>' : ''}
            ${canDown ? '<button class="anc-ph-btn" data-dir="1">↓</button>'  : ''}
            ${canDel  ? '<button class="anc-ph-btn anc-ph-del">✕</button>'   : ''}
        </div>
    `;
    div.appendChild(headerDiv);

    headerDiv.querySelectorAll('.anc-ph-input').forEach(input => {
        input.addEventListener('input', () => {
            const g  = parseInt(headerDiv.querySelector('[data-field="green"]').value)  || 0;
            const y  = parseInt(headerDiv.querySelector('[data-field="yellow"]').value) || 0;
            const ar = parseInt(headerDiv.querySelector('[data-field="allRed"]').value) || 0;
            phase.green = g; phase.yellow = y; phase.allRed = ar;
            headerDiv.querySelector('.anc-ph-sum').textContent = g + y + ar;
            updateCardCycle(card, node);
            updateSignals();
            updateTimeSpaceDiagram();
        });
    });

    headerDiv.querySelectorAll('.anc-ph-btn[data-dir]').forEach(btn => {
        btn.addEventListener('click', () => {
            const toIdx = idx + parseInt(btn.dataset.dir);
            if (toIdx < 0 || toIdx >= node.plan.phases.length) return;
            [node.plan.phases[idx], node.plan.phases[toIdx]] = [node.plan.phases[toIdx], node.plan.phases[idx]];
            refreshCardPhases(card, node);
        });
    });

    const delEl = headerDiv.querySelector('.anc-ph-del');
    if (delEl) {
        delEl.addEventListener('click', () => {
            node.plan.phases.splice(idx, 1);
            refreshCardPhases(card, node);
            rebuildTsdControls();
            updateSignals();
            updateTimeSpaceDiagram();
        });
    }

    // 動線（n-arm）
    const previewEl = document.createElement('div');
    previewEl.className = 'anc-phase-preview';
    function refreshPreview() {
        previewEl.innerHTML = buildSignalSVG('green', phase.movements, arms, false, idx);
    }

    const movDiv = document.createElement('div');
    movDiv.className = 'anc-movements';
    arms.forEach((arm, i) => {
        const m = phase.movements[i] || { thru: false, left: false, right: false };
        const group = document.createElement('div');
        group.className = 'anc-mov-group';
        const apSpan = document.createElement('span');
        apSpan.className = 'anc-mov-approach';
        apSpan.textContent = arm.label;
        group.appendChild(apSpan);
        [['thru', '直'], ['left', '左'], ['right', '右']].forEach(([turn, label]) => {
            const lbl = document.createElement('label');
            lbl.className = 'anc-mov-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = m[turn] || false;
            cb.addEventListener('change', () => {
                if (!phase.movements[i]) phase.movements[i] = { thru: false, left: false, right: false };
                phase.movements[i][turn] = cb.checked;
                validateCardConflicts(div, phase, node.arms);
                updateSignals();
                refreshPreview();
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(label));
            group.appendChild(lbl);
        });
        movDiv.appendChild(group);
    });
    div.appendChild(movDiv);

    refreshPreview();
    div.appendChild(previewEl);

    const warnDiv = document.createElement('div');
    warnDiv.className = 'anc-conflict-warn';
    warnDiv.style.display = 'none';
    div.appendChild(warnDiv);
    validateCardConflicts(div, phase, node.arms);

    return div;
}

function updateCardCycle(card, node) {
    node.plan.cycle = node.plan.phases.reduce((s, p) => s + p.green + p.yellow + p.allRed, 0);
    const el = card.querySelector('.anc-cycle');
    if (el) el.textContent = node.plan.cycle;
}

function validateCardConflicts(phaseDiv, phase, arms) {
    const conflicts = detectConflicts(arms || defaultArms(), phase.movements || []);
    const warnEl = phaseDiv.querySelector('.anc-conflict-warn');
    if (!warnEl) return;
    if (conflicts.length > 0) {
        warnEl.style.display = 'block';
        warnEl.innerHTML = `<strong>⚠️ 衝突動線：</strong><br>${conflicts.join('<br>')}`;
    } else {
        warnEl.style.display = 'none';
    }
}

// ─── 專案儲存 / 讀取 ─────────────────────────────────────────────────────────
// 以 server.py（start-local.bat）開啟目錄專案時直接寫回 projects/；否則下載完整專案檔。

document.getElementById('btn-save').onclick = () => {
    if (saveApi && loadedProjectId) {
        saveToCatalog(loadedPlanId)
            .then(() => { markSaved(); flashSaveButton('✅ 已寫入'); })
            .catch(err => alert('存檔失敗：' + err.message));
        return;
    }
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', 'traffic_project.json');
    a.click();
    markSaved();
};

// ─── 路口選取彈窗事件 ────────────────────────────────────────────────────────

map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (!el) return;
    const editBtn = el.querySelector('#nap-edit');
    const deleteBtn = el.querySelector('#nap-delete');
    if (editBtn) {
        editBtn.addEventListener('click', () => {
            const node = state.nodes.find(n => n.id === selectedNodeId);
            if (node) { map.closePopup(); openEditor(node); }
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const nodeId = selectedNodeId;
            map.closePopup();
            if (confirm(`確定要刪除路口 ${nodeId}？此操作無法復原。`)) deleteNode(nodeId);
        });
    }
});

map.on('popupclose', (e) => {
    if (e.popup === currentPopup) {
        currentPopup = null;
        selectedNodeId = null;
        updateSignals();
        justClosedPopup = true;
        setTimeout(() => { justClosedPopup = false; }, 0);
    }
});

function loadProjectData(data) {
    Object.values(markers).forEach(m => map.removeLayer(m));
    markers = {};
    lastIconState = {};
    Object.keys(flowLayers).forEach(clearNodeFlow);
    lastFlowKey = {};
    state = data;
    delete state.links; // 未使用的舊欄位
    // 自動升級舊格式
    state.nodes.forEach(node => {
        // 1. 建立 arms（若尚未有）
        if (!node.arms) {
            const b = node.bearing || 0;
            node.arms = [
                { bearing: (90  + b) % 360, label: 'EB' },
                { bearing: (270 + b) % 360, label: 'WB' },
                { bearing: (0   + b) % 360, label: 'NB' },
                { bearing: (180 + b) % 360, label: 'SB' },
            ];
        }
        delete node.bearing; // 只在上面建立 arms 時使用的舊欄位
        const numArms = node.arms.length;
        // 2. 有方案的目錄專案，project.json 不含時制，先給預設值（隨後由方案檔覆蓋）
        if (!node.plan) {
            node.plan = defaultPlan(numArms);
        // 升級 plan（最舊格式）
        } else if (!node.plan.phases) {
            node.plan = migratePlan(node.plan, numArms);
        } else {
            // 3. 升級各時相 movements（舊物件格式 → 新陣列格式）
            node.plan.phases.forEach(ph => {
                if (!Array.isArray(ph.movements))
                    ph.movements = migrateMovements(ph.movements, numArms);
            });
        }
        drawNode(node);
    });
    if (state.nodes.length > 0) {
        const latlngs = state.nodes.map(n => [n.lat, n.lng]);
        map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
    }
    updateSignals();
    if (state.tsdSettings) {
        state.tsdPresets = state.tsdPresets || [];
        state.tsdPresets.push({
            id: 'tsd' + Date.now(), name: '預設',
            hiddenIds: state.tsdSettings.hiddenIds || [],
            phaseSelection: state.tsdSettings.phaseSelection || {},
            sortMode: 'WE', gbEnabled: false, gbDirection: 'FWD', gbSpeed: 40,
        });
        delete state.tsdSettings;
    }
    if (allNodesOverlay.classList.contains('open')) buildAllNodesPanel();
}

document.getElementById('file-load').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    e.target.value = ''; // 允許重複讀取同一檔案
    if (!confirmDiscard()) return;
    reader.onload = function(event) {
        // 本機檔案不在目錄中：清空選單與網址參數，避免分享出錯的連結
        loadedProjectId = loadedPlanId = null;
        restoreSelects();
        history.replaceState(null, '', location.pathname);
        loadProjectData(JSON.parse(event.target.result));
        applyPresetForCurrentPlan();
        markSaved();
    };
    reader.readAsText(file);
});

// ─── 時制計畫儲存 / 讀取（arms + plan，以路口 id 對應）────────────────────────────

// 方案檔內容：各路口 arms + plan，以及此方案的幹道設定
function buildTimingPlansData() {
    const plans = {};
    state.nodes.forEach(n => { plans[n.id] = { arms: n.arms, plan: n.plan }; });
    return { type: 'timing-plans', savedAt: new Date().toISOString(), plans, tsdPresets: state.tsdPresets || [] };
}

document.getElementById('btn-save-plans').onclick = () => {
    const data = buildTimingPlansData();
    const a = document.createElement('a');
    a.setAttribute('href', 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data)));
    a.setAttribute('download', 'timing_plans.json');
    a.click();
};

document.getElementById('file-load-plans').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // 允許重複讀取同一檔案
    const reader = new FileReader();
    reader.onload = function(event) {
        let data;
        try { data = JSON.parse(event.target.result); } catch { alert('檔案格式錯誤'); return; }
        if (data.type !== 'timing-plans' || !data.plans) { alert('此檔案不是時制計畫檔'); return; }
        // 視為修改目前方案：之後可「💾 儲存」覆寫，或「＋ 另存新方案」
        const { applied, mismatched, missing } = applyTimingPlans(data);
        if (data.tsdPresets) { state.tsdPresets = data.tsdPresets; applyPresetForCurrentPlan(); }
        let msg = `已套用 ${applied.length} 個路口的時制計畫。`;
        if (mismatched.length) msg += `\n臂數不符而略過：${mismatched.join(', ')}`;
        if (missing.length) msg += `\n檔案中無資料：${missing.join(', ')}`;
        alert(msg);
    };
    reader.readAsText(file);
});

function applyTimingPlans(data) {
    const applied = [], mismatched = [], missing = [];
    state.nodes.forEach(node => {
        const entry = data.plans[node.id];
        if (!entry) { missing.push(node.id); return; }
        if (entry.arms) {
            node.arms = JSON.parse(JSON.stringify(entry.arms));
        } else if (entry.armCount !== node.arms.length) { // 舊版檔案僅存臂數
            mismatched.push(node.id); return;
        }
        node.plan = JSON.parse(JSON.stringify(entry.plan));
        applied.push(node.id);
    });
    lastIconState = {};
    lastFlowKey = {};
    updateSignals();
    rebuildTsdControls();
    updateTimeSpaceDiagram();
    if (allNodesOverlay.classList.contains('open')) buildAllNodesPanel();
    const editNode = state.nodes.find(n => n.id === editingNodeId);
    if (editNode) openEditor(editNode);
    return { applied, mismatched, missing };
}

// ─── 專案 / 方案目錄（projects/index.json）與網址參數 ?project=TY&plan=AM ──────────
// 以 http(s) 伺服器開啟時才會成功；直接雙擊開啟 index.html 時瀏覽器會擋 fetch 本機檔案，
// 此時選單為空、維持空專案，不影響其他功能。

const selProject = document.getElementById('select-project');
const selPlan = document.getElementById('select-plan');
let catalog = [];
let loadedProjectId = null; // 目前載入的目錄專案（null = 本機檔案或空專案）
let loadedPlanId = null;    // 目前載入的方案（'' = 專案沒有方案，時制存於 project.json）

function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(res => res.ok ? res.json() : Promise.reject(new Error(url)));
}

// 有方案時只列方案；沒有方案的專案才使用 project.json 內的時制
function fillPlanSelect(proj, planId) {
    const plans = proj.plans || [];
    selPlan.innerHTML = plans.length
        ? plans.map(p => `<option value="${p.id}">${p.name || p.id}</option>`).join('')
        : '<option value="">專案內建時制</option>';
    selPlan.value = planId;
}

// 選單還原為目前實際載入的專案 / 方案（取消切換或載入失敗時）
function restoreSelects() {
    const proj = catalog.find(p => p.id === loadedProjectId);
    if (proj) {
        selProject.value = proj.id;
        fillPlanSelect(proj, loadedPlanId);
    } else {
        selProject.selectedIndex = -1;
        selPlan.innerHTML = '';
    }
}

function syncUrl() {
    const params = new URLSearchParams({ project: loadedProjectId });
    if (loadedPlanId) params.set('plan', loadedPlanId);
    history.replaceState(null, '', '?' + params);
}

// 每次切換都重新讀取 project.json 再套方案，確保不殘留前一個方案的時制
function loadFromCatalog(projectId, planId) {
    const proj = catalog.find(p => p.id === projectId);
    if (!proj) return;
    const plans = proj.plans || [];
    if (!plans.some(p => p.id === planId)) planId = plans[0]?.id || '';
    selProject.value = proj.id;
    fillPlanSelect(proj, planId);
    const base = `projects/${proj.id}/`;
    Promise.all([fetchJson(base + 'project.json'), planId ? fetchJson(`${base}plans/${planId}.json`) : null])
        .then(([project, plan]) => {
            loadProjectData(project);
            if (plan) {
                const { mismatched, missing } = applyTimingPlans(plan);
                if (mismatched.length || missing.length) console.warn('方案未完整套用', { mismatched, missing });
                // 舊版的幹道設定存於 project.json 並以 planId 綁定
                state.tsdPresets = plan.tsdPresets || (state.tsdPresets || []).filter(p => p.planId === planId);
            }
            loadedProjectId = proj.id;
            loadedPlanId = planId;
            applyPresetForCurrentPlan();
            markSaved();
            syncUrl();
        })
        .catch(err => { restoreSelects(); alert('載入失敗：' + err.message); });
}

selProject.onchange = () => confirmDiscard() ? loadFromCatalog(selProject.value, '') : restoreSelects();
selPlan.onchange = () => confirmDiscard() ? loadFromCatalog(selProject.value, selPlan.value) : restoreSelects();

fetchJson('projects/index.json')
    .then(data => {
        catalog = data.projects || [];
        selProject.innerHTML = catalog.map(p => `<option value="${p.id}">${p.name || p.id}</option>`).join('');
        const q = new URLSearchParams(location.search);
        const pid = catalog.some(p => p.id === q.get('project')) ? q.get('project') : catalog[0]?.id;
        if (pid) loadFromCatalog(pid, q.get('plan') || '');
    })
    .catch(() => {});

// ─── 寫回專案資料夾（需以 server.py 啟動）────────────────────────────────────
// 僅供單人本機使用；部署給多人使用時需改用其他儲存方式。

let saveApi = false;
fetch('api/ping', { cache: 'no-store' })
    .then(res => { saveApi = res.ok; updateSaveUI(); })
    .catch(() => {});

function postSave(path, data) {
    return fetch('api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, data }),
    }).then(res => res.ok ? res : res.text().then(t => Promise.reject(new Error(t))));
}

// project.json：有方案時只存路口幾何；沒有方案（planId = ''）時連時制與幹道設定一起存
function buildProjectData(withTiming) {
    const data = {
        nodes: state.nodes.map(({ id, name, lat, lng, arms, plan }) =>
            withTiming ? { id, name, lat, lng, arms, plan } : { id, name, lat, lng, arms }),
    };
    if (withTiming) data.tsdPresets = state.tsdPresets || [];
    return data;
}

function saveToCatalog(planId) {
    const base = `projects/${loadedProjectId}/`;
    const jobs = [postSave(base + 'project.json', buildProjectData(!planId))];
    if (planId) jobs.push(postSave(`${base}plans/${planId}.json`, buildTimingPlansData()));
    return Promise.all(jobs);
}

document.getElementById('btn-save-as-plan').onclick = () => {
    const proj = catalog.find(p => p.id === loadedProjectId);
    if (!saveApi || !proj) return;
    const name = prompt('新方案名稱：', '');
    if (!name || !name.trim()) return;
    const id = prompt('方案代號（英數字、- 或 _，用於檔名與網址）：', '');
    if (!id) return;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return alert('代號只能使用英數字、- 或 _');
    if ((proj.plans || []).some(p => p.id === id)) return alert('此代號已存在');
    const oldPlans = proj.plans;
    proj.plans = [...(oldPlans || []), { id, name: name.trim() }];
    saveToCatalog(id)
        .then(() => postSave('projects/index.json', { projects: catalog }))
        .then(() => {
            loadedPlanId = id;
            fillPlanSelect(proj, id);
            syncUrl();
            markSaved();
            rebuildTsdControls();
            flashSaveButton('✅ 已另存');
        })
        .catch(err => { proj.plans = oldPlans; alert('存檔失敗：' + err.message); });
};

// ─── 未存檔提示 ─────────────────────────────────────────────────────────────
// 以快照比對判斷是否有修改，不必在每個編輯動作埋標記

let savedSnapshot = '';
let saveFlashUntil = 0;
function snapshotState() { return JSON.stringify([state.nodes, state.tsdPresets || []]); }
function isDirty() { return snapshotState() !== savedSnapshot; }
function markSaved() { savedSnapshot = snapshotState(); updateSaveUI(); }
function confirmDiscard() { return !isDirty() || confirm('有未儲存的修改，確定要放棄嗎？'); }

function flashSaveButton(text) {
    saveFlashUntil = Date.now() + 1500;
    document.getElementById('btn-save').textContent = text;
}

function updateSaveUI() {
    const btn = document.getElementById('btn-save');
    const dirty = isDirty();
    btn.classList.toggle('dirty', dirty);
    if (Date.now() > saveFlashUntil) btn.textContent = dirty ? '💾 儲存 ●' : '💾 儲存';
    const toCatalog = saveApi && loadedProjectId;
    btn.title = (dirty ? '有未儲存的修改 · ' : '') + (toCatalog ? '寫回專案資料夾' : '下載專案檔');
    document.getElementById('btn-save-as-plan').hidden = !toCatalog;
}

markSaved();
setInterval(updateSaveUI, 1000);
window.addEventListener('beforeunload', e => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
