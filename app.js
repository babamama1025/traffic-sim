// 初始化地圖
const map = L.map('map').setView([24.960, 121.225], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

// 系統核心狀態
let state = { nodes: [], links: [] };
let mode = 'SELECT';
let linkStartNode = null;
let selectedNodeId = null;
let currentPopup = null;
let justClosedPopup = false;
let markers = {};
let polylines = [];
let lastIconState = {}; // { [nodeId]: stateKey } — 避免無謂的 setIcon DOM 替換
let tsdPhaseSelection = {}; // { [nodeId]: number[] } — 時空圖各路口顯示時相（可多選）

// 模擬與時間變數
let simulationTime = 0;
let simInterval = null;
let simSpeed = 1;
let simStarted = false; // true after play pressed, false after reset
const clockEl = document.getElementById('clock');

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

// ─── 交通工程常數 ───────────────────────────────────────────────────────────

// 衝突對：同一時相內不可同時放行的動線組合
// 右轉為讓行動線，不列入燈號衝突矩陣
const CONFLICT_PAIRS = [
    // 直行 vs 直行（正交衝突）
    ['ebThru', 'nbThru'], ['ebThru', 'sbThru'],
    ['wbThru', 'nbThru'], ['wbThru', 'sbThru'],
    // 直行 vs 對向左轉（切穿對向車流）
    ['ebThru', 'wbLeft'], ['wbThru', 'ebLeft'],
    ['nbThru', 'sbLeft'], ['sbThru', 'nbLeft'],
    // 直行 vs 正交左轉（切穿正交車流）
    ['ebThru', 'nbLeft'], ['ebThru', 'sbLeft'],
    ['wbThru', 'nbLeft'], ['wbThru', 'sbLeft'],
    ['nbThru', 'ebLeft'], ['nbThru', 'wbLeft'],
    ['sbThru', 'ebLeft'], ['sbThru', 'wbLeft'],
    // 左轉 vs 左轉（非對向，路徑交叉）
    ['ebLeft', 'nbLeft'], ['ebLeft', 'sbLeft'],
    ['wbLeft', 'nbLeft'], ['wbLeft', 'sbLeft'],
];

const MOVEMENT_LABELS = {
    ebThru: '東向直行', ebLeft: '東向左轉', ebRight: '東向右轉',
    wbThru: '西向直行', wbLeft: '西向左轉', wbRight: '西向右轉',
    nbThru: '北向直行', nbLeft: '北向左轉', nbRight: '北向右轉',
    sbThru: '南向直行', sbLeft: '南向左轉', sbRight: '南向右轉',
};

// ─── 資料模型工廠 ────────────────────────────────────────────────────────────

function defaultMovements() {
    return {
        ebThru: false, ebLeft: false, ebRight: false,
        wbThru: false, wbLeft: false, wbRight: false,
        nbThru: false, nbLeft: false, nbRight: false,
        sbThru: false, sbLeft: false, sbRight: false,
    };
}

function defaultPhase(green = 45, yellow = 3, allRed = 1) {
    return { green, yellow, allRed, movements: defaultMovements() };
}

function defaultPlan() {
    const p1 = defaultPhase(45, 3, 1);
    p1.movements.ebThru = true; p1.movements.wbThru = true;
    const p2 = defaultPhase(45, 3, 1);
    p2.movements.nbThru = true; p2.movements.sbThru = true;
    const phases = [p1, p2];
    return { cycle: phases.reduce((s, p) => s + p.green + p.yellow + p.allRed, 0), offset: 0, phases };
}

// 舊格式（p1Green/p2Green/p1Dirs）升級為新格式
function migratePlan(old) {
    const p1 = defaultPhase(old.p1Green || 45, 3, 1);
    const p2 = defaultPhase(old.p2Green || 45, 3, 1);
    if (old.p1Dirs) {
        if (old.p1Dirs.thruEW) { p1.movements.ebThru = true; p1.movements.wbThru = true; }
        if (old.p1Dirs.thruNS) { p1.movements.nbThru = true; p1.movements.sbThru = true; }
        if (old.p1Dirs.leftEW) { p1.movements.ebLeft = true; p1.movements.wbLeft = true; }
        if (old.p1Dirs.leftNS) { p1.movements.nbLeft = true; p1.movements.sbLeft = true; }
    }
    if (old.p2Dirs) {
        if (old.p2Dirs.thruEW) { p2.movements.ebThru = true; p2.movements.wbThru = true; }
        if (old.p2Dirs.thruNS) { p2.movements.nbThru = true; p2.movements.sbThru = true; }
        if (old.p2Dirs.leftEW) { p2.movements.ebLeft = true; p2.movements.wbLeft = true; }
        if (old.p2Dirs.leftNS) { p2.movements.nbLeft = true; p2.movements.sbLeft = true; }
    }
    return { cycle: old.cycle || 120, offset: old.offset || 0, phases: [p1, p2] };
}

// ─── UI 模式切換 ─────────────────────────────────────────────────────────────

document.getElementById('btn-add-node').onclick = (e) => setMode('ADD_NODE', e.target);
document.getElementById('btn-add-link').onclick = (e) => setMode('ADD_LINK', e.target);
document.getElementById('btn-select').onclick = (e) => setMode('SELECT', e.target);

function setMode(newMode, btnEl) {
    mode = newMode;
    linkStartNode = null;
    selectedNodeId = null;
    map.closePopup();
    document.querySelectorAll('.control-group button').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    document.getElementById('editor-panel').style.display = 'none';
}

// ─── 建立路口 ────────────────────────────────────────────────────────────────

map.on('click', function(e) {
    if (mode === 'ADD_NODE' && !justClosedPopup) {
        const id = 'N_' + Date.now().toString().slice(-4);
        const nodeData = { id, name: '', lat: e.latlng.lat, lng: e.latlng.lng, bearing: 0, plan: defaultPlan() };
        state.nodes.push(nodeData);
        drawNode(nodeData);
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
        if (mode === 'ADD_LINK') handleLinkCreation(nodeData.id);
        else selectNode(nodeData);
    });
    marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        nodeData.lat = lat;
        nodeData.lng = lng;
        renderLinks();
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

// ─── 建立路段 ────────────────────────────────────────────────────────────────

function handleLinkCreation(nodeId) {
    if (!linkStartNode) {
        linkStartNode = nodeId;
    } else {
        if (linkStartNode !== nodeId) {
            state.links.push({ from: linkStartNode, to: nodeId });
            renderLinks();
            updateTimeSpaceDiagram();
        }
        linkStartNode = null;
    }
}

function renderLinks() {
    polylines.forEach(p => map.removeLayer(p));
    polylines = [];
    state.links.forEach(link => {
        const n1 = state.nodes.find(n => n.id === link.from);
        const n2 = state.nodes.find(n => n.id === link.to);
        if (n1 && n2) {
            const pl = L.polyline([[n1.lat, n1.lng], [n2.lat, n2.lng]], { color: '#444', weight: 5 }).addTo(map);
            polylines.push(pl);
        }
    });
}

// ─── 時制計畫編輯器 ──────────────────────────────────────────────────────────

let editingNodeId = null;

function openEditor(node) {
    editingNodeId = node.id;
    document.getElementById('editor-panel').style.display = 'block';
    document.getElementById('input-node-id').value = node.id;
    document.getElementById('input-node-name').value = node.name || '';
    document.getElementById('input-offset').value = node.plan.offset;
    document.getElementById('input-bearing').value = node.bearing || 0;
    renderPhaseEditor(node.plan);

    // 即時預覽方向角
    document.getElementById('input-bearing').oninput = () => {
        const n = state.nodes.find(n => n.id === editingNodeId);
        if (n) {
            const raw = parseInt(document.getElementById('input-bearing').value);
            const normalized = isNaN(raw) ? 0 : ((raw % 360) + 360) % 360;
            document.getElementById('input-bearing').value = normalized;
            n.bearing = normalized;
            updateSignals();
        }
    };

    // 刪除路口
    document.getElementById('btn-delete-node').onclick = () => {
        if (confirm(`確定要刪除路口 ${node.id}？此操作無法復原。`)) deleteNode(node.id);
    };
}

function deleteNode(nodeId) {
    if (markers[nodeId]) { map.removeLayer(markers[nodeId]); delete markers[nodeId]; }
    delete lastIconState[nodeId];
    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    state.links = state.links.filter(l => l.from !== nodeId && l.to !== nodeId);
    editingNodeId = null;
    selectedNodeId = null;
    currentPopup = null;
    document.getElementById('editor-panel').style.display = 'none';
    renderLinks();
    rebuildTsdControls();
    updateTimeSpaceDiagram();
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
    const div = document.createElement('div');
    div.className = 'phase-block';
    div.dataset.phaseIdx = idx;

    const approaches = [
        { key: 'eb', label: '東向 →' },
        { key: 'wb', label: '西向 ←' },
        { key: 'nb', label: '北向 ↑' },
        { key: 'sb', label: '南向 ↓' },
    ];

    let tableRows = '';
    approaches.forEach(ap => {
        const thruKey = ap.key + 'Thru';
        const leftKey = ap.key + 'Left';
        const rightKey = ap.key + 'Right';
        tableRows += `
            <tr>
                <td>${ap.label}</td>
                <td><input type="checkbox" class="mov-cb" data-key="${thruKey}" ${phase.movements[thruKey] ? 'checked' : ''}></td>
                <td><input type="checkbox" class="mov-cb" data-key="${leftKey}" ${phase.movements[leftKey] ? 'checked' : ''}></td>
                <td><input type="checkbox" class="mov-cb" data-key="${rightKey}" ${phase.movements[rightKey] ? 'checked' : ''}></td>
            </tr>`;
    });

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
            <tbody>${tableRows}</tbody>
        </table>
        <div class="conflict-warning" style="display:none;"></div>
    `;

    // 時相時間輸入：即時更新小計，並自動重算週期
    div.querySelectorAll('.phase-input').forEach(input => {
        input.addEventListener('input', () => {
            const g  = parseInt(div.querySelector('[data-field="green"]').value)  || 0;
            const y  = parseInt(div.querySelector('[data-field="yellow"]').value) || 0;
            const ar = parseInt(div.querySelector('[data-field="allRed"]').value) || 0;
            div.querySelector('.phase-duration').innerText = g + y + ar;
            syncPhaseFromDOM(); // 內部自動更新 plan.cycle 與 display-cycle
        });
    });

    // 動線勾選：即時衝突驗證
    div.querySelectorAll('.mov-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            syncPhaseFromDOM();
            validateAndShowConflicts();
        });
    });

    // 上移 / 下移時相
    div.querySelectorAll('.btn-phase-move').forEach(btn => {
        btn.addEventListener('click', () => {
            syncPhaseFromDOM();
            const node = state.nodes.find(n => n.id === editingNodeId);
            if (!node) return;
            const toIdx = idx + parseInt(btn.dataset.dir);
            if (toIdx < 0 || toIdx >= node.plan.phases.length) return;
            [node.plan.phases[idx], node.plan.phases[toIdx]] = [node.plan.phases[toIdx], node.plan.phases[idx]];
            renderPhaseEditor(node.plan);
        });
    });

    // 刪除時相
    const delEl = div.querySelector('.btn-del-phase');
    if (delEl) {
        delEl.addEventListener('click', () => {
            syncPhaseFromDOM();
            const node = state.nodes.find(n => n.id === editingNodeId);
            if (node) {
                node.plan.phases.splice(idx, 1);
                renderPhaseEditor(node.plan);
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
            state.links.forEach(l => {
                if (l.from === node.id) l.from = newId;
                if (l.to === node.id) l.to = newId;
            });
            node.id = newId;
            editingNodeId = newId;
        }
    }

    node.name = document.getElementById('input-node-name').value.trim();
    node.plan.offset = parseInt(document.getElementById('input-offset').value) || 0;
    const rawBearing = parseInt(document.getElementById('input-bearing').value);
    node.bearing = isNaN(rawBearing) ? 0 : ((rawBearing % 360) + 360) % 360;
    document.querySelectorAll('.phase-block').forEach((div, idx) => {
        const phase = node.plan.phases[idx];
        if (!phase) return;
        phase.green  = parseInt(div.querySelector('[data-field="green"]').value)  || 0;
        phase.yellow = parseInt(div.querySelector('[data-field="yellow"]').value) || 0;
        phase.allRed = parseInt(div.querySelector('[data-field="allRed"]').value) || 0;
        div.querySelectorAll('.mov-cb').forEach(cb => {
            phase.movements[cb.dataset.key] = cb.checked;
        });
    });
    refreshCycleDisplay(node.plan); // 自動更新 plan.cycle 與顯示
}

// 衝突驗證：在各時相區塊顯示警告，回傳是否有衝突
function validateAndShowConflicts() {
    const node = state.nodes.find(n => n.id === editingNodeId);
    if (!node) return true;
    let hasConflict = false;
    document.querySelectorAll('.phase-block').forEach((div, idx) => {
        const phase = node.plan.phases[idx];
        if (!phase) return;
        const conflicts = CONFLICT_PAIRS.filter(([a, b]) => phase.movements[a] && phase.movements[b]);
        const warnEl = div.querySelector('.conflict-warning');
        if (conflicts.length > 0) {
            hasConflict = true;
            const msgs = conflicts.map(([a, b]) => `${MOVEMENT_LABELS[a]} ✕ ${MOVEMENT_LABELS[b]}`).join('<br>');
            warnEl.style.display = 'block';
            warnEl.innerHTML = `<strong>⚠️ 衝突動線：</strong><br>${msgs}`;
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
        node.plan.phases.push(defaultPhase(20, 3, 1));
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
            return { phaseIndex: i, sigState: 'allRed', movements: null,
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
    if (!simStarted || !selectedNodeId) { panel.style.display = 'none'; return; }
    const node = state.nodes.find(n => n.id === selectedNodeId);
    if (!node) { panel.style.display = 'none'; return; }

    const plan = node.plan;
    let localTime = (simulationTime - plan.offset) % plan.cycle;
    if (localTime < 0) localTime += plan.cycle;

    const info = getDetailedPhaseInfo(plan, localTime);
    const stateLabels = { green: '🟢 綠燈', yellow: '🟡 黃燈', allRed: '🔴 全紅' };
    const phaseLabel = info.phaseIndex >= 0 ? `第 ${info.phaseIndex + 1} 時相` : '全紅（未分配）';
    const movList = info.movements
        ? Object.entries(info.movements).filter(([, v]) => v).map(([k]) => MOVEMENT_LABELS[k]).join('、')
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
        const movKey = movements
            ? Object.entries(movements).filter(([, v]) => v).map(([k]) => k).join(',')
            : '';
        const stateKey = `${sigState}|${movKey}|${isSelected}|${node.bearing || 0}|${phaseIndex}`;
        if (lastIconState[node.id] !== stateKey) {
            lastIconState[node.id] = stateKey;
            const marker = markers[node.id];
            if (marker) marker.setIcon(L.divIcon({
                className: 'intersection-icon',
                html: buildSignalSVG(sigState, movements, node.bearing || 0, isSelected, phaseIndex),
                iconSize: [44, 44],
            }));
        }
    });
    updateNodeStatusPanel();
}

function buildSignalSVG(sigState, movements, bearing = 0, selected = false, phaseIndex = -1) {
    const selRing = selected
        ? `<circle cx="20" cy="20" r="18" fill="none" stroke="#007bff" stroke-width="2.5" stroke-dasharray="5 2"/>`
        : '';
    const phaseTag = phaseIndex >= 0
        ? `<rect x="26" y="1" width="13" height="13" rx="2.5" fill="#333" opacity="0.82"/>` +
          `<text x="32.5" y="7.5" font-size="11" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="monospace">${phaseIndex + 1}</text>`
        : '';
    if (sigState === 'allRed' || !movements) {
        return `<svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="#dc3545"/>${selRing}${phaseTag}</svg>`;
    }
    const clr = sigState === 'yellow' ? '#ffc107' : '#28a745';
    const bg  = sigState === 'yellow' ? '#fffbe6' : 'white';

    // 收集直行路徑字串，後面重複使用（白色底襯 + 彩色上層）
    const thruData = [];
    if (movements.ebThru && movements.wbThru)
        thruData.push(`M 5,20 L 35,20 M 10,15 L 5,20 L 10,25 M 30,15 L 35,20 L 30,25`);
    else if (movements.ebThru)
        thruData.push(`M 5,20 L 35,20 M 30,15 L 35,20 L 30,25`);
    else if (movements.wbThru)
        thruData.push(`M 35,20 L 5,20 M 10,15 L 5,20 L 10,25`);

    if (movements.nbThru && movements.sbThru)
        thruData.push(`M 20,5 L 20,35 M 15,10 L 20,5 L 25,10 M 15,30 L 20,35 L 25,30`);
    else if (movements.nbThru)
        thruData.push(`M 20,35 L 20,5 M 15,10 L 20,5 L 25,10`);
    else if (movements.sbThru)
        thruData.push(`M 20,5 L 20,35 M 15,30 L 20,35 L 25,30`);

    // 層 1：圓環
    let p = `<circle cx="20" cy="20" r="16" fill="none" stroke="${clr}" stroke-width="2.5"/>`;

    // 層 2：左轉箭頭（L 形：直行進路 + 90° 彎，出口箭頭朝正確方向）
    // 控制點設計讓曲線起點切線 = 進路方向、終點切線 = 出口方向，形成清晰的直角彎。
    // 箭頭尖端 r≤13，確保完全在圓環內緣內（r=14.75）不被遮蔽。
    if (movements.ebLeft)   // 進路水平向右 y=14，轉北出口 (20,7)，箭頭朝上
        p += `<path d="M 5,14 L 17,14 Q 20,14 20,7 M 17,10 L 20,7 L 23,10" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.wbLeft)   // 進路水平向左 y=26，轉南出口 (20,33)，箭頭朝下
        p += `<path d="M 35,26 L 23,26 Q 20,26 20,33 M 23,30 L 20,33 L 17,30" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.nbLeft)   // 進路垂直向上 x=14，轉西出口 (7,20)，箭頭朝左
        p += `<path d="M 14,35 L 14,23 Q 14,20 7,20 M 10,23 L 7,20 L 10,17" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.sbLeft)   // 進路垂直向下 x=26，轉東出口 (33,20)，箭頭朝右
        p += `<path d="M 26,5 L 26,17 Q 26,20 33,20 M 30,17 L 33,20 L 30,23" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

    // 層 3：彩色直行箭頭（畫在左轉之後；同色疊畫，交叉點不產生視覺干擾）
    thruData.forEach(d => {
        p += `<path d="${d}" stroke="${clr}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    });

    // 層 5：右轉箭頭（L 形，與左轉對稱）
    // ebRight/wbRight 進路在 y=26/y=14（與 ebLeft/wbLeft 的 y=14/y=26 鏡像）
    // nbRight/sbRight 進路在 x=26/x=14（與 nbLeft/sbLeft 的 x=14/x=26 鏡像）
    if (movements.ebRight)  // 進路水平向右 y=26，轉南出口 (20,33)，箭頭朝下
        p += `<path d="M 5,26 L 17,26 Q 20,26 20,33 M 17,30 L 20,33 L 23,30" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.wbRight)  // 進路水平向左 y=14，轉北出口 (20,7)，箭頭朝上
        p += `<path d="M 35,14 L 23,14 Q 20,14 20,7 M 17,10 L 20,7 L 23,10" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.nbRight)  // 進路垂直向上 x=26，轉東出口 (33,20)，箭頭朝右
        p += `<path d="M 26,35 L 26,23 Q 26,20 33,20 M 30,17 L 33,20 L 30,23" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (movements.sbRight)  // 進路垂直向下 x=14，轉西出口 (7,20)，箭頭朝左
        p += `<path d="M 14,5 L 14,17 Q 14,20 7,20 M 10,17 L 7,20 L 10,23" stroke="${clr}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

    const inner = bearing ? `<g transform="rotate(${bearing}, 20, 20)">${p}</g>` : p;
    return `<svg width="40" height="40" viewBox="0 0 40 40" style="background:${bg}; border-radius:50%;">${inner}${selRing}${phaseTag}</svg>`;
}

