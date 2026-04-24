// ================================
// VERIFICACIONES DE FASE 2
// ================================
if (typeof window.escH !== "function") console.error("Falta normalizers.js");
if (typeof window.getColorByRMA !== "function") console.error("Falta colorUtils.js");
if (typeof window.t2m !== "function") console.error("Falta timeUtils.js");
if (typeof window.buscarRMA !== "function") console.error("Falta planificacion.js");
if (typeof window.calcCiclos !== "function") console.error("Falta planificacionCalculations.js");
console.log("Fase 2 Utils cargados:", { escH: typeof window.escH, getColorByRMA: typeof window.getColorByRMA, t2m: typeof window.t2m, buscarRMA: typeof window.buscarRMA, calcCiclos: typeof window.calcCiclos });

// ================================
// CONEXIÓN A SUPABASE
// ================================
// Se ha movido la inicialización a frontend/src/services/api.js
// La variable supabaseClient ya está declarada globalmente en api.js

// ================================
// PRUEBA DE CONEXIÓN
// ================================
async function probarConexionBT() {
  const { data, error } = await window.apiGetAllBtImprenta();

  if (error) {
    console.error("ERROR AL LEER bt_imprenta:", error);
    return;
  }

  console.log("DATOS bt_imprenta:", data);
}

// probarConexionBT();// ─────────────────────────────────────────────────────────────
//  DATA STORE
// ─────────────────────────────────────────────────────────────
const DATA = {
  btImprenta: { headers: [], rows: [] },
  noBarnizado: { headers: [], rows: [] },
  noTroquelado: { headers: ['COD IFA', 'ITEM'], rows: [] },
  noPegado: { headers: [], rows: [] },
};

// ─────────────────────────────────────────────────────────────
//  SCHEDULE CONSTANTS
// ─────────────────────────────────────────────────────────────
const STAGES = [
  { id: 'cortado', label: 'CORTADO', color: '#9f1239', machines: ['GUILLOTINA'] },
  { id: 'impresion', label: 'IMPRESIÓN', color: '#1e3a8a', machines: ['MOZP', 'SPEEDMASTER', 'GTO-52'] },
  { id: 'barnizado', label: 'BARNIZADO', color: '#14532d', machines: ['KORD 2', 'KORD 3'] },
  { id: 'troquelado', label: 'TROQUELADO', color: '#4a1d96', machines: ['TROQUELADORA 57', 'TROQUELADORA 72', 'TROQUELADORA 77', 'TROQUELADORA MERCEDES'] },
  { id: 'pegado', label: 'PEGADO', color: '#7c2d12', machines: ['PEGADORA'] },
];
const ALL_MACHINES = STAGES.flatMap(s => s.machines);
const DAYS = ['LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES'];

// 08:00 → 17:30  (11 slots)
function buildHourSlots() {
  const slots = [];
  for (let h = 8; h <= 17; h++) {
    slots.push({ label: `${String(h).padStart(2, '0')}:00`, start: h * 60, end: (h + 1) * 60 });
  }
  slots.push({ label: '17:30', start: 17 * 60 + 30, end: 18 * 60 });
  return slots; // 11 slots total
}
const HOUR_SLOTS = buildHourSlots();

// ─────────────────────────────────────────────────────────────
//  SHARED STATE
// ─────────────────────────────────────────────────────────────
// Shared date range (persists between General ↔ Etapa)
const schedDateRange = { start: '', end: '' };

const schedState = {
  lunchStart: '13:00',
  lunchEnd: '14:00',
  lunchEnabled: false,
  nightShifts: [],
  configPanelOpen: false,
  cells: {},
};

// Módulo Planificación - Lista de RMAs consultados en la sesión
let rmaSessionList = [];


function initScheduleState() {
  ALL_MACHINES.forEach(m => {
    if (!schedState.cells[m]) {
      schedState.cells[m] = {};
      DAYS.forEach((_, di) => {
        schedState.cells[m][di] = {};
        HOUR_SLOTS.forEach((_, si) => { schedState.cells[m][di][si] = ''; });
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  APP STATE
// ─────────────────────────────────────────────────────────────
let sidebarCollapsed = false;
let activeMenu = null;
let activeSubMenu = null;
let tablaDropdownOpen = false;   // ONLY this controls the dropdown
let scheduleZoom = 1;
let autocompleteSelected = -1;

// ─────────────────────────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const navList = document.getElementById('nav-list');
const pageTitle = document.getElementById('page-title');
const contentBody = document.getElementById('content-body');
const headerActions = document.getElementById('header-actions');
const btnExportDots = document.getElementById('btn-export-dots');
const exportDropdown = document.getElementById('export-dropdown');
const btnExportExcel = document.getElementById('btn-export-excel');
const autocompleteEl = document.getElementById('autocomplete-dropdown');

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
// Funciones escH, getColorByRMA y getCleanTroquelKey movidas a utils/

// ─────────────────────────────────────────────────────────────
//  CSV HELPERS
// ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === sep && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
  return { headers, rows };
}
async function loadCSV(path) { const r = await fetch(path); if (!r.ok) throw new Error('HTTP ' + r.status); return parseCSV(await r.text()); }
async function loadEmbeddedOrCSV(path, key) {
  const txt = window.CSV_DATA?.[key];
  if (txt && txt.includes('\n')) return parseCSV(txt);
  return loadCSV(path);
}

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // FASE 1: Carga de BT Imprenta desde Supabase
  try {
    if (supabaseClient) {
      const { data, error } = await window.apiGetAllBtImprenta();

      if (error) throw error;

      if (data && data.length > 0) {
        // Obtenemos los encabezados de las llaves del primer objeto
        const headers = Object.keys(data[0]);
        DATA.btImprenta = { headers, rows: data };
        console.log("Fase 1: Datos de BT Imprenta cargados desde Supabase correctamente.");
      } else {
        console.warn("La tabla bt_imprenta está vacía en Supabase.");
      }
    } else {
      throw new Error("Supabase Client no está inicializado.");
    }
  } catch (err) {
    console.error("Error al cargar datos de Supabase (bt_imprenta):", err);
    // Fallback de emergencia usando window.BT_LOOKUP si existe en data.js
    const lookup = window.BT_LOOKUP || [];
    const headers = ['CÓDIGO', 'CÓDIGO DE PLANTA', 'CÓDIGO DE PLANTA2', 'MATERIAL', 'PRODUCTOS', 'INSUMO', 'PRESENTACIÓN', 'TIPO', 'LÍNEA'];
    DATA.btImprenta = { headers, rows: lookup.map(item => Object.fromEntries(headers.map((h, i) => [h, i === 0 ? item.c : i === 4 ? item.p : '']))) };
  }

  try { DATA.noBarnizado = await loadEmbeddedOrCSV('Tabla No Barnizado.csv', 'noBarnizado'); } catch { DATA.noBarnizado = { headers: ['COD IFA', 'PRODUCTO (NO SE BARNIZA)'], rows: [] }; }
  try { DATA.noPegado = await loadEmbeddedOrCSV('Tabla No Pegado.csv', 'noPegado'); } catch { DATA.noPegado = { headers: ['COD IFA', 'PRODUCTO (NO SE PEGA)'], rows: [] }; }
  initScheduleState();
  renderNav();
  renderContent();
  setupSidebarToggle();
  setupExportMenu();
  setupKeyboard();
  setupContextMenu();
});

// ─────────────────────────────────────────────────────────────
//  KEYBOARD & ZOOM
// ─────────────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); changeZoom(+0.1); }
    if (e.key === '-') { e.preventDefault(); changeZoom(-0.1); }
    if (e.key === '0') { e.preventDefault(); changeZoom(0, true); }
  });
  document.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault(); changeZoom(e.deltaY < 0 ? +0.1 : -0.1);
  }, { passive: false });
}
function changeZoom(delta, reset = false) {
  if (!['general', 'etapa'].includes(activeMenu)) return;
  scheduleZoom = reset ? 1 : Math.min(2.5, Math.max(0.3, scheduleZoom + delta));

  // Support both old and new architecture containers
  const c = document.getElementById('gantt-root') || document.getElementById('schedule-table-container');
  if (c) c.style.zoom = scheduleZoom;

  const b = document.getElementById('zoom-badge-pct');
  if (b) b.textContent = Math.round(scheduleZoom * 100) + '%';
}

// ─────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────
function setupSidebarToggle() {
  sidebarToggle.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
  });
}