// ─── 模擬引擎 ────────────────────────────────────────────────────────────────

const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const tsdBtnPlay = document.getElementById('tsd-btn-play');
const tsdBtnPause = document.getElementById('tsd-btn-pause');

function syncSimButtons(playClass, pauseClass) {
    btnPlay.className = playClass;
    btnPause.className = pauseClass;
    tsdBtnPlay.className = playClass;
    tsdBtnPause.className = pauseClass;
}
const selectSpeed = document.getElementById('select-speed');

selectSpeed.oninput = () => {
    simSpeed = parseInt(selectSpeed.value);
    document.getElementById('speed-display').textContent = simSpeed + 'x';
    if (simInterval) { stopTimer(); startTimer(); }
};

// 幹道時空圖 overlay 開關
const tsdOverlay = document.getElementById('tsd-overlay');
document.getElementById('btn-arterial').onclick = () => {
    tsdOverlay.classList.add('open');
    requestAnimationFrame(() => {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight || 300;
        rebuildTsdControls();
        updateTimeSpaceDiagram();
    });
};
document.getElementById('btn-close-tsd').onclick = () => tsdOverlay.classList.remove('open');
tsdOverlay.addEventListener('click', e => { if (e.target === tsdOverlay) tsdOverlay.classList.remove('open'); });

btnPlay.onclick = tsdBtnPlay.onclick = () => {
    simStarted = true;
    startTimer();
    syncSimButtons('btn-play-active', 'btn-inactive');
    document.getElementById('editor-panel').style.display = 'none';
};

btnPause.onclick = tsdBtnPause.onclick = () => {
    stopTimer();
    syncSimButtons('btn-inactive', 'btn-pause-active');
    if (editingNodeId) {
        const node = state.nodes.find(n => n.id === editingNodeId);
        if (node) openEditor(node);
    }
};

document.getElementById('btn-reset').onclick = () => {
    stopTimer();
    simStarted = false;
    simulationTime = 0;
    clockEl.innerText = 0;
    syncSimButtons('btn-inactive', 'btn-inactive');
    document.getElementById('node-status-panel').style.display = 'none';
    if (editingNodeId) {
        const node = state.nodes.find(n => n.id === editingNodeId);
        if (node) openEditor(node);
    }
    updateSignals();
    updateTimeSpaceDiagram();
};

function startTimer() {
    if (simInterval) return;
    simInterval = setInterval(() => {
        simulationTime += 1;
        clockEl.innerText = simulationTime;
        updateSignals();
        updateTimeSpaceDiagram();
    }, 1000 / simSpeed);
}

function stopTimer() {
    clearInterval(simInterval);
    simInterval = null;
}