function renderNav() {
  navList.innerHTML = '';

  [
    { id: 'planificacion', title: 'Planificación', icon: 'uil-file-edit-alt' },
    { id: 'general', title: 'Cronograma General', icon: 'uil-calender' },
    { id: 'etapa', title: 'Cronograma por Etapa', icon: 'uil-layer-group' },
    { id: 'tiempos', title: 'Tiempos', icon: 'uil-clock-three' },
  ].forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="nav-item ${activeMenu === item.id ? 'active' : ''}" data-id="${item.id}">
      <i class="uil ${item.icon}"></i>
      <span class="nav-text">${item.title}</span>
      <span class="nav-tooltip">${item.title}</span>
    </div>`;
    li.querySelector('.nav-item').addEventListener('click', () => selectMenu(item.id));
    navList.appendChild(li);
  });
}

function selectMenu(id) {
  if (activeMenu === id && !activeSubMenu) return;
  activeMenu = id; activeSubMenu = null;
  tablaDropdownOpen = false;              // close dropdown when leaving via top-level item
  schedState.configPanelOpen = false;
  renderNav(); renderContent();
}

function selectSubMenu(subId) {
  activeMenu = 'tabla'; activeSubMenu = subId; tablaDropdownOpen = true;
  renderNav(); renderContent();
}

// ─────────────────────────────────────────────────────────────
//  CONTENT ROUTER
// ─────────────────────────────────────────────────────────────
function renderContent() {
  contentBody.className = 'content-body';
  setTimeout(() => contentBody.classList.add('fade-in'), 10);
  headerActions.style.display = 'none';
  if (!activeMenu) {
    pageTitle.textContent = 'Bienvenido';
    contentBody.innerHTML = `<div class="empty-state"><i class="uil uil-apps"></i><h2>Panel Principal</h2><p>Selecciona una opción del menú lateral para continuar.</p></div>`;
    return;
  }
  if (activeMenu === 'planificacion') { pageTitle.textContent = ''; return window.renderPlanificacion(); }

  if (activeMenu === 'general') { pageTitle.textContent = 'Cronograma General'; return renderCronogramaGeneral(); }
  if (activeMenu === 'etapa') { pageTitle.textContent = 'Cronograma por Etapa'; return renderCronogramaPorEtapa(); }
  if (activeMenu === 'tiempos') {
    pageTitle.textContent = 'Tiempos';
    contentBody.innerHTML = `<div class="empty-state"><i class="uil uil-clock-three"></i><h2>Tiempos</h2><p>Próximamente.</p></div>`;
    return;
  }
  contentBody.innerHTML = `<div class="empty-state"><i class="uil uil-construction"></i><h2>En construcción</h2></div>`;
}

// ─────────────────────────────────────────────────────────────
//  PLANIFICACIÓN (RMA SEARCH)
// ─────────────────────────────────────────────────────────────
// renderPlanificacion se movió a frontend/src/modules/planificacion.js

const SPECIAL_COD_IFAS = [
  'IFA-01508', 'IFA-01468', 'IFA-01504', 'IFA-01527', 'IFA-01372',
  'IFA-01493', 'IFA-03842', 'IFA-01531', 'IFA-01543', 'IFA-01546'
];

// renderRMATable se movió a frontend/src/modules/planificacion.js

// Helper para normalizar comparaciones entre tablas (RMA vs BT Imprenta)
// normCol y normMaq movidas a frontend/src/utils/normalizers.js

// updateRmaMaquina se movió a frontend/src/modules/planificacion.js


async function cargarDatosTecnicos(refocusIdx = null) {
  if (rmaSessionList.length === 0) return;

  if (!supabaseClient) {
    showSaveToast("Error: Sin conexión a Supabase");
    return;
  }

  const codigos = [...new Set(rmaSessionList.map(item => item.codigo_material))].filter(Boolean);
  if (codigos.length === 0) return;

  showSaveToast("Calculando datos técnicos...");

  try {
    const { data, error } = await window.apiGetBtImprentaByCodigos(codigos);

    if (error) throw error;

    // console.log("[DEBUG-PLANIFICACION] Respuesta de BT Imprenta:", data);

    rmaSessionList.forEach(item => {
      const searchKey = normCol(item.codigo_material);
      const isSpecial = SPECIAL_COD_IFAS.map(c => normCol(c)).includes(searchKey);

      let btData = null;

      if (isSpecial) {
        const userMaq = normMaq(item.maquina);
        // console.log(`[DEBUG-PLANIFICACION] Caso Especial Detectado: ${searchKey}`);

        if (!userMaq) {
          // console.log(`[DEBUG-PLANIFICACION] Omitiendo match especial para ${searchKey} porque MAQUINA está vacía.`);
        } else {
          // Double match: Codigo + Maquina Preferencial (Normalización robusta de máquina)
          btData = data ? data.find(row =>
            normCol(row.codigo) === searchKey &&
            normMaq(row.maquina_preferencial) === userMaq
          ) : null;

          // console.log(`[DEBUG-PLANIFICACION] Buscando Match Especial (UserMaq: ${userMaq}):`, btData ? "SÍ" : "NO");
        }
      } else {

        // Lógica Normal: Primer match por código
        btData = data ? data.find(row => normCol(row.codigo) === searchKey) : null;
      }

      // Datos Base de BT
      item.n_troquel = btData?.n_troquel || '-';
      item.un_tiraje = btData?.cajas_por_tiraje || '-';
      item.codigo_2 = btData?.codigo_2 || '';

      const tirajesPliego = parseFloat(btData?.tirajes_por_pliego);


      // 1. CÁLCULO DE CICLOS
      const ciclosCalc = window.calcCiclos(item.n_colores, item.maquina, item.material_requerido);
      item.ciclos = ciclosCalc !== null ? ciclosCalc : '-';

      // 2. CÁLCULO DE TIRAJES (+10% margen de seguridad)
      const tirajesCalc = window.calcTirajes(item.cantidad_requerida_para_cubrir, tirajesPliego);
      item.tirajes = tirajesCalc !== null ? tirajesCalc : '-';
    });

    const container = document.getElementById('rma-list-container');
    if (container) {
      container.innerHTML = window.renderRMATable();

      if (refocusIdx !== null) {
        setTimeout(() => {
          const nextInput = container.querySelector(`.plan-maquina-input[data-idx="${refocusIdx}"]`);
          if (nextInput) {
            nextInput.focus();
            // Move cursor to the end
            const val = nextInput.value;
            nextInput.value = '';
            nextInput.value = val;
          }
        }, 0);
      }
    }
    showSaveToast("Cálculos completados");
  } catch (err) {
    console.error("Error en carga técnica v4:", err);
    showSaveToast("Error al procesar cálculos técnicos");
  }
}


// buscarRMA se movió a frontend/src/modules/planificacion.js


// ─────────────────────────────────────────────────────────────
//  DATE BAR (shared across General & Etapa)
// ─────────────────────────────────────────────────────────────
function buildDateBarHTML(viewId) {
  const fsBtn = viewId === 'eta' ? `
    <button class="sched-fullscreen-btn" id="sched-fullscreen-btn" title="Pantalla completa">
      <i class="uil uil-expand" id="sched-fullscreen-icon"></i>
    </button>` : '';
  return `
    <div class="sched-datebar">
      <div class="sched-datebar-fields">
        <div class="sched-date-group">
          <span class="sched-date-label">Inicio</span>
          <input type="date" class="sched-date-input" id="sched-date-start-${viewId}" value="${schedDateRange.start}">
        </div>
        <span class="sched-date-sep">→</span>
        <div class="sched-date-group">
          <span class="sched-date-label">Fin</span>
          <input type="date" class="sched-date-input" id="sched-date-end-${viewId}" value="${schedDateRange.end}">
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${fsBtn}
        <div class="sched-export-wrap">
          <button class="sched-export-btn" id="sched-export-btn-${viewId}" title="Opciones"><i class="uil uil-ellipsis-v"></i></button>
          <div class="sched-export-dropdown" id="sched-export-dd-${viewId}">
            <button class="export-option" id="sched-export-excel-${viewId}">Exportar a Excel (.csv)</button>
            ${viewId === 'eta' ? `
              <div class="export-divider"></div>
              <button class="export-option" data-action="lunch">Definir hora de almuerzo</button>
              <button class="export-option" data-action="night">Horario nocturno</button>
            ` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function wireDateBar(viewId, exportFn) {
  const ds = document.getElementById(`sched-date-start-${viewId}`);
  const de = document.getElementById(`sched-date-end-${viewId}`);
  if (ds) ds.addEventListener('change', () => { schedDateRange.start = ds.value; });
  if (de) de.addEventListener('change', () => { schedDateRange.end = de.value; });
  const btn = document.getElementById(`sched-export-btn-${viewId}`);
  const dd = document.getElementById(`sched-export-dd-${viewId}`);
  if (btn && dd) {
    btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('open'); });
    document.addEventListener('click', () => dd?.classList.remove('open'), { once: false });
  }
  const excelBtn = document.getElementById(`sched-export-excel-${viewId}`);
  if (excelBtn) excelBtn.addEventListener('click', () => { dd?.classList.remove('open'); exportFn(); });

  // Event Delegation for config options
  if (viewId === 'eta' && dd) {
    dd.addEventListener('click', e => {
      const btn = e.target.closest('.export-option');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'lunch') { dd.classList.remove('open'); showGanttModal('lunch'); }
      if (action === 'night') { dd.classList.remove('open'); showGanttModal('night'); }
    });
  }
}

function wireFullscreenBtn() {
  const btn = document.getElementById('sched-fullscreen-btn');
  const icon = document.getElementById('sched-fullscreen-icon');
  if (!btn || !icon) return;

  function updateIcon() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    icon.className = isFs ? 'uil uil-compress' : 'uil uil-expand';
    btn.title = isFs ? 'Salir de pantalla completa' : 'Pantalla completa';
  }

  btn.addEventListener('click', () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const el = document.getElementById('app-container');
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  });

  document.addEventListener('fullscreenchange', updateIcon);
  document.addEventListener('webkitfullscreenchange', updateIcon);
}

function zoomBadgeHTML() {
  return `<div class="zoom-badge"><i class="uil uil-search-plus"></i><span id="zoom-badge-pct">${Math.round(scheduleZoom * 100)}%</span></div>`;
}