// ─── 時空圖繪製（含黃燈色帶）────────────────────────────────────────────────

function rebuildTsdControls() {
    if (!tsdOverlay.classList.contains('open')) return;
    const container = document.getElementById('tsd-controls');
    const sortedNodes = [...state.nodes].sort((a, b) => a.lng - b.lng);
    container.innerHTML = '';
    sortedNodes.forEach(node => {
        const numPhases = node.plan.phases.length;
        // 初始化或清除超出範圍的索引
        if (!(node.id in tsdPhaseSelection) || !Array.isArray(tsdPhaseSelection[node.id])) {
            tsdPhaseSelection[node.id] = [0];
        } else {
            tsdPhaseSelection[node.id] = tsdPhaseSelection[node.id].filter(i => i < numPhases);
            if (tsdPhaseSelection[node.id].length === 0) tsdPhaseSelection[node.id] = [0];
        }

        const row = document.createElement('div');
        row.className = 'tsd-phase-sel';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = node.name || node.id;
        row.appendChild(nameSpan);

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

    const sortedNodes = [...state.nodes].sort((a, b) => a.lng - b.lng);
    const numNodes = sortedNodes.length;

    // 累積地理距離（公尺），用於縱軸比例定位
    const cumDist = [0];
    for (let i = 1; i < numNodes; i++)
        cumDist.push(cumDist[i - 1] + haversineM(sortedNodes[i - 1], sortedNodes[i]));
    const totalDist = cumDist[numNodes - 1] || 1;

    const padL = 72, padR = 20, padT = 20, padB = 30;
    const drawW = canvas.width - padL - padR;
    const drawH = canvas.height - padT - padB;
    const timeWindow = 240;
    const minTime = Math.max(0, simulationTime - timeWindow / 2);
    const maxTime = minTime + timeWindow;

    // 虛擬高度：路口數多時擴展，確保最小間距 50px；頂底各留 margin
    const MIN_SPACING = 50;
    const nodeTopMargin = 10, nodeBottomMargin = 30;
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

    // 將各路口色帶與標籤裁剪在可視範圍內
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, padT, canvas.width, drawH);
    ctx.clip();

    // 各路口號誌色帶
    sortedNodes.forEach((node, index) => {
        const ratio = numNodes === 1 ? 0.5 : cumDist[index] / totalDist;
        const y = padT + nodeTopMargin + ratio * (virtualDrawH - nodeTopMargin - nodeBottomMargin) - scrollY;

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
            const x = padL + ((t - minTime) / timeWindow) * drawW;
            ctx.fillRect(x, y + 2, 1, 10);
        }

        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + drawW, y); ctx.stroke();
    });

    ctx.restore();

    // 當前時間線（畫在 clip 外，跨越完整繪圖高度）
    const curX = padL + ((simulationTime - minTime) / timeWindow) * drawW;
    if (curX >= padL && curX <= padL + drawW) {
        ctx.strokeStyle = '#007bff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(curX, padT - 5); ctx.lineTo(curX, padT + drawH + 5); ctx.stroke();
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
        <label class="anc-field">方位角
            <input type="number" class="anc-input anc-bearing" value="${node.bearing || 0}" min="0" max="359"> °
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
                state.links.forEach(l => {
                    if (l.from === node.id) l.from = newId;
                    if (l.to === node.id) l.to = newId;
                });
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
        const rawBearing = parseInt(fieldsDiv.querySelector('.anc-bearing').value);
        node.bearing = isNaN(rawBearing) ? 0 : ((rawBearing % 360) + 360) % 360;
        updateSignals();
    };

    fieldsDiv.querySelector('.anc-id').addEventListener('change', syncBasic);
    fieldsDiv.querySelector('.anc-name').addEventListener('input', syncBasic);
    fieldsDiv.querySelector('.anc-offset').addEventListener('input', syncBasic);
    fieldsDiv.querySelector('.anc-bearing').addEventListener('input', syncBasic);

    // 時相區
    const phasesDiv = document.createElement('div');
    phasesDiv.className = 'anc-phases';
    body.appendChild(phasesDiv);

    const addPhaseBtn = document.createElement('button');
    addPhaseBtn.className = 'anc-add-phase';
    addPhaseBtn.textContent = '＋ 新增時相';
    addPhaseBtn.onclick = () => {
        node.plan.phases.push(defaultPhase(20, 3, 1));
        refreshCardPhases(card, node);
        rebuildTsdControls();
    };
    body.appendChild(addPhaseBtn);

    card.appendChild(body);
    refreshCardPhases(card, node);
    return card;
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
    const div = document.createElement('div');
    div.className = 'anc-phase-block';

    const canUp   = idx > 0;
    const canDown  = idx < node.plan.phases.length - 1;
    const canDel   = node.plan.phases.length > 1;

    // 時相標題列
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

    // 時相時間輸入
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

    // 上移 / 下移
    headerDiv.querySelectorAll('.anc-ph-btn[data-dir]').forEach(btn => {
        btn.addEventListener('click', () => {
            const toIdx = idx + parseInt(btn.dataset.dir);
            if (toIdx < 0 || toIdx >= node.plan.phases.length) return;
            [node.plan.phases[idx], node.plan.phases[toIdx]] = [node.plan.phases[toIdx], node.plan.phases[idx]];
            refreshCardPhases(card, node);
        });
    });

    // 刪除時相
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

    // 動線
    const movDiv = document.createElement('div');
    movDiv.className = 'anc-movements';
    const approaches = [
        { key: 'eb', label: '東→' },
        { key: 'wb', label: '西←' },
        { key: 'nb', label: '北↑' },
        { key: 'sb', label: '南↓' },
    ];
    approaches.forEach(ap => {
        const group = document.createElement('div');
        group.className = 'anc-mov-group';
        const apSpan = document.createElement('span');
        apSpan.className = 'anc-mov-approach';
        apSpan.textContent = ap.label;
        group.appendChild(apSpan);
        [['Thru', '直'], ['Left', '左'], ['Right', '右']].forEach(([turn, label]) => {
            const key = ap.key + turn;
            const lbl = document.createElement('label');
            lbl.className = 'anc-mov-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = phase.movements[key];
            cb.addEventListener('change', () => {
                phase.movements[key] = cb.checked;
                validateCardConflicts(div, phase);
                updateSignals();
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(label));
            group.appendChild(lbl);
        });
        movDiv.appendChild(group);
    });
    div.appendChild(movDiv);

    // 衝突警告
    const warnDiv = document.createElement('div');
    warnDiv.className = 'anc-conflict-warn';
    warnDiv.style.display = 'none';
    div.appendChild(warnDiv);
    validateCardConflicts(div, phase);

    return div;
}