// ─────────────────────────────────────────────────────────────
//  CRONOGRAMA GENERAL
//  Rows = Days (5 × one row each, no hour breakdown)
//  Cols = Stages (5)
//  Headers: white text on two red tones
// ─────────────────────────────────────────────────────────────
function renderCronogramaGeneral() {
  scheduleZoom = 1;

  // Stage column headers — bright red bg
  let headHTML = `<th style="
    background:#c81e33; position:sticky; top:0; left:0; z-index:14;
    min-width:90px; width:90px;
    border-right:2px solid rgba(255,255,255,.2); border-bottom:2px solid rgba(255,255,255,.15);
    box-shadow:2px 2px 8px rgba(0,0,0,.15);
  "></th>`;

  STAGES.forEach(s => {
    headHTML += `<th style="
      background:#c81e33; color:#fff;
      font:700 11.5px 'Outfit',sans-serif; text-transform:uppercase; letter-spacing:2px;
      text-align:center; padding:11px 20px;
      border-left:2px solid rgba(255,255,255,.2);
      border-bottom:2px solid rgba(255,255,255,.15);
      min-width:160px;
      position:sticky; top:0; z-index:9;
      white-space:nowrap;
      box-shadow:0 2px 6px rgba(0,0,0,.12);
      overflow:visible;
    " data-stage-key="${s.id}">${s.label}<div class="resize-col-handle"></div></th>`;
  });

  // Body: one row per day
  let bodyHTML = '';
  DAYS.forEach((day, di) => {
    const isLast = di === DAYS.length - 1;
    let cells = `<td class="sched-gen-day" style="
      background:#991b1b; color:#fff;
      font:800 11px 'Outfit',sans-serif; text-transform:uppercase; letter-spacing:3px;
      writing-mode:vertical-rl; transform:rotate(180deg);
      text-align:center; padding:12px 8px; height:100px;
      border-right:2px solid rgba(255,255,255,.2);
      ${!isLast ? 'border-bottom:1px solid rgba(255,255,255,.1);' : ''}
      position:sticky; left:0; z-index:5;
      box-shadow:2px 0 6px rgba(0,0,0,.08);
    ">${day}</td>`;

    STAGES.forEach((s, si) => {
      cells += `<td class="sched-cell gen-cell"
        data-day="${di}" data-stageidx="${si}"
        title="${day} · ${s.label}"
        style="min-width:160px;height:100px;border-left:2px solid #f0f0f0;${!isLast ? 'border-bottom:1px solid var(--border-color);' : ''}vertical-align:middle;text-align:center;background:#fff;">
      </td>`;
    });
    bodyHTML += `<tr>${cells}</tr>`;
  });

  contentBody.innerHTML = `
    ${buildDateBarHTML('gen')}
    <div class="schedule-outer" style="flex:1;overflow:hidden;position:relative;">
      <div class="schedule-wrap">
        <div class="schedule-scroll">
          <div class="schedule-table-container" id="schedule-table-container">
            <table class="sched-table" style="border-collapse:collapse;width:auto;">
              <thead><tr>${headHTML}</tr></thead>
              <tbody>${bodyHTML}</tbody>
            </table>
          </div>
        </div>
      </div>
      ${zoomBadgeHTML()}
    </div>`;

  wireDateBar('gen', exportCronogramaGeneral);

  // Cell click
  contentBody.querySelectorAll('.gen-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const si = +cell.dataset.stageidx;
      const s = STAGES[si];
      cell._on = !cell._on;
      cell.style.background = cell._on ? '#fff1f2' : '#fff';
      cell.innerHTML = cell._on ? `<span class="sched-chip" style="background:${s.color};">✓</span>` : '';
    });
  });

  // Make day rows and stage columns resizable
  setTimeout(() => initResizable('general'), 60);
}

function exportCronogramaGeneral() {
  const startLbl = schedDateRange.start || '—';
  const endLbl = schedDateRange.end || '—';
  let csv = `\uFEFFCronograma General (${startLbl} → ${endLbl})\r\n`;
  csv += 'DÍA;' + STAGES.map(s => s.label).join(';') + '\r\n';
  document.querySelectorAll('#schedule-table-container tbody tr').forEach((tr, di) => {
    const row = [DAYS[di]];
    tr.querySelectorAll('td:not(:first-child)').forEach(td => {
      row.push(td.querySelector('.sched-chip') ? '✓' : '');
    });
    csv += row.join(';') + '\r\n';
  });
  dlCsv(csv, `Cronograma_General_${fmtDate()}.csv`);
}

// ─────────────────────────────────────────────────────────────
// LÓGICA DE CÁLCULO DE BLOQUES - IMPRESIÓN OFFSET
// ─────────────────────────────────────────────────────────────
let scheduledBlocks = {
  'SPEEDMASTER': {},
  'MOZP': {},
  'GTO-52': {}
};

const TURNO_INICIO = 480;
const TURNO_FIN = 1050;
const MINUTOS_TOTALES_DIA = 570;

// mkTimeFromMins movido a timeUtils.js

// ─────────────────────────────────────────────────────────────
//  LOGICA FASE 1: AGRUPAMIENTO Y CICLOS
// ─────────────────────────────────────────────────────────────
// normalizeColors, isValidColorCode, getColorsPerCycle movidas a colorUtils.js

// buildScheduleLogicStructure se movió a frontend/src/modules/impresionLogic.js

// ─────────────────────────────────────────────────────────────
//  COLOR IDENTITY SYSTEM (Hybrid: Palette + Deterministic Variants)
// ─────────────────────────────────────────────────────────────

// EXEC_PALETTE_HSL, getHash, getColorInfoByRMA, getColorByRMA movidas a colorUtils.js

async function generarCronogramaEtapa() {
  if (rmaSessionList.length === 0) {
    showSaveToast("Agrega RMAs en Planificación primero");
    return;
  }

  if (!supabaseClient) {
    showSaveToast("Error: Sin conexión a Supabase (Tiempos)");
    return;
  }

  showSaveToast("Calculando Cronograma...");

  try {
    const { data: tiemposData, error } = await window.apiGetAllTiempos();
    if (error) throw error;

    ALL_MACHINES.forEach(m => scheduledBlocks[m] = {});
    const rmaFinishTracker = {}; // Para controlar la dependencia de Barnizado: { [rma]: absMins }

    const queues = {};
    ALL_MACHINES.forEach(m => queues[m] = []);
    rmaSessionList.forEach(item => {
      let mqKey = null;
      if (item.maquina === 'SPEEDMASTER' || item.maquina === 'MOZP' || item.maquina === 'GTO-52') {
        mqKey = item.maquina;
      }
      if (mqKey) queues[mqKey].push(item);
    });

    // FASE 1: Construir estructura lógica intermedia
    const logicBase = window.buildScheduleLogicStructure(queues, DATA.btImprenta.rows || []);
    window.cronogramaLogicBase = logicBase;
    console.log("FASE 1: Estructura lógica construida:", logicBase);

    // Resumen simplificado para validación en consola
    const summary = [];
    ['SPEEDMASTER', 'MOZP', 'GTO-52'].forEach(m => {
      Object.keys(logicBase[m]).forEach(l => {
        Object.keys(logicBase[m][l]).forEach(c => {
          const group = logicBase[m][l][c];
          summary.push({
            Máquina: m,
            Línea: l,
            SetColores: c,
            Productos: group.items.map(i => i.rma).join(', '),
            Validos: group.items.filter(i => i.isValid).length,
            Invalidos: group.items.filter(i => !i.isValid).length
          });
        });
      });
    });
    if (summary.length > 0) console.table(summary);

    window.scheduleImpresionStage(
      logicBase,
      tiemposData,
      scheduledBlocks,
      rmaFinishTracker,
      TURNO_INICIO,
      TURNO_FIN
    );

    console.log("FASE 2: Empezando etapa de Barnizado. RMAs con fin de impresión:", Object.keys(rmaFinishTracker));

    // --- ETAPA 2: BARNIZADO (Motor de Optimización por Troquel) ---
    const barnizadoJobFinishTracker = window.scheduleBarnizadoStage(
      rmaSessionList,
      rmaFinishTracker,
      tiemposData,
      scheduledBlocks,
      TURNO_INICIO,
      TURNO_FIN
    );

    // --- ETAPA 3: TROQUELADO (Motor de Optimización por Troquel y Recursos Globales) ---
    window.scheduleTroqueladoStage(
      rmaSessionList,
      barnizadoJobFinishTracker,
      tiemposData,
      scheduledBlocks,
      TURNO_INICIO,
      TURNO_FIN
    );

    if (activeMenu !== 'etapa') {
      selectMenu('etapa');
    } else {
      renderCronogramaPorEtapa();
    }
    showSaveToast("Cronograma calculado exitosamente");

  } catch (err) {
    console.error("Error generating cronograma:", err);
    showSaveToast("Error al generar cronograma");
  }
}

// ─────────────────────────────────────────────────────────────
//  CRONOGRAMA POR ETAPA
//  COLUMNS = Machines grouped by Stage (with 2-row headers)
//  ROWS    = Days × Hour slots (08:00–17:30, 11 slots each day)
//  Header row 1: [corner colspan=2] + stage groups
//  Header row 2: [DAY col] [HOUR col] + machine names
//  Day cell in body: writing-mode vertical rotated 180° (bottom→top), rowspan=SLEN
//  Machine header: writing-mode vertical-rl (top→bottom, 90°)
// ─────────────────────────────────────────────────────────────
function renderCronogramaPorEtapa() {
  scheduleZoom = 1;
  const HOUR_W = 75, DAY_W = 30, CELL_W = 189, ROW_H = 40, HR1_H = 38, HR2_H = 52;

  // 1. BOUNDARIES
  let allTimeBoundaries = [];
  const lStart = t2m(schedState.lunchStart), lEnd = t2m(schedState.lunchEnd);

  DAYS.forEach((_, di) => {
    // Basic boundaries + ALWAYS include lunch if enabled
    let timeSet = new Set([480, 1080]);
    if (schedState.lunchEnabled && lStart && lEnd) {
      if (lStart >= 480 && lStart <= 1080) timeSet.add(lStart);
      if (lEnd >= 480 && lEnd <= 1080) timeSet.add(lEnd);
    }
    // Include all task starts/ends
    ALL_MACHINES.forEach(m => {
      (scheduledBlocks[m]?.[di] || []).forEach(b => {
        timeSet.add(Math.round(b.startMin));
        timeSet.add(Math.round(b.startMin + b.duration));
      });
    });
    allTimeBoundaries.push(Array.from(timeSet).sort((a, b) => a - b));
  });

  let dayHeights = allTimeBoundaries.map(bounds => (bounds.length - 1) * ROW_H);
  let dayOffsets = [0];
  for (let i = 0; i < dayHeights.length; i++) dayOffsets.push(dayOffsets[i] + dayHeights[i] + 10);
  const totalGanttHeight = dayOffsets[dayOffsets.length - 1];

  // 2. PANELS CONSTRUCTION
  const cornerHTML = `<div class="gantt-corner">
    <div style="height:${HR1_H}px; display:flex; align-items:center; justify-content:center; font:700 10px Outfit; color:#ffffff; background:#c81e33; border-bottom:1px solid rgba(255,255,255,.2);">08:00–17:30</div>
    <div style="height:${HR2_H}px; display:flex; background:#7f1d1d;">
      <div style="width:${HOUR_W}px; border-right:1px solid rgba(255,255,255,.2); display:flex; align-items:center; justify-content:center; font:600 11px Outfit; color:#ffffff;">HORA</div>
      <div style="width:${DAY_W}px; display:flex; align-items:center; justify-content:center; font:600 11px Outfit; color:#ffffff;">DÍA</div>
    </div>
  </div>`;

  let stageHeaders = '', machineHeaders = '';
  STAGES.forEach(stg => {
    stageHeaders += `<div class="gantt-header-stage-cell" style="width:${stg.machines.length * CELL_W}px;">${stg.label}</div>`;
    stg.machines.forEach(m => {
      machineHeaders += `<div class="gantt-header-mach-cell" data-machine="${m}" style="width:${CELL_W}px;">${m}</div>`;
    });
  });

  let sidebarHTML = '';
  DAYS.forEach((day, di) => {
    let hours = '';
    const bounds = allTimeBoundaries[di];
    const sIdx = bounds.indexOf(lStart), eIdx = bounds.indexOf(lEnd);

    for (let r = 0; r < bounds.length - 1; r++) {
      const b1 = bounds[r], b2 = bounds[r + 1];
      const isLunchArea = (schedState.lunchEnabled && r >= sIdx && r < eIdx && sIdx !== -1 && lStart !== lEnd);
      const isFirstLunchSlot = (r === sIdx);

      hours += `<div class="gantt-sidebar-hour ${isLunchArea ? 'gantt-lunch-row' : ''}" style="height:${ROW_H}px; background:${isLunchArea ? '' : '#7f1d1d'}; color:#ffffff;">
        ${(isLunchArea && isFirstLunchSlot) ? 'ALM' : (isLunchArea ? '' : mkTimeFromMins(b1))}
      </div>`;
    }
    sidebarHTML += `<div style="display:flex; height:${dayHeights[di]}px;"><div style="flex-direction:column;">${hours}</div><div class="gantt-sidebar-day" style="width:${DAY_W}px;"><div class="gantt-day-text">${day}</div></div></div><div style="height:10px; background:#e5e7eb; width:100%;"></div>`;
  });

  let bodyColumnsHTML = '';
  // Calculate grid overlay (lunch band) ONCE per day, consolidated
  let gridOverlay = '';
  DAYS.forEach((_, di) => {
    const bounds = allTimeBoundaries[di], off = dayOffsets[di];
    if (schedState.lunchEnabled && lStart && lEnd && lStart !== lEnd) {
      const sIdx = bounds.indexOf(lStart), eIdx = bounds.indexOf(lEnd);
      if (sIdx >= 0 && eIdx >= 0) {
        const t = sIdx * ROW_H + off, h = (eIdx - sIdx) * ROW_H;
        gridOverlay += `<div class="gantt-body-lunch-band" style="top:${t}px; height:${h}px;">ALMUERZO</div>`;
      }
    }
  });

  ALL_MACHINES.forEach(m => {
    let tasks = '';
    DAYS.forEach((_, di) => {
      const bounds = allTimeBoundaries[di], off = dayOffsets[di], blks = scheduledBlocks[m]?.[di] || [];
      blks.forEach(blk => {
        const sIdx = bounds.indexOf(Math.round(blk.startMin)), eIdx = bounds.indexOf(Math.round(blk.startMin + blk.duration));
        if (sIdx >= 0 && eIdx >= 0) {
          const t = sIdx * ROW_H + off, h = (eIdx - sIdx) * ROW_H;
          const isProd = blk.cssClass === 'block-c-prod';
          const cInfo = isProd ? getColorInfoByRMA(blk.job.n) : { bg: '#f3f4f6', text: '#374151' };
          const isImpression = ['MOZP', 'SPEEDMASTER', 'GTO-52'].includes(m);
          const isBarnizado = ['KORD 2', 'KORD 3'].includes(m);
          const isTroquelado = ['TROQUELADORA 57', 'TROQUELADORA 72', 'TROQUELADORA 77', 'TROQUELADORA MERCEDES'].includes(m);
          let contentHTML = '';

          // COMMON DATA (Global Rule)
          const startM = blk.startMin;
          const endM = blk.startMin + blk.duration;
          const durationMin = Math.max(1, Math.round(blk.duration));
          const timeStr = `${mkTimeFromMins(startM)} - ${mkTimeFromMins(endM)} (${durationMin} min)`;

          if (isProd) {
            const mat = String(blk.job?.material_requerido || '').toUpperCase();
            const tj = blk.job?.tirajes || '-';
            const lines = [];

            if (isImpression) {
              const cur = blk.extraData?.currentCycle || 1;
              const tot = blk.extraData?.totalCycles || 1;
              const lin = blk.job?.linea || '';
              const c2 = String(blk.job?.codigo_2 || '').trim();

              // L1: RMA - PRODUCTO | CICLO (Mixed Bold/Normal)
              lines.push(`<div style="line-height:1.15; margin-bottom:0; text-align:left; font-size:11px;"><b style="text-transform:uppercase;">${escH(blk.job.n)} - ${escH(blk.job.producto)}</b> | ${cur}/${tot}</div>`);

              // L4: TIME RANGE (Priority)
              if (h > 45) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.85; line-height:1.15; margin-bottom:0; text-align:left;">${escH(timeStr)}</div>`);

              // L2: MATERIAL | LINEA | CODIGO_2 (Strict Construction)
              if (h > 65) {
                let l2 = escH(mat);
                if (h > 80 && lin) l2 += ` | ${escH(lin)}`;
                if (h > 95 && c2) l2 += ` | ${escH(c2)}`;
                lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.9; line-height:1.15; margin-bottom:0; text-align:left;">${l2}</div>`);
              }

              // L3: TIRAJES
              if (h > 95) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.9; line-height:1.15; margin-bottom:0; text-align:left;">Tirajes: ${escH(tj)}</div>`);

            } else if (isBarnizado) {
              const tr = blk.job?.n_troquel || '-';
              lines.push(`<div style="font-weight:bold; text-transform:uppercase; font-size:11px; line-height:1.2; margin-bottom:1px; text-align:left;">${escH(blk.job.n)} - ${escH(blk.job.producto)}</div>`);
              if (h > 35) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.85; line-height:1.2; margin-bottom:1px; text-align:left;">${escH(timeStr)}</div>`);
              if (h > 55) lines.push(`<div style="font-weight:normal; font-size:10px; line-height:1.2; text-align:left;">${escH(mat)} | N° TROQUEL: ${escH(tr)}</div>`);
              if (h > 80) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.9; margin-top:1px; text-align:left;">Tirajes: ${escH(tj)}</div>`);

            } else if (isTroquelado) {
              const tr = blk.job?.n_troquel || '-';
              const ut = blk.job?.un_tiraje;
              const hasUT = !!ut && ut !== '-' && ut !== '0' && ut !== 0;

              lines.push(`<div style="font-weight:bold; text-transform:uppercase; font-size:11px; line-height:1.2; margin-bottom:1px; text-align:left;">${escH(blk.job.n)} - ${escH(blk.job.producto)}</div>`);
              if (h > 35) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.85; line-height:1.2; margin-bottom:1px; text-align:left;">${escH(timeStr)}</div>`);
              if (h > 55) lines.push(`<div style="font-weight:normal; font-size:10px; line-height:1.2; text-align:left;">${escH(mat)} | N° TROQUEL: ${escH(tr)}</div>`);
              if (h > 75) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.9; margin-top:1px; text-align:left;">Tirajes: ${escH(tj)}</div>`);
              if (h > 95 && hasUT) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.9; margin-top:1px; text-align:left;">UN/TIRAJE: ${escH(ut)}</div>`);

            } else {
              lines.push(`<div style="font-weight:bold; text-transform:uppercase; font-size:11px; line-height:1.2; text-align:left;">${escH(blk.job.n)} - ${escH(blk.job.producto)}</div>`);
              if (h > 35) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.85; text-align:left;">${escH(timeStr)}</div>`);
            }
            contentHTML = lines.join('');

          } else {
            const lines = [];
            lines.push(`<div style="font-weight:700; font-size:11px; text-transform:uppercase; line-height:1.2; text-align:left;">${escH(blk.type)}</div>`);
            if (h > 30) lines.push(`<div style="font-weight:normal; font-size:10px; opacity:0.8; text-align:left;">${escH(timeStr)}</div>`);
            contentHTML = lines.join('');
          }

          // VERTICAL ALIGNMENT RULE (Global)
          const jc = (h >= 40) ? 'center' : 'flex-start';

          tasks += `<div class="gantt-task-card ${blk.cssClass}" style="top:${t}px; height:${h}px; background:${cInfo.bg}; color:${cInfo.text}; border:1px solid rgba(0,0,0,0.12); width:100%; display:flex; flex-direction:column; padding:4px 6px; overflow:hidden; justify-content:${jc}; align-items:flex-start; text-align:left;">
            ${contentHTML}
          </div>`;
        }
      });
    });

    bodyColumnsHTML += `<div class="gantt-body-column" data-machine="${m}" style="width:${CELL_W}px; position:relative; flex-shrink:0; border-right:1px solid rgba(0,0,0,0.05);">
      ${gridOverlay}
      ${tasks}
    </div>`;
  });

  contentBody.innerHTML = `${buildDateBarHTML('eta')}
    <div class="gantt-root" id="gantt-root">
      <div class="gantt-top-row">${cornerHTML}<div class="gantt-header-outer" id="gantt-header-outer"><div class="gantt-header-content" style="display:flex; flex-direction:column; width:max-content;"><div class="gantt-header-stage-row" style="display:flex;">${stageHeaders}</div><div class="gantt-header-mach-row" style="display:flex;">${machineHeaders}</div></div></div></div>
      <div class="gantt-bottom-row"><div class="gantt-sidebar-outer" id="gantt-sidebar-outer"><div class="gantt-sidebar-content" style="height:${totalGanttHeight}px;">${sidebarHTML}</div></div>
      <div class="gantt-body-outer" id="gantt-body-outer"><div class="gantt-body-content" style="display:flex; height:${totalGanttHeight}px; width:max-content;">${bodyColumnsHTML}</div></div></div>
      ${zoomBadgeHTML()}
    </div>`;

  const b = document.getElementById('gantt-body-outer'), h = document.getElementById('gantt-header-outer'), s = document.getElementById('gantt-sidebar-outer');
  if (b && h && s) b.onscroll = () => { h.scrollLeft = b.scrollLeft; s.scrollTop = b.scrollTop; };

  wireDateBar('eta', exportCronogramaPorEtapa); wireFullscreenBtn();
  setupGanttConfigEvents();
  setTimeout(() => initResizable('etapa'), 60);
}