function updateCardCycle(card, node) {
    node.plan.cycle = node.plan.phases.reduce((s, p) => s + p.green + p.yellow + p.allRed, 0);
    const el = card.querySelector('.anc-cycle');
    if (el) el.textContent = node.plan.cycle;
}

function validateCardConflicts(phaseDiv, phase) {
    const conflicts = CONFLICT_PAIRS.filter(([a, b]) => phase.movements[a] && phase.movements[b]);
    const warnEl = phaseDiv.querySelector('.anc-conflict-warn');
    if (!warnEl) return;
    if (conflicts.length > 0) {
        const msgs = conflicts.map(([a, b]) => `${MOVEMENT_LABELS[a]} ✕ ${MOVEMENT_LABELS[b]}`).join('<br>');
        warnEl.style.display = 'block';
        warnEl.innerHTML = `<strong>⚠️ 衝突動線：</strong><br>${msgs}`;
    } else {
        warnEl.style.display = 'none';
    }
}

// ─── 專案儲存 / 讀取 ─────────────────────────────────────────────────────────

document.getElementById('btn-save').onclick = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', 'traffic_project.json');
    a.click();
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

document.getElementById('file-load').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        Object.values(markers).forEach(m => map.removeLayer(m));
        markers = {};
        lastIconState = {};
        polylines.forEach(p => map.removeLayer(p));
        polylines = [];
        state = JSON.parse(event.target.result);
        // 自動升級舊格式
        state.nodes.forEach(node => {
            if (!node.plan.phases) node.plan = migratePlan(node.plan);
            drawNode(node);
        });
        renderLinks();
        updateSignals();
        tsdPhaseSelection = {};
        rebuildTsdControls();
        updateTimeSpaceDiagram();
        if (allNodesOverlay.classList.contains('open')) buildAllNodesPanel();
    };
    reader.readAsText(file);
});