function setupGanttConfigEvents() {
  const btnClose = document.getElementById('gantt-modal-close');
  if (btnClose) btnClose.onclick = closeGanttModal;

  const overlay = document.getElementById('gantt-modal-overlay');
  if (overlay) overlay.onclick = (e) => { if (e.target.id === 'gantt-modal-overlay') closeGanttModal(); };
}

function showGanttModal(type) {
  const overlay = document.getElementById('gantt-modal-overlay');
  const body = document.getElementById('gantt-modal-body');
  if (!overlay || !body) return;

  if (type === 'lunch') {
    body.innerHTML = `
      <div class="modal-title">Configurar Almuerzo</div>
      <p style="font-size:13px; color:#6b7280; margin-bottom:15px;">El tiempo de almuerzo está fijado en 30 minutos obligatorios.</p>
      <div class="modal-section">
        <label class="modal-label">Hora de Inicio</label>
        <input type="time" class="modal-input" id="cfg-lunch-start" value="${schedState.lunchStart}">
      </div>
      <div class="modal-section">
        <label class="modal-label">Hora de Fin (Calculada)</label>
        <input type="time" class="modal-input" id="cfg-lunch-end" value="${schedState.lunchEnd}" readonly style="background:#f9fafb; cursor:not-allowed;">
      </div>
      <div class="modal-footer">
        <button class="btn-modal btn-modal-secondary" id="btn-modal-clear-lunch">Eliminar Almuerzo</button>
        <button class="btn-modal btn-modal-primary" id="btn-modal-ok-lunch">OK</button>
      </div>`;

    const sIn = document.getElementById('cfg-lunch-start');
    const eIn = document.getElementById('cfg-lunch-end');
    if (sIn && eIn) {
      sIn.onchange = () => {
        if (!sIn.value) return;
        const m = t2m(sIn.value);
        eIn.value = mkTimeFromMins(m + 30);
      };
    }
    document.getElementById('btn-modal-ok-lunch').onclick = () => { applyLunch(); closeGanttModal(); };
    document.getElementById('btn-modal-clear-lunch').onclick = () => { clearLunch(); closeGanttModal(); };
  } else if (type === 'night') {
    body.innerHTML = `
      <div class="modal-title">Horario Nocturno</div>
      <div class="modal-section">
        <label class="modal-label">Máquina</label>
        <select class="modal-input" id="cfg-night-machine">
          ${ALL_MACHINES.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div class="modal-section" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
          <label class="modal-label">Fecha Inicio</label>
          <input type="date" class="modal-input" id="cfg-night-date-start">
        </div>
        <div>
          <label class="modal-label">Fecha Fin</label>
          <input type="date" class="modal-input" id="cfg-night-date-end">
        </div>
      </div>
      <div class="modal-section" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
          <label class="modal-label">Hora Trabajo Inicio</label>
          <input type="time" class="modal-input" id="cfg-night-work-start" value="18:30">
        </div>
        <div>
          <label class="modal-label">Hora Trabajo Fin</label>
          <input type="time" class="modal-input" id="cfg-night-work-end" value="06:30">
        </div>
      </div>
      <div class="modal-section" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
          <label class="modal-label">Hora Cena Inicio</label>
          <input type="time" class="modal-input" id="cfg-night-dinner-start" value="00:00">
        </div>
        <div>
          <label class="modal-label">Hora Cena Fin</label>
          <input type="time" class="modal-input" id="cfg-night-dinner-end" value="00:30">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-modal btn-modal-secondary" onclick="closeGanttModal()">Cerrar</button>
        <button class="btn-modal btn-modal-primary" id="btn-modal-ok-night">OK</button>
      </div>
      <div class="night-list-modal" id="modal-night-list">${buildNightHTMLModal()}</div>`;

    document.getElementById('btn-modal-ok-night').onclick = () => { addNightShift(); };
  }

  overlay.classList.add('active');
  exportDropdown.classList.remove('open');
}


function closeGanttModal() {
  document.getElementById('gantt-modal-overlay')?.classList.remove('active');
}

function buildNightHTMLModal() {
  return schedState.nightShifts.map((s, i) => `
    <div class="night-item-modal">
      <strong>${s.machine}</strong>
      <span>${s.dateStart || '—'} → ${s.dateEnd || '—'}</span>
      <span>${s.timeStart} – ${s.timeEnd}</span>
      <button class="btn-remove-night" onclick="removeNightShift(${i}); document.getElementById('modal-night-list').innerHTML = buildNightHTMLModal();">
        <i class="uil uil-trash-alt"></i>
      </button>
    </div>`).join('');
}

function exportCronogramaPorEtapa() {
  const startLbl = schedDateRange.start || '—';
  const endLbl = schedDateRange.end || '—';
  const machines = ALL_MACHINES;
  let csv = `\uFEFFCronograma por Etapa (${startLbl} → ${endLbl})\r\n`;
  csv += 'DÍA;HORA;' + machines.join(';') + '\r\n';
  DAYS.forEach((day, di) => {
    HOUR_SLOTS.forEach((slot, si) => {
      const row = [day, slot.label];
      machines.forEach(m => {
        const st = schedState.cells[m]?.[di]?.[si] || '';
        row.push(st === 'work' ? '✓' : st === 'lunch' ? 'ALM' : st === 'night' ? 'NOC' : '');
      });
      csv += row.join(';') + '\r\n';
    });
  });
  dlCsv(csv, `Cronograma_Etapa_${fmtDate()}.csv`);
}

// ─────────────────────────────────────────────────────────────
//  CONFIG PANEL
// ─────────────────────────────────────────────────────────────
function toggleConfigPanel() {
  // Obsolete but kept minimal to avoid errors if called
}
function reRenderEtapa() { renderCronogramaPorEtapa(); }

// LUNCH CONFIG
function applyLunch() {
  const s = document.getElementById('cfg-lunch-start')?.value;
  const e = document.getElementById('cfg-lunch-end')?.value;
  if (s && e) {
    schedState.lunchStart = s;
    schedState.lunchEnd = e;
    schedState.lunchEnabled = true;
    reRenderEtapa();
  }
}
function clearLunch() {
  schedState.lunchEnabled = false;
  reRenderEtapa();
}

/**
 * BREAK-AWARE ARCHITECTURE FOUNDATION (Phase 3 Prep)
 * Rule: Operation completely stops during breaks.
 * This helper calculates visual segments for a task crossing one or more breaks.
 */
function getWorkSegments(startMins, durationMins, dayBreaks = []) {
  let segments = [];
  let remaining = durationMins;
  let current = startMins;
  let iter = 0;

  while (remaining > 0 && iter < 20) {
    iter++;
    // 1. If currently inside any break, jump to the end of it
    let activeBreak = dayBreaks.find(b => current >= b.start && current < b.end);
    if (activeBreak) {
      current = activeBreak.end;
      continue;
    }

    // 2. Find the next upcoming break
    let nextBreak = dayBreaks
      .filter(b => b.start > current)
      .sort((a, b) => a.start - b.start)[0];

    // 3. Calculate distance to next break or end of work (1080)
    let limit = nextBreak ? nextBreak.start : 1080;
    let available = limit - current;

    if (available <= 0) {
      // Should not happen if boundaries are correct, but for safety:
      current = limit; if (current >= 1080) break;
      continue;
    }

    let chunk = Math.min(remaining, available);
    segments.push({ start: current, duration: chunk });

    current += chunk;
    remaining -= chunk;
  }
  return segments;
}
function removeNightShift(idx) {
  const s = schedState.nightShifts[idx];
  if (s) {
    const sM = t2m(s.timeStart), eM = t2m(s.timeEnd);
    DAYS.forEach((_, di) => HOUR_SLOTS.forEach((slot, si) => {
      if (slot.start >= sM && slot.start < eM && schedState.cells[s.machine]?.[di]?.[si] === 'night')
        schedState.cells[s.machine][di][si] = '';
    }));
  }
  schedState.nightShifts.splice(idx, 1);
  reRenderEtapa();
}

// CELL CLICK
function onCellClick(e) {
  const cell = e.currentTarget;
  const machine = cell.dataset.machine, di = +cell.dataset.day, si = +cell.dataset.slot;

  if (!schedState.cells[machine]) {
    console.warn(`[onCellClick] Máquina ${machine} no inicializada en el estado.`);
    return;
  }

  const cur = schedState.cells[machine]?.[di]?.[si];
  if (cur === 'lunch' || cur === 'night') return;
  const next = cur === 'work' ? '' : 'work';
  schedState.cells[machine][di][si] = next;
  const stage = STAGES.find(s => s.machines.includes(machine));
  cell.innerHTML = next === 'work' ? `<span class="sched-chip" style="background:${stage?.color || '#b91c2c'};">✓</span>` : '';
  cell.style.background = next === 'work' ? '#fff1f2' : '#fff';
}

// ─────────────────────────────────────────────────────────────
//  CONTEXT MENU (right-click delete row)
// ─────────────────────────────────────────────────────────────
let ctxTargetRow = null;

function setupContextMenu() {
  const menu = document.getElementById('ctx-menu');
  document.addEventListener('contextmenu', e => {
    // Detectar si el clic es en una fila de tabla (General o Planificación)
    const tr = e.target.closest('#table-body tr, #plan-table-body tr');
    if (!tr) return;

    e.preventDefault();
    ctxTargetRow = tr;
    menu.style.top = e.clientY + 'px';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.classList.add('open');
    tr.classList.add('ctx-selected');
  });

  document.getElementById('ctx-delete-row').addEventListener('click', () => {
    if (!ctxTargetRow) return;

    // Lógica especial para Planificación
    if (activeMenu === 'planificacion') {
      const rmaN = ctxTargetRow.dataset.rma;
      if (rmaN) {
        rmaSessionList = rmaSessionList.filter(item => String(item.n) !== String(rmaN));
        ctxTargetRow.remove();
        // Si la lista queda vacía, re-renderizar para mostrar estado vacío
        if (rmaSessionList.length === 0) {
          const container = document.getElementById('rma-list-container');
          if (container) container.innerHTML = window.renderRMATable();
        }
      }
      ctxTargetRow = null;
      menu.classList.remove('open');
      return;
    }

    // Lógica original para otras tablas
    const ds = getActiveDataset();
    const rowIdx = +ctxTargetRow.dataset.rowIdx;
    if (ds && !isNaN(rowIdx) && rowIdx >= 0) ds.rows.splice(rowIdx, 1);
    ctxTargetRow.remove();
    ctxTargetRow = null;
    menu.classList.remove('open');
    updateRowCount();
  });

  document.addEventListener('mousedown', e => {
    if (!menu.contains(e.target)) {
      menu.classList.remove('open');
      ctxTargetRow?.classList.remove('ctx-selected');
      ctxTargetRow = null;
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  RMA VIEW
// ─────────────────────────────────────────────────────────────
function renderRMAView() {
  pageTitle.textContent = 'Tabla RMA';
  contentBody.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box"><i class="uil uil-search"></i><input type="text" placeholder="Buscar en RMA..." autocomplete="off"></div>
        <span class="toolbar-count">Sin datos cargados</span>
      </div>
      <div class="table-scroll"><div class="empty-state" style="padding:60px 40px;">
        <i class="uil uil-database"></i><h2>Tabla RMA</h2>
        <p>Próximamente habilitado para importación de órdenes de trabajo.</p>
      </div></div>
      <div class="table-footer"><span>0 registro(s)</span><button class="btn-agregar"><i class="uil uil-import"></i> Importar RMA</button></div>
    </div>`;
  btnExportExcel.onclick = () => exportDropdown.classList.remove('open');
}

// ─────────────────────────────────────────────────────────────
//  BT IMPRENTA STATE
// ─────────────────────────────────────────────────────────────
let btSearch = '', btColumnFilters = {}, btVisibleRows = [], btPage = 0, btLoadingMore = false;
let btFilterPanelCol = null, btFilterPanelTempSel = null, filterPanelAllValues = [];
const BT_PAGE_SIZE = 30, BT_SKIP_COLS = new Set([1, 2]), BT_FILTERABLE = ['CÓDIGO', 'PRODUCTOS', 'LÍNEA'];

// ─────────────────────────────────────────────────────────────
//  TABLE VIEW ROUTER
// ─────────────────────────────────────────────────────────────
function renderTableView() {
  const cfg = {
    'bt-imprenta': { label: 'Tabla BT Imprenta', data: DATA.btImprenta },
    'no-barnizado': { label: 'Tabla No Barnizado', data: DATA.noBarnizado },
    'no-troquelado': { label: 'Tabla No Troquelado', data: DATA.noTroquelado },
    'no-pegado': { label: 'Tabla No Pegado', data: DATA.noPegado },
  };
  const { label, data: dataset } = cfg[activeSubMenu] || {};
  if (!dataset?.headers?.length) { contentBody.innerHTML = `<div class="empty-state"><p>No se pudo cargar la tabla.</p></div>`; return; }
  pageTitle.textContent = label;
  if (activeSubMenu === 'bt-imprenta') { btSearch = ''; btColumnFilters = {}; btPage = 0; return renderBTImprentaView(dataset, label); }

  const isTroq = activeSubMenu === 'no-troquelado';
  const isEditable = ['no-barnizado', 'no-troquelado', 'no-pegado'].includes(activeSubMenu);

  // Start with one blank editable row if empty
  if (isEditable && dataset.rows.length === 0) {
    dataset.rows.push(Object.fromEntries(dataset.headers.map(h => [h, ''])));
  }

  const headerHtml = dataset.headers.map(h => `<th>${escH(h)}</th>`).join('');
  const rowsHtml = dataset.rows.map((row, idx) => {
    const tds = dataset.headers.map((h, ci) => {
      const val = row[h] || '';
      if (isEditable) {
        if (isTroq && ci === 0) return `<td><div class="editable-cell-wrap"><input class="cod-input" type="text" value="${escH(val)}" data-row="${idx}" data-col="${h}" placeholder="IFA-XXXXX" autocomplete="off"/></div></td>`;
        return `<td><input class="editable-cell" type="text" value="${escH(val)}" data-row="${idx}" data-col="${h}" placeholder="${ci === 0 ? 'Código IFA' : 'Descripción'}"/></td>`;
      }
      return `<td title="${escH(val)}">${escH(val)}</td>`;
    }).join('');
    return `<tr data-row-idx="${idx}" class="${isEditable ? 'new-row' : ''}"> ${tds}</tr>`;
  }).join('');

  contentBody.innerHTML = `
    <div class="table-wrap" id="table-wrap">
      <div class="table-scroll">
        <table class="data-table" id="main-table">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody id="table-body">${rowsHtml}</tbody>
        </table>
      </div>
      <div class="table-footer">
        <span id="row-count">${dataset.rows.length} registro(s)</span>
        <div style="display:flex;gap:8px;">
          ${isEditable ? '<button class="btn-guardar" id="btn-guardar"><i class="uil uil-check"></i> Guardar</button>' : ''}
          <button class="btn-agregar" id="btn-agregar"><i class="uil uil-plus"></i> Agregar</button>
        </div>
      </div>
    </div>`;
  if (isTroq) setupTroqueladoTable();
  document.getElementById('btn-agregar').addEventListener('click', addNewRow);
  document.getElementById('btn-guardar')?.addEventListener('click', saveEditableRows);
  btnExportExcel.onclick = () => { exportDropdown.classList.remove('open'); exportCurrentTable(label, dataset); };
}

// BT Imprenta
function renderBTImprentaView(dataset, subtitle) {
  const visHdrs = dataset.headers.filter((_, i) => !BT_SKIP_COLS.has(i));
  const headerHtml = visHdrs.map(h => {
    const filt = BT_FILTERABLE.includes(h), act = btColumnFilters[h]?.size > 0;
    return filt
      ? `<th class="filterable ${act ? 'filter-active' : ''}" data-col="${escH(h)}">${escH(h)}<span class="filter-icon"><i class="uil uil-filter"></i></span></th>`
      : `<th>${escH(h)}</th>`;
  }).join('');

  contentBody.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box"><i class="uil uil-search"></i>
          <input type="text" id="bt-search-input" placeholder="Buscar por producto..." autocomplete="off" value="${escH(btSearch)}">
          <button class="search-clear ${btSearch ? 'visible' : ''}" id="bt-search-clear">&#x2715;</button>
        </div>
        <span class="toolbar-count" id="bt-toolbar-count"></span>
      </div>
      <div class="active-filters-bar" id="bt-filters-bar"></div>
      <div class="table-scroll" id="bt-table-scroll" style="overflow-x:scroll;overflow-y:auto;">
        <table class="data-table" id="main-table" style="width:auto;min-width:${Math.max(visHdrs.length * 140, 100)}px;white-space:nowrap;">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody id="table-body"></tbody>
        </table>
        <div class="scroll-loader" id="bt-scroll-loader"><div class="scroll-spinner"></div><span>Cargando más...</span></div>
      </div>
      <div class="table-footer"><span id="row-count">Cargando...</span><button class="btn-agregar" style="display:none;"></button></div>
    </div>`;

  btnExportExcel.onclick = () => { exportDropdown.classList.remove('open'); exportCurrentTable(subtitle, { headers: visHdrs, rows: btVisibleRows }); };
  const si = document.getElementById('bt-search-input'), sc = document.getElementById('bt-search-clear');
  si.addEventListener('input', () => { btSearch = si.value; sc.classList.toggle('visible', !!btSearch); btApplyFilters(dataset, visHdrs); });
  sc.addEventListener('click', () => { btSearch = ''; si.value = ''; sc.classList.remove('visible'); btApplyFilters(dataset, visHdrs); });
  document.querySelector('#main-table thead').addEventListener('click', e => {
    const th = e.target.closest('th.filterable'); if (th) openFilterPanel(th.dataset.col, th, dataset, visHdrs);
  });
  document.getElementById('bt-table-scroll').addEventListener('scroll', () => btOnScroll(dataset, visHdrs));
  btApplyFilters(dataset, visHdrs);
}

function btApplyFilters(dataset, visHdrs) {
  const q = btSearch.trim().toLowerCase();
  btVisibleRows = dataset.rows.filter(row => {
    if (q && !(row['PRODUCTOS'] || '').toLowerCase().includes(q)) return false;
    for (const [col, vals] of Object.entries(btColumnFilters)) if (vals?.size > 0 && !vals.has((row[col] || '').trim())) return false;
    return true;
  });
  btPage = 0;
  const tb = document.getElementById('table-body'); if (tb) tb.innerHTML = '';
  btRenderPage(visHdrs); btUpdateCounters(dataset); renderFilterBadges(dataset, visHdrs);
}
function btRenderPage(visHdrs) {
  const tb = document.getElementById('table-body'); if (!tb) return;
  const start = btPage * BT_PAGE_SIZE, end = Math.min(start + BT_PAGE_SIZE, btVisibleRows.length);
  btVisibleRows.slice(start, end).forEach(row => {
    const tr = document.createElement('tr');
    visHdrs.forEach(h => { const td = document.createElement('td'); td.textContent = td.title = row[h] || ''; tr.appendChild(td); });
    tb.appendChild(tr);
  });
  btPage++;
  const loader = document.getElementById('bt-scroll-loader');
  if (loader) loader.classList.toggle('visible', btPage * BT_PAGE_SIZE < btVisibleRows.length);
}
function btOnScroll(dataset, visHdrs) {
  if (btLoadingMore) return;
  const c = document.getElementById('bt-table-scroll'); if (!c) return;
  if (c.scrollTop + c.clientHeight >= c.scrollHeight - 120 && btPage * BT_PAGE_SIZE < btVisibleRows.length) {
    btLoadingMore = true; setTimeout(() => { btRenderPage(visHdrs); btLoadingMore = false; }, 180);
  }
}
function btUpdateCounters(dataset) {
  const cnt = btVisibleRows.length, tot = dataset.rows.length;
  const rc = document.getElementById('row-count'), tc = document.getElementById('bt-toolbar-count');
  if (rc) rc.textContent = `${cnt} de ${tot} registro(s)`;
  if (tc) tc.textContent = cnt < tot ? `${cnt} resultado(s)` : `${tot} registros en total`;
}

// FILTER PANEL
function openFilterPanel(col, thEl, dataset, visHdrs) {
  const panel = document.getElementById('filter-panel'); btFilterPanelCol = col;
  const map = {};
  dataset.rows.forEach(r => { const v = (r[col] || '').trim(); map[v] = (map[v] || 0) + 1; });
  filterPanelAllValues = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ v, c }));
  btFilterPanelTempSel = btColumnFilters[col] ? new Set(btColumnFilters[col]) : null;
  const rect = thEl.getBoundingClientRect();
  panel.style.top = (rect.bottom + 4) + 'px'; panel.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  panel.classList.add('open');
  const fs = document.getElementById('filter-search'); fs.value = ''; fs.focus();
  renderFilterOptions(filterPanelAllValues);
  fs.oninput = () => renderFilterOptions(filterPanelAllValues.filter(i => i.v.toLowerCase().includes(fs.value.toLowerCase())));
  // Select All / None
  document.getElementById('btn-filter-select-all').onclick = () => {
    btFilterPanelTempSel = new Set(filterPanelAllValues.map(i => i.v));
    renderFilterOptions(filterPanelAllValues.filter(i => i.v.toLowerCase().includes(fs.value.toLowerCase())));
  };
  document.getElementById('btn-filter-select-none').onclick = () => {
    btFilterPanelTempSel = new Set();
    renderFilterOptions(filterPanelAllValues.filter(i => i.v.toLowerCase().includes(fs.value.toLowerCase())));
  };
  // Note: 'Limpiar' button removed per user request
  document.getElementById('btn-filter-apply').onclick = () => {
    if (!btFilterPanelTempSel || btFilterPanelTempSel.size === 0) delete btColumnFilters[col];
    else btColumnFilters[col] = new Set(btFilterPanelTempSel);
    closeFilterPanel(); btApplyFilters(DATA.btImprenta, visHdrs);
    const th = document.querySelector(`#main-table thead th[data-col="${col}"]`);
    if (th) th.classList.toggle('filter-active', !!(btColumnFilters[col]?.size > 0));
  };
}

// SAVE EDITABLE ROWS
function saveEditableRows() {
  const tb = document.getElementById('table-body');
  if (!tb) return;
  const ds = getActiveDataset();
  const isTroq = activeSubMenu === 'no-troquelado';
  tb.querySelectorAll('tr').forEach(tr => {
    const ri = +tr.dataset.rowIdx;
    // Save values from inputs into dataset
    tr.querySelectorAll('input').forEach(inp => {
      const col = inp.dataset.col;
      if (!isNaN(ri) && col && ds?.rows?.[ri]) ds.rows[ri][col] = inp.value;
    });
    // Convert inputs → static text
    if (ds && !isNaN(ri) && ds.rows[ri]) {
      ds.headers.forEach((h, ci) => {
        const td = tr.querySelectorAll('td')[ci];
        if (!td) return;
        const val = ds.rows[ri][h] || '';
        if (ci === 0 && isTroq) {
          td.innerHTML = `<span style="font-family:monospace;font-size:12px;color:var(--accent-red);font-weight:600;">${escH(val)}</span>`;
        } else {
          td.innerHTML = `<span>${escH(val)}</span>`;
        }
      });
    }
    tr.classList.remove('new-row');
  });
  updateRowCount();
  showSaveToast('✓ Cambios guardados correctamente');
}

function showSaveToast(msg) {
  let t = document.getElementById('save-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'save-toast';
    t.style.cssText = 'position:fixed;bottom:28px;right:28px;background:#16a34a;color:#fff;padding:11px 20px;border-radius:9px;font:600 13px Outfit,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:9999;transition:opacity .3s;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1'; t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }, 2500);
}
function renderFilterOptions(items) {
  const fb = document.getElementById('filter-panel-body'); if (!fb) return;
  fb.innerHTML = items.map(({ v, c }) => {
    const chk = !btFilterPanelTempSel || btFilterPanelTempSel.has(v);
    return `<label class="filter-option"><input type="checkbox" value="${escH(v)}" ${chk ? 'checked' : ''}><span>${v === '' ? '(vacío)' : escH(v)} <span style="color:var(--text-muted);font-size:11px;">(${c})</span></span></label>`;
  }).join('');
  fb.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', () => {
    if (!btFilterPanelTempSel) btFilterPanelTempSel = new Set(filterPanelAllValues.map(i => i.v));
    cb.checked ? btFilterPanelTempSel.add(cb.value) : btFilterPanelTempSel.delete(cb.value);
  }));
}
function closeFilterPanel() { document.getElementById('filter-panel')?.classList.remove('open'); btFilterPanelCol = null; }
document.addEventListener('mousedown', e => {
  const p = document.getElementById('filter-panel');
  if (p?.classList.contains('open') && !p.contains(e.target) && !e.target.closest('th.filterable')) closeFilterPanel();
});
function renderFilterBadges(dataset, visHdrs) {
  const bar = document.getElementById('bt-filters-bar'); if (!bar) return;
  const active = Object.entries(btColumnFilters).filter(([, v]) => v?.size > 0);
  if (!active.length) { bar.classList.remove('has-filters'); bar.innerHTML = ''; return; }
  bar.classList.add('has-filters');
  bar.innerHTML = active.map(([col, vals]) => `<span class="filter-badge">${escH(vals.size === 1 ? `${col}: ${[...vals][0]}` : `${col}: ${vals.size} valores`)}<button class="filter-badge-remove" data-col="${escH(col)}">&times;</button></span>`).join('')
    + `<button class="filters-clear-all" id="btn-clear-all-filters">Limpiar todo</button>`;
  bar.querySelectorAll('.filter-badge-remove').forEach(btn => btn.addEventListener('click', () => {
    delete btColumnFilters[btn.dataset.col];
    document.querySelector(`#main-table thead th[data-col="${btn.dataset.col}"]`)?.classList.remove('filter-active');
    btApplyFilters(dataset, visHdrs);
  }));
  document.getElementById('btn-clear-all-filters')?.addEventListener('click', () => {
    btColumnFilters = {};
    document.querySelectorAll('#main-table thead th.filter-active').forEach(t => t.classList.remove('filter-active'));
    btApplyFilters(dataset, visHdrs);
  });
}

// TROQUELADO AUTOCOMPLETE
let autocompleteCodInput = null;
function setupTroqueladoTable() {
  const tb = document.getElementById('table-body'); if (!tb) return;
  tb.addEventListener('input', onCodInput);
  tb.addEventListener('keydown', onCodKeydown);
  tb.addEventListener('change', onEditCellChange);
}
function onCodInput(e) {
  const inp = e.target; if (!inp.classList.contains('cod-input')) return;
  const q = inp.value.trim(); if (!q) { hideAutocomplete(); return; }
  const matches = searchImprenta(q); if (!matches.length) { hideAutocomplete(); return; }
  autocompleteCodInput = inp; autocompleteSelected = -1;
  const rect = inp.getBoundingClientRect();
  autocompleteEl.style.top = (rect.bottom + 4) + 'px'; autocompleteEl.style.left = rect.left + 'px'; autocompleteEl.style.display = 'block';
  autocompleteEl.innerHTML = matches.map((r, i) => {
    const cod = r['CÓDIGO'] || r.c || '', prod = r['PRODUTOS'] || r['PRODUCTOS'] || r.p || '';
    return `<div class="autocomplete-item" data-idx="${i}" data-cod="${escH(cod)}" data-prod="${escH(prod)}"><span class="autocomplete-cod">${escH(cod)}</span><span class="autocomplete-name">${escH(prod)}</span></div>`;
  }).join('');
  autocompleteEl.querySelectorAll('.autocomplete-item').forEach(el => el.addEventListener('mousedown', ev => { ev.preventDefault(); selectAutocomplete(el.dataset.cod, el.dataset.prod); }));
}
function searchImprenta(q) { const lq = q.toLowerCase(), lk = window.BT_LOOKUP || []; if (lk.length) return lk.filter(i => (i.c || '').toLowerCase().includes(lq)).slice(0, 30).map(i => ({ 'CÓDIGO': i.c, 'PRODUTOS': i.p })); return (DATA.btImprenta.rows || []).filter(r => (r['CÓDIGO'] || '').toLowerCase().includes(lq)).slice(0, 30); }
function hideAutocomplete() { autocompleteEl.style.display = 'none'; autocompleteEl.innerHTML = ''; autocompleteSelected = -1; }
function selectAutocomplete(cod, prod) {
  if (!autocompleteCodInput) return;
  autocompleteCodInput.value = cod;
  const ri = +autocompleteCodInput.dataset.row;
  if (!isNaN(ri) && DATA.noTroquelado.rows[ri]) { DATA.noTroquelado.rows[ri]['COD IFA'] = cod; DATA.noTroquelado.rows[ri]['ITEM'] = prod; }
  const tr = autocompleteCodInput.closest('tr'), edi = tr?.querySelector('.editable-cell');
  if (edi) { edi.value = prod; if (!isNaN(ri) && DATA.noTroquelado.rows[ri]) DATA.noTroquelado.rows[ri]['ITEM'] = prod; }
  hideAutocomplete(); updateRowCount();
}
function onCodKeydown(e) {
  const items = autocompleteEl.querySelectorAll('.autocomplete-item');
  if (autocompleteEl.style.display === 'none' || !items.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); autocompleteSelected = Math.min(autocompleteSelected + 1, items.length - 1); highlightAuto(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); autocompleteSelected = Math.max(autocompleteSelected - 1, -1); highlightAuto(items); }
  else if (e.key === 'Enter') { e.preventDefault(); if (autocompleteSelected >= 0) selectAutocomplete(items[autocompleteSelected].dataset.cod, items[autocompleteSelected].dataset.prod); else hideAutocomplete(); }
  else if (e.key === 'Escape') hideAutocomplete();
}
function highlightAuto(items) { items.forEach((it, i) => { it.classList.toggle('selected', i === autocompleteSelected); if (i === autocompleteSelected) it.scrollIntoView({ block: 'nearest' }); }); }
function onEditCellChange(e) { const inp = e.target, ri = +inp.dataset.row, col = inp.dataset.col; if (!isNaN(ri) && col && DATA.noTroquelado.rows[ri]) DATA.noTroquelado.rows[ri][col] = inp.value; }
document.addEventListener('mousedown', e => { if (!autocompleteEl.contains(e.target) && e.target !== autocompleteCodInput) hideAutocomplete(); });

// ADD ROW
function addNewRow() {
  const isTroq = activeSubMenu === 'no-troquelado', ds = getActiveDataset(); if (!ds) return;
  const idx = ds.rows.length, row = Object.fromEntries(ds.headers.map(h => [h, ''])); ds.rows.push(row);
  const tb = document.getElementById('table-body'); if (!tb) return;
  const tr = document.createElement('tr'); tr.dataset.rowIdx = idx; tr.classList.add('new-row');
  ds.headers.forEach((h, ci) => {
    const td = document.createElement('td');
    if (isTroq) td.innerHTML = ci === 0 ? `<div class="editable-cell-wrap"><input class="cod-input" type="text" value="" data-row="${idx}" data-col="${h}" placeholder="IFA-XXXXX" autocomplete="off"/></div>` : `<input class="editable-cell" type="text" value="" data-row="${idx}" data-col="${h}" placeholder="Descripción"/>`;
    else td.innerHTML = `<input class="editable-cell" type="text" value="" data-row="${idx}" data-col="${h}"/>`;
    tr.appendChild(td);
  });
  tb.appendChild(tr);
  if (isTroq) { setupTroqueladoTable(); tr.querySelector('.cod-input')?.focus(); } else tr.querySelector('input')?.focus();
  updateRowCount();
}
function updateRowCount() { const el = document.getElementById('row-count'), ds = getActiveDataset(); if (el && ds) el.textContent = `${ds.rows.length} registro(s)`; }
function getActiveDataset() { return activeSubMenu === 'bt-imprenta' ? DATA.btImprenta : activeSubMenu === 'no-barnizado' ? DATA.noBarnizado : activeSubMenu === 'no-troquelado' ? DATA.noTroquelado : activeSubMenu === 'no-pegado' ? DATA.noPegado : null; }

// EXPORT TABLE
function exportCurrentTable(name, dataset) {
  if (!dataset?.headers) return;
  let csv = '\uFEFF' + dataset.headers.join(';') + '\r\n';
  dataset.rows.forEach(row => { csv += dataset.headers.map(h => { let v = row[h] || ''; if (v.includes(';') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"'; return v; }).join(';') + '\r\n'; });
  dlCsv(csv, `${name.replace(/\s+/g, '_')}_${fmtDate()}.csv`);
}
function setupExportMenu() {
  btnExportDots.addEventListener('click', e => { e.stopPropagation(); exportDropdown.classList.toggle('open'); });
  document.addEventListener('click', () => exportDropdown.classList.remove('open'));
  exportDropdown.addEventListener('click', e => e.stopPropagation());
}

// UTILS
// t2m, fmtDate movidas a timeUtils.js. escH (redundante) movida a normalizers.js.
function dlCsv(csv, name) { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); const a = Object.assign(document.createElement('a'), { href: url, download: name }); document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); }

// ─────────────────────────────────────────────────────────────
//  RESIZABLE COLUMNS & ROWS — SCHEDULE TABLES
//  Only active on red (header) cells. Drag right edge = resize col.
//  Drag bottom edge = resize row.
// ─────────────────────────────────────────────────────────────
function initResizable(viewType) {
  if (document.getElementById('gantt-root')) {
    wireResizableGantt();
    return;
  }
  const table = document.querySelector('.sched-table');
  if (!table) return;

  // ── COLUMN RESIZE ──
  // Etapa: machine headers — update <col> element for pixel-accurate widths
  table.querySelectorAll('th[data-machine-key]').forEach(th => {
    const machineKey = th.dataset.machineKey;
    const mIdx = ALL_MACHINES.indexOf(machineKey);
    const colEl = mIdx >= 0 ? table.querySelector(`col[data-ci="${mIdx + 2}"]`) : null;
    addColResizeHandle(th, newW => {
      if (colEl) colEl.style.width = newW + 'px';
    });
  });

  // General: stage headers — update body TDs (no colgroup)
  table.querySelectorAll('th[data-stage-key]').forEach(th => {
    const stageIdx = STAGES.findIndex(s => s.id === th.dataset.stageKey);
    addColResizeHandle(th, newW => {
      table.querySelectorAll(`td[data-stageidx="${stageIdx}"]`).forEach(td => {
        td.style.width = newW + 'px';
        td.style.minWidth = newW + 'px';
      });
    });
  });

  // ── ROW RESIZE ──
  table.querySelectorAll('.sched-td-hour').forEach(td => { addRowResizeHandle(td); });
  table.querySelectorAll('.sched-gen-day').forEach(td => { addRowResizeHandle(td); });
}

function wireResizableGantt() {
  const headers = document.querySelectorAll('.gantt-header-mach-cell');
  headers.forEach((th) => {
    addColResizeHandle(th, newW => {
      const machine = th.dataset.machine;
      // Update the machine column in the body
      const bodyCol = document.querySelector(`.gantt-body-column[data-machine="${machine}"]`);
      if (bodyCol) bodyCol.style.width = newW + 'px';

      // Update the stage header width (this might be complex if it spans multiple)
      // For now, the machine headers are updated by addColResizeHandle automatically.
    });
  });
}

function addColResizeHandle(th, getBodyCells) {
  // Check if handle already exists (embedded in HTML)
  if (th.querySelector('.resize-col-handle')) {
    wireColHandle(th.querySelector('.resize-col-handle'), th, getBodyCells);
    return;
  }
  // Create and append handle
  const handle = document.createElement('div');
  handle.className = 'resize-col-handle';
  // Do NOT set position:relative — the TH already has position:sticky
  // which is a valid containing block for position:absolute children
  th.style.overflow = 'visible';
  th.appendChild(handle);
  wireColHandle(handle, th, getBodyCells);
}

function wireColHandle(handle, th, updateFn) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = ev => {
      const newW = Math.max(30, startW + (ev.clientX - startX));
      th.style.width = newW + 'px';
      th.style.minWidth = newW + 'px';
      if (typeof updateFn === 'function') updateFn(newW);
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function addRowResizeHandle(td) {
  if (td.querySelector('.resize-row-handle')) return;
  const handle = document.createElement('div');
  handle.className = 'resize-row-handle';
  td.style.position = 'relative';
  td.appendChild(handle);

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const tr = td.closest('tr');
    const startH = tr ? tr.getBoundingClientRect().height : 32;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = ev => {
      const newH = Math.max(22, startH + (ev.clientY - startY));
      if (tr) {
        tr.style.height = newH + 'px';
        tr.querySelectorAll('td').forEach(cell => {
          cell.style.height = newH + 'px';
          cell.style.minHeight = newH + 'px';
        });
      }
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
