// ================================
// CONEXIÓN A SUPABASE
// ================================
const SUPABASE_URL = "https://xtyichijbrutbdgfcalz.supabase.co";
const SUPABASE_KEY = "sb_publishable_kEmKQ-plQH4fVtTULYF-cg_ZDe-1rVM";

let supabaseClient = null;
if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn("La librería de Supabase no se cargó correctamente.");
}

// ================================
// PRUEBA DE CONEXIÓN
// ================================
async function probarConexionBT() {
  const { data, error } = await supabaseClient
    .from("bt_imprenta")
    .select("*")
    .limit(10);

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
  { id: 'troquelado', label: 'TROQUELADO', color: '#4a1d96', machines: ['TROQ 57', 'TROQ 72', 'TROQ 77', 'TROQ MERCEDES'] },
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
function escH(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
  }[tag]));
}

function getColorByRMA(rma) {
  if (!rma) return '#1e3a8a';
  const palette = [
    '#1e3a8a', '#1d4ed8', '#2563eb', // Azules
    '#0e7490', '#0891b2', '#0284c7', // Celestes / Blue-greens
    '#166534', '#15803d', '#16a34a', '#0f766e', // Verdes
    '#78350f', '#92400e', '#854d0e'  // Cafés (Sin Rojos)
  ];
  let hash = 0;
  for (let i = 0; i < rma.length; i++) {
    hash = rma.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

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
      const { data, error } = await supabaseClient
        .from('bt_imprenta')
        .select('*');
      
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
  const c = document.getElementById('schedule-table-container');
  if (c) c.style.transform = `scale(${scheduleZoom})`;
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
  if (activeMenu === 'planificacion') { pageTitle.textContent = ''; return renderPlanificacion(); }

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
function renderPlanificacion() {
  contentBody.innerHTML = `
    <div class="plan-container">
      <div class="plan-main-title">
        <h1>Planificación</h1>
      </div>
      <div class="plan-header">
        <i class="uil uil-plus-circle"></i>
        <h2>Añadir RMA</h2>
      </div>

      <div class="plan-search-box">
        <div class="search-box">
          <i class="uil uil-search"></i>
          <input type="text" id="rma-input" placeholder="Ingrese número de RMA (Enter para buscar)..." maxlength="4" autocomplete="off">
        </div>
      </div>
      
      <div class="table-wrap" id="rma-list-container" style="background:#fff; border-radius:12px; border:1px solid var(--border-color); overflow:hidden;">
        ${renderRMATable()}
      </div>
    </div>
  `;

  const input = document.getElementById('rma-input');
  if (input) {
    input.focus();
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (!val) return;
        await buscarRMA(val);
        input.value = '';
      }
    });
  }
}

const SPECIAL_COD_IFAS = [
  'IFA-01508', 'IFA-01468', 'IFA-01504', 'IFA-01527', 'IFA-01372',
  'IFA-01493', 'IFA-03842', 'IFA-01531', 'IFA-01543', 'IFA-01546'
];

function renderRMATable() {

  if (rmaSessionList.length === 0) {
    return `<div class="empty-state" style="padding: 60px 40px;">
              <i class="uil uil-search"></i>
              <p>No hay RMAs añadidos aún.</p>
            </div>`;
  }

  const rowsHtml = rmaSessionList.map(item => {
    const isLoaded = item.ciclos !== undefined;
    return `
      <tr data-rma="${item.n}">
        <td class="col-rma">${item.n}</td>
        <td title="${escH(item.producto)}">${escH(item.producto)}</td>
        <td title="${escH(item.presentacion_comercial)}">${escH(item.presentacion_comercial)}</td>
        <td title="${escH(item.material_requerido)}">${escH(item.material_requerido)}</td>
        <td>${escH(item.codigo_material)}</td>
        <td class="col-cantidad">${escH(item.cantidad_requerida_para_cubrir)}</td>
        <td>${item.linea || '-'}</td>
        <td>${item.n_colores || '-'}</td>
        <td>
          <input type="text" class="plan-maquina-input" 
                 value="${item.maquina || ''}" 
                 oninput="updateRmaMaquina('${item.n}', this.value, this)"
                 onblur="cargarDatosTecnicos()"
                 placeholder="M, S, G..."
                 onclick="event.stopPropagation()">
        </td>

        ${isLoaded ? `
          <td>${item.n_troquel || '-'}</td>
          <td>${item.un_tiraje || '-'}</td>
          <td>${item.ciclos}</td>
          <td class="col-tirajes">${item.tirajes}</td>
        ` : ''}
      </tr>
    `;
  }).join('');

  // Calcular Totales
  const totalCantidad = rmaSessionList.reduce((acc, i) => acc + (parseFloat(i.cantidad_requerida_para_cubrir) || 0), 0);
  const totalTirajes = rmaSessionList.reduce((acc, i) => acc + (parseFloat(i.tirajes) || 0), 0);

  return `
    <div class="table-scroll">

      <table class="data-table plan-table-mini">
        <thead>
          <tr>
            <th>RMA</th>
            <th>PRODUCTO</th>
            <th>PRESENTACIÓN</th>
            <th>MATERIAL</th>
            <th>COD-IFA</th>
            <th>CANTIDAD</th>
            <th>LINEA</th>
            <th>N° COLORES</th>
            <th>MAQUINA</th>
            ${rmaSessionList.some(i => i.ciclos !== undefined) ? `
              <th>N° TROQUEL</th>
              <th>UN/TIRAJE</th>
              <th>CICLOS</th>
              <th>TIRAJES</th>
            ` : ''}
          </tr>
        </thead>


        <tbody id="plan-table-body">
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div class="table-footer plan-footer-combined">
      <div class="footer-left">
        <span>${rmaSessionList.length} registro(s) en planificación</span>
      </div>
      <div class="plan-summary-bar-inline">
        <div class="summary-item">
          <span class="summary-label">Total Cantidad:</span>
          <span class="summary-value">${totalCantidad.toLocaleString()}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Total Tirajes:</span>
          <span class="summary-value">${totalTirajes.toLocaleString()}</span>
        </div>
      </div>
      <div class="footer-right">
        <button class="btn-cargar-datos" onclick="cargarDatosTecnicos()">
          <i class="uil uil-sync"></i> CARGAR
        </button>
        <button class="btn-generar-crono" onclick="generarCronogramaEtapa()" style="margin-left:8px;background:var(--accent-red);color:#fff;border:none;padding:8px 16px;border-radius:8px;font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">
          <i class="uil uil-calendar-alt"></i> GENERAR CRONOGRAMA
        </button>
      </div>
    </div>
  `;

}

// Helper para normalizar comparaciones entre tablas (RMA vs BT Imprenta)
const normCol = (val) => String(val || "").trim().toUpperCase();
// Helper específico para máquinas (ignora guiones y espacios)
const normMaq = (val) => normCol(val).replace(/-/g, "").replace(/\s+/g, "");

function updateRmaMaquina(rmaN, val, inputEl) {

  const item = rmaSessionList.find(i => normCol(i.n) === normCol(rmaN));
  if (item) {
    const v = val.trim().toLowerCase();
    let finalVal = val;

    if (v === 'm') finalVal = 'MOZP';
    else if (v === 's') finalVal = 'SPEEDMASTER';
    else if (v === 'g') finalVal = 'GTO-52';

    item.maquina = finalVal;
    if (inputEl && inputEl.value !== finalVal) {
      inputEl.value = finalVal;
    }
  }
}


async function cargarDatosTecnicos() {
  if (rmaSessionList.length === 0) return;
  
  if (!supabaseClient) {
    showSaveToast("Error: Sin conexión a Supabase");
    return;
  }

  const codigos = [...new Set(rmaSessionList.map(item => item.codigo_material))].filter(Boolean);
  if (codigos.length === 0) return;

  showSaveToast("Calculando datos técnicos...");

  try {
    const { data, error } = await supabaseClient

      .from('bt_imprenta')
      .select('codigo, n_troquel, cajas_por_tiraje, tirajes_por_pliego, maquina_preferencial')
      .in('codigo', codigos);

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
      
      const tirajesPliego = parseFloat(btData?.tirajes_por_pliego);


      // 1. CÁLCULO DE CICLOS
      const nColoresRaw = item.n_colores;
      const nColores = parseFloat(nColoresRaw);
      
      if (!isNaN(nColores) && item.maquina) {
        const maq = (item.maquina || '').toUpperCase();
        let divisor = 2; // Default for SPEEDMASTER/MOZP
        if (maq === 'GTO-52') divisor = 4;

        let ciclos = Math.ceil(nColores / divisor);

        // Validación robusta de SOBRES
        const mat = (item.material_requerido || '').trim().toUpperCase();
        if (mat === 'SOBRE' || mat === 'SOBRES') {
          ciclos += 1;
        }
        item.ciclos = ciclos;

        // console.log(`[DEBUG-PLANIFICACION] Calculando Ciclos para RMA ${item.n}: C:${nColores} / D:${divisor} + S:${mat.includes('SOBRE')} = ${ciclos}`);
      } else {
        item.ciclos = '-';
      }

      // 2. CÁLCULO DE TIRAJES (+10% margen de seguridad)
      const cantidad = parseFloat(item.cantidad_requerida_para_cubrir);
      if (!isNaN(cantidad) && !isNaN(tirajesPliego) && tirajesPliego > 0) {
        const tirajeBase = cantidad / tirajesPliego;
        const tirajeFinal = Math.ceil(tirajeBase * 1.10);
        item.tirajes = tirajeFinal;

        // console.log(`[DEBUG-PLANIFICACION] Tirajes para ${item.n}: Base=${tirajeBase.toFixed(2)}, Final(+10%)=${tirajeFinal}`);
      } else {
        item.tirajes = '-';
      }
    });



    const container = document.getElementById('rma-list-container');
    if (container) container.innerHTML = renderRMATable();
    showSaveToast("Cálculos completados");
  } catch (err) {
    console.error("Error en carga técnica v4:", err);
    showSaveToast("Error al procesar cálculos técnicos");
  }
}


async function buscarRMA(n) {
  // Validar duplicados
  if (rmaSessionList.some(item => String(item.n) === String(n))) {
    showSaveToast("El RMA #" + n + " ya está en la lista");
    return;
  }

  if (!supabaseClient) {
    console.error("Supabase client no inicializado");
    showSaveToast("Error: Sin conexión");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('rma')
      .select('n, producto, presentacion_comercial, material_requerido, codigo_material, cantidad_requerida_para_cubrir')
      .eq('n', n)
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      showSaveToast("RMA #" + n + " no encontrado");
      return;
    }

    if (data && data.length > 0) {
      const rmaItem = data[0];
      const searchKey = normCol(rmaItem.codigo_material);

      // [DEBUG-PLANIFICACION] Buscando match inicial para: [${searchKey}]
      // console.log(`[DEBUG-PLANIFICACION] Buscando match en memoria para: ${searchKey}`);

      // 2. Buscar datos técnicos iniciales en BT Imprenta
      // Usamos una consulta robusta y filtramos en JS para coincidir con la lógica del Batch
      const { data: btRows, error: btError } = await supabaseClient
        .from('bt_imprenta')
        .select('codigo, linea, cantidad_de_colores')
        .eq('codigo', rmaItem.codigo_material.trim());
      
      const btMatch = btRows ? btRows.find(r => normCol(r.codigo) === searchKey) : null;
      
      if (!btError && btMatch) {
        // console.log("[DEBUG-PLANIFICACION] Match inicial encontrado: SÍ", btMatch);
        rmaItem.linea = btMatch.linea || '-';
        rmaItem.n_colores = btMatch.cantidad_de_colores || '-';
      } else {
        // console.log("[DEBUG-PLANIFICACION] Match inicial encontrado: NO");
        // if (btError) console.error("[DEBUG-PLANIFICACION] Error query:", btError);
        rmaItem.linea = '-';
        rmaItem.n_colores = '-';
      }



      // 3. Inicializar campos de carga posterior (vacíos)
      rmaItem.maquina = '';
      // ciclos, tirajes, etc. se mantienen undefined hasta presionar CARGAR

      rmaSessionList.unshift(rmaItem);
      const container = document.getElementById('rma-list-container');
      if (container) container.innerHTML = renderRMATable();
    }

  } catch (err) {
    console.error("Error al buscar RMA:", err);
    showSaveToast("Error al consultar Supabase");
  }
}


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
          <button class="sched-export-btn" id="sched-export-btn-${viewId}" title="Exportar"><i class="uil uil-ellipsis-h"></i></button>
          <div class="sched-export-dropdown" id="sched-export-dd-${viewId}">
            <button class="export-option" id="sched-export-excel-${viewId}"><i class="uil uil-file-export"></i> Exportar a Excel (.csv)</button>
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

function mkTimeFromMins(min) {
  const total = min; // Ya viene en minutos absolutos desde las 00:00, siendo 480 las 08:00
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

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
    const { data: tiemposData, error } = await supabaseClient.from('tiempos').select('*');
    if (error) throw error;
    
    ALL_MACHINES.forEach(m => scheduledBlocks[m] = {});
    
    const queues = {};
    ALL_MACHINES.forEach(m => queues[m] = []);
    rmaSessionList.forEach(item => {
      let mqKey = null;
      if (item.maquina === 'SPEEDMASTER' || item.maquina === 'MOZP' || item.maquina === 'GTO-52') {
        mqKey = item.maquina;
      }
      if (mqKey) queues[mqKey].push(item);
    });

    ['SPEEDMASTER', 'MOZP', 'GTO-52'].forEach(machine => {
      if (!queues[machine] || queues[machine].length === 0) return;
      
      let cursorDay = 0;
      let cursorMin = TURNO_INICIO;
      let lastRowLinea = null;
      
      const mqTiempos = tiemposData.find(t => {
        const maqt = (t.maquina || '').toUpperCase().replace(/\s|-/g, '');
        const mac  = machine.toUpperCase().replace(/\s|-/g, '');
        return maqt === mac;
      }) || {};

      function addBlock(duration, type, job, details, customClass) {
        let remaining = duration;
        let iter = 0;
        while (remaining > 0 && iter < 50) {
          iter++;
          const availableInDay = TURNO_FIN - cursorMin;
          const chunk = Math.min(remaining, availableInDay);
          
          if (!scheduledBlocks[machine][cursorDay]) {
            scheduledBlocks[machine][cursorDay] = [];
          }
          
          scheduledBlocks[machine][cursorDay].push({
            startMin: cursorMin,
            duration: chunk,
            type: type,
            job: job,
            details: details,
            cssClass: customClass || ''
          });
          
          cursorMin += chunk;
          remaining -= chunk;
          
          if (cursorMin >= TURNO_FIN && remaining > 0) {
            cursorDay++;
            cursorMin = TURNO_INICIO;
          }
        }
      }

      queues[machine].forEach((job, index) => {
        const cuerposImp = parseFloat(job.n_colores) || 0; 
        const tirajes = parseFloat(job.tirajes) || 0;
        
        const wash = parseFloat(mqTiempos.cambio_color_lavado_rod_tin_x_cuerpo) || 0;
        const prep = parseFloat(mqTiempos.preparado_de_tinta_x_cuerpo) || 0;
        const paramL = (wash + prep) * cuerposImp;
        
        const placaCuerpo = parseFloat(mqTiempos.cambio_placa_por_cuerpo) || 0;
        const aprobacion = parseFloat(mqTiempos.aprobacion) || 0;
        const paramP = (placaCuerpo * cuerposImp) + aprobacion;
        
        const valorProm = parseFloat(mqTiempos.valor_prom) || 1; 
        const paramC = (tirajes / valorProm) * 60;
        
        if (index === 0 || job.linea !== lastRowLinea) {
          if (paramL > 0) {
             addBlock(paramL, 'Cambio de línea + Preparado', job, `${paramL.toFixed(0)} min`, 'block-a-linea');
          }
        }
        lastRowLinea = job.linea;
        
        if (paramP > 0) {
           addBlock(paramP, 'Cambio de placa + Aprobación', job, `${paramP.toFixed(0)} min`, 'block-b-placa');
        }
        
        if (paramC > 0) {
           let detailsC = `Línea: ${job.linea || '-'} | Tirajes: ${tirajes} | Colores: ${cuerposImp}`;
           addBlock(paramC, job.producto || 'Producción', job, detailsC, 'block-c-prod');
        }
      });
    });
    
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
  const SLEN = HOUR_SLOTS.length; // 11

  const DAY_W = 46;   // day label column px
  const HOUR_W = 68;   // hour label column px
  const CELL_W = 90;   // machine cell width px (wider for readability)
  const HR1_H = 38;   // stage group header row height px
  const HR2_H = 52;   // machine name header height px (horizontal text)

  // ── HEADER ROW 1: corner (colspan=2) + stage groups ──
  let hr1 = `<th colspan="2" class="sched-corner" style="
    background:#c81e33;
    width:${HOUR_W + DAY_W}px; min-width:${HOUR_W + DAY_W}px;
    height:${HR1_H}px;
    top:0; z-index:16;
    color:rgba(255,255,255,.7);
    font:600 9px 'Outfit',sans-serif;
    text-transform:uppercase; letter-spacing:.5px;
    text-align:center; padding:0;
  ">08:00–17:30</th>`;

  STAGES.forEach(stage => {
    const bg = '#c81e33';
    hr1 += `<th colspan="${stage.machines.length}" class="sched-th-stage" style="
      background:${bg};
      top:0; height:${HR1_H}px;
    ">${stage.label}</th>`;
  });

  // ── HEADER ROW 2: HORA first, then DÍA, then machine headers ──
  let hr2 = '';

  // Hour column header — leftmost sticky
  hr2 += `<th class="sched-th-hour-corner" style="
    background:#991b1b; color:#fff;
    width:${HOUR_W}px; min-width:${HOUR_W}px; height:${HR2_H}px;
    top:${HR1_H}px; left:0; z-index:13;
    border-right:1px solid rgba(255,255,255,.2);
    border-bottom:2px solid rgba(255,255,255,.15);
    box-shadow:2px 2px 8px rgba(0,0,0,.12);
  ">HORA</th>`;

  // Day column header — second sticky
  hr2 += `<th class="sched-th-day-corner" style="
    background:#7f1d1d; color:#fff;
    width:${DAY_W}px; min-width:${DAY_W}px; height:${HR2_H}px;
    top:${HR1_H}px; left:${HOUR_W}px; z-index:12;
    border-right:2px solid rgba(255,255,255,.2);
    border-bottom:2px solid rgba(255,255,255,.15);
    box-shadow:2px 2px 8px rgba(0,0,0,.15);
  ">DÍA</th>`;

  // Machine name headers — HORIZONTAL text, two-line wrapping allowed
  STAGES.forEach(stage => {
    stage.machines.forEach((machine, mi) => {
      const isFirst = mi === 0;
      hr2 += `<th class="sched-th-machine" data-machine-key="${machine}" style="
        background:#7f1d1d;
        top:${HR1_H}px;
        width:${CELL_W}px; min-width:${CELL_W}px;
        height:${HR2_H}px;
        ${isFirst ? 'border-left:2px solid rgba(255,255,255,.3);' : 'border-left:1px solid rgba(255,255,255,.15);'}
        padding:4px 3px;
        text-align:center; vertical-align:middle;
        font:600 9.5px \'Outfit\',sans-serif;
        color:#fff;
        white-space:normal; word-break:break-word; line-height:1.25;
        letter-spacing:.2px; overflow:hidden;
      ">${machine}<div class="resize-col-handle"></div></th>`;
    });
  });

  // ── BODY: Days × Event Boundaries ──
  let body = '';
  DAYS.forEach((day, di) => {
    const isLastDay = di === DAYS.length - 1;

    // 1. Recolectar Hitos
    let timeSet = new Set([480, 1050]); // 08:00 and 17:30
    STAGES.forEach(stage => {
      stage.machines.forEach(machine => {
        const blks = scheduledBlocks[machine]?.[di] || [];
        blks.forEach(blk => {
          timeSet.add(Math.round(blk.startMin));
          timeSet.add(Math.round(blk.startMin + blk.duration));
        });
      });
    });
    
    let timeBoundaries = Array.from(timeSet).sort((a,b) => a - b);
    let skipRows = {};
    ALL_MACHINES.forEach(m => skipRows[m] = 0);
    
    const SLEN = timeBoundaries.length - 1;

    for (let r = 0; r < SLEN; r++) {
      const startMin = timeBoundaries[r];
      const isFirstSlot = r === 0;
      const isLastSlot = r === SLEN - 1;
      const stStr = mkTimeFromMins(startMin);

      const hourCell = `<td class="sched-td-hour" style="
        background:#7f1d1d; color:#fff;
        width:${HOUR_W}px; min-width:${HOUR_W}px; max-width:${HOUR_W}px;
        position:sticky; left:0; z-index:4;
        border-right:1px solid rgba(255,255,255,.15);
        border-bottom:${isLastSlot && !isLastDay ? '3px solid rgba(255,255,255,.2)' : '1px solid rgba(255,255,255,.08)'};
        font:600 11px 'Outfit',sans-serif; letter-spacing:.3px;
        vertical-align: top; padding-top: 4px; text-align: center;
      ">${stStr}</td>`;

      const dayCell = isFirstSlot ? `<td rowspan="${SLEN}" class="sched-td-day" style="
        background:#991b1b;
        width:${DAY_W}px; min-width:${DAY_W}px; max-width:${DAY_W}px;
        position:sticky; left:${HOUR_W}px; z-index:5;
        border-bottom:${isLastDay ? 'none' : '3px solid rgba(255,255,255,.25)'};
        border-right:2px solid rgba(255,255,255,.2);
        box-shadow:2px 0 6px rgba(0,0,0,.08);
      "><div class="sched-day-inner">${day}</div></td>` : '';

      let machineCells = '';
      STAGES.forEach(stage => {
        const isImpresion = stage.id === 'impresion';
        stage.machines.forEach((machine, mi) => {
          const isFirstOfStage = mi === 0;
          
          if (skipRows[machine] > 0) {
            skipRows[machine]--;
            return;
          }

          if (isImpresion) {
            const blks = scheduledBlocks[machine]?.[di] || [];
            const activeBlk = blks.find(b => Math.round(b.startMin) === startMin);
            
            if (activeBlk) {
              const endMin = Math.round(activeBlk.startMin + activeBlk.duration);
              let span = 1;
              for (let k = r + 1; k < timeBoundaries.length; k++) {
                if (timeBoundaries[k] <= endMin) {
                  span = k - r;
                } else break;
              }
              skipRows[machine] = span - 1;
              
              const st = mkTimeFromMins(activeBlk.startMin);
              const et = mkTimeFromMins(activeBlk.startMin + activeBlk.duration);
              const durationStr = `(${Math.round(activeBlk.duration)} min)`;

              let contentHtml = '';
              let colorStyle = '';
              
              if (activeBlk.cssClass === 'block-c-prod') {
                const titleArgs = `${escH(activeBlk.job.n)} - ${escH(activeBlk.job.producto || 'Producción')}`;
                contentHtml = `
                <div class="sched-task-card-row t-title">${titleArgs}</div>
                <div class="sched-task-card-row t-sub">Línea: ${escH(activeBlk.job.linea || '-')} | Tirajes: ${escH(activeBlk.job.tirajes)} | Colores: ${escH(activeBlk.job.n_colores)}</div>
                <div class="sched-task-card-row t-time">${st} - ${et} ${durationStr}</div>
                `;
                const bgCol = getColorByRMA(activeBlk.job.n);
                colorStyle = `background: ${bgCol}; color: #fff; border: 1px solid rgba(0,0,0,0.1);`;
              } else {
                const titleText = activeBlk.cssClass === 'block-a-linea' ? 'CAMBIO DE LÍNEA + PREPARADO DE PINTURA' : 'CAMBIO DE PLACA + APROBACIÓN';
                contentHtml = `
                <div class="sched-task-card-row t-title">${titleText}</div>
                <div class="sched-task-card-row t-time">${st} - ${et} ${durationStr}</div>
                `;
              }
              
              const cardClass = 'sched-task-card ' + activeBlk.cssClass;
              
              machineCells += `<td rowspan="${span}" class="sched-cell-impresion" style="
                width:${CELL_W}px;min-width:${CELL_W}px; padding:4px; vertical-align:middle;
                ${isFirstOfStage ? 'border-left:2px solid rgba(0,0,0,.1);' : 'border-left:1px solid rgba(0,0,0,.05);'}
                border-bottom: 1px solid var(--border-color); background: #fdfdfd;
              ">
                <div class="${cardClass}" style="${colorStyle}">
                  ${contentHtml}
                </div>
              </td>`;
            } else {
              machineCells += `<td class="sched-cell-impresion" style="
                width:${CELL_W}px;min-width:${CELL_W}px; padding:0;
                ${isFirstOfStage ? 'border-left:2px solid rgba(0,0,0,.1);' : 'border-left:1px solid rgba(0,0,0,.05);'}
                border-bottom: 1px solid var(--border-color); background: #fdfdfd;
              "></td>`;
            }
          } else {
            machineCells += `<td class="sched-cell" style="
                width:${CELL_W}px;min-width:${CELL_W}px;background:#fff;
                border-bottom:${isLastSlot && !isLastDay ? '3px solid rgba(185,28,44,.2)' : '1px solid var(--border-color)'};
                ${isFirstOfStage ? 'border-left:2px solid rgba(0,0,0,.1);' : 'border-left:1px solid rgba(0,0,0,.05);'}
              "></td>`;
          }
        });
      });

      body += `<tr>${hourCell}${dayCell}${machineCells}</tr>`;
    }

    // Day separator row
    if (!isLastDay) {
      const totalCols = 2 + ALL_MACHINES.length;
      body += `<tr class="sched-day-sep-row"><td colspan="${totalCols}"></td></tr>`;
    }
  });

  // ── CONFIG PANEL ──
  const machOpts = ALL_MACHINES.map(m => `<option value="${m}">${m}</option>`).join('');
  const cenaVis = schedState.nightShifts.length > 0;

  const cfgPanel = `
    <div class="config-panel-toggle" id="config-panel-toggle" title="Panel de configuración">
      <i class="uil ${schedState.configPanelOpen ? 'uil-angle-right' : 'uil-angle-left'}" id="cfg-toggle-icon"></i>
    </div>
    <div class="config-panel ${schedState.configPanelOpen ? 'open' : ''}" id="config-panel">
      <div class="config-panel-inner">
        <div class="config-panel-title"><i class="uil uil-setting"></i> Configuración</div>
        <div class="cfg-section">
          <div class="cfg-section-header"><i class="uil uil-utensils-alt"></i> Almuerzo</div>
          <div class="cfg-section-body">
            <div class="cfg-row">
              <div class="cfg-field"><label>Hora inicio</label><input type="time" class="cfg-input" id="cfg-lunch-start" value="${schedState.lunchStart}"></div>
              <div class="cfg-field"><label>Hora fin</label><input type="time" class="cfg-input" id="cfg-lunch-end" value="${schedState.lunchEnd}"></div>
            </div>
            <button class="cfg-apply-btn" id="cfg-btn-lunch"><i class="uil uil-check"></i> Aplicar almuerzo</button>
            ${schedState.lunchEnabled ? `<button class="cfg-apply-btn" id="cfg-btn-lunch-clear" style="background:var(--bg-main);color:var(--text-secondary);border:1px solid var(--border-color);box-shadow:none;margin-top:4px;"><i class="uil uil-times"></i> Quitar almuerzo</button>` : ''}
          </div>
        </div>
        <div class="cfg-section">
          <div class="cfg-section-header"><i class="uil uil-moon"></i> Horario Nocturno</div>
          <div class="cfg-section-body">
            <div class="cfg-row">
              <div class="cfg-field"><label>Fecha inicio</label><input type="date" class="cfg-input" id="cfg-night-date-start"></div>
              <div class="cfg-field"><label>Fecha fin</label><input type="date" class="cfg-input" id="cfg-night-date-end"></div>
            </div>
            <div class="cfg-row">
              <div class="cfg-field"><label>Hora inicio</label><input type="time" class="cfg-input" id="cfg-night-ts" value="18:00"></div>
              <div class="cfg-field"><label>Hora fin</label><input type="time" class="cfg-input" id="cfg-night-te" value="23:00"></div>
            </div>
            <div class="cfg-field"><label>Máquina</label><select class="cfg-input" id="cfg-night-machine">${machOpts}</select></div>
            <button class="cfg-apply-btn" id="cfg-btn-night"><i class="uil uil-plus-circle"></i> Registrar turno</button>
            <div id="cfg-night-list" class="cfg-night-list">${buildNightHTML()}</div>
            <div id="cfg-cena-section" style="display:${cenaVis ? 'block' : 'none'};">
              <div style="margin:8px -12px 10px;padding:8px 12px;border-top:1px solid var(--border-color);background:#fffbf0;display:flex;align-items:center;gap:8px;font:600 10px 'Outfit',sans-serif;text-transform:uppercase;letter-spacing:.7px;color:#92400e;"><i class="uil uil-coffee"></i> Cena</div>
              <div class="cfg-row">
                <div class="cfg-field"><label>Hora inicio</label><input type="time" class="cfg-input" id="cfg-cena-start" value="20:00"></div>
                <div class="cfg-field"><label>Hora fin</label><input type="time" class="cfg-input" id="cfg-cena-end" value="20:30"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  contentBody.innerHTML = `
    ${buildDateBarHTML('eta')}
    <div class="schedule-outer" style="flex:1;overflow:hidden;position:relative;">
      <div class="schedule-wrap">
        <div class="schedule-scroll">
          <div class="schedule-table-container" id="schedule-table-container"
            style="transform:scale(1);transform-origin:top left;display:inline-block;min-width:100%;">
            <table class="sched-table" style="border-collapse:collapse;table-layout:fixed;">
              <colgroup>
                <col data-ci="0" style="width:${HOUR_W}px;">
                <col data-ci="1" style="width:${DAY_W}px;">
                ${ALL_MACHINES.map((_, i) => `<col data-ci="${i + 2}" style="width:${CELL_W}px;">`).join('')}
              </colgroup>
              <thead>
                <tr>${hr1}</tr>
                <tr>${hr2}</tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
      </div>
      ${cfgPanel}
      ${zoomBadgeHTML()}
    </div>`;

  wireDateBar('eta', exportCronogramaPorEtapa);
  wireFullscreenBtn();
  document.getElementById('config-panel-toggle').addEventListener('click', toggleConfigPanel);
  document.getElementById('cfg-btn-lunch').addEventListener('click', applyLunch);
  document.getElementById('cfg-btn-lunch-clear')?.addEventListener('click', clearLunch);
  document.getElementById('cfg-btn-night').addEventListener('click', addNightShift);
  contentBody.querySelectorAll('.sched-cell').forEach(c => c.addEventListener('click', onCellClick));

  // Make machine columns and hour rows resizable
  setTimeout(() => initResizable('etapa'), 60);
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
  schedState.configPanelOpen = !schedState.configPanelOpen;
  document.getElementById('config-panel')?.classList.toggle('open', schedState.configPanelOpen);
  const ico = document.getElementById('cfg-toggle-icon');
  if (ico) ico.className = `uil ${schedState.configPanelOpen ? 'uil-angle-right' : 'uil-angle-left'}`;
}
function reRenderEtapa() { schedState.configPanelOpen = true; renderCronogramaPorEtapa(); }

// LUNCH
function applyLunch() {
  schedState.lunchStart = document.getElementById('cfg-lunch-start')?.value || '13:00';
  schedState.lunchEnd = document.getElementById('cfg-lunch-end')?.value || '14:00';
  schedState.lunchEnabled = true;
  const sM = t2m(schedState.lunchStart), eM = t2m(schedState.lunchEnd);
  ALL_MACHINES.forEach(m => DAYS.forEach((_, di) => HOUR_SLOTS.forEach((slot, si) => {
    if (slot.start >= sM && slot.start < eM && schedState.cells[m]?.[di]?.[si] !== undefined)
      schedState.cells[m][di][si] = 'lunch';
  })));
  reRenderEtapa();
}
function clearLunch() {
  schedState.lunchEnabled = false;
  ALL_MACHINES.forEach(m => DAYS.forEach((_, di) => HOUR_SLOTS.forEach((_, si) => {
    if (schedState.cells[m]?.[di]?.[si] === 'lunch') schedState.cells[m][di][si] = '';
  })));
  reRenderEtapa();
}

// NIGHT SHIFT
function addNightShift() {
  const machine = document.getElementById('cfg-night-machine')?.value;
  const dateStart = document.getElementById('cfg-night-date-start')?.value || '';
  const dateEnd = document.getElementById('cfg-night-date-end')?.value || '';
  const timeStart = document.getElementById('cfg-night-ts')?.value || '';
  const timeEnd = document.getElementById('cfg-night-te')?.value || '';
  const cenaStart = document.getElementById('cfg-cena-start')?.value || '';
  const cenaEnd = document.getElementById('cfg-cena-end')?.value || '';
  if (!machine || !timeStart || !timeEnd) return;
  schedState.nightShifts.push({ machine, dateStart, dateEnd, timeStart, timeEnd, cenaStart, cenaEnd });
  const sM = t2m(timeStart), eM = t2m(timeEnd);
  DAYS.forEach((_, di) => HOUR_SLOTS.forEach((slot, si) => {
    if (slot.start >= sM && slot.start < eM && schedState.cells[machine]?.[di]?.[si] !== undefined)
      schedState.cells[machine][di][si] = 'night';
  }));
  reRenderEtapa();
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
function buildNightHTML() {
  return schedState.nightShifts.map((s, i) => `
    <div class="cfg-night-item">
      <strong>${s.machine}</strong>
      <span>${s.dateStart || '—'} → ${s.dateEnd || '—'}</span>
      <span>${s.timeStart} – ${s.timeEnd}</span>
      ${s.cenaStart ? `<span style="color:#92400e;">Cena: ${s.cenaStart}–${s.cenaEnd}</span>` : ''}
      <button class="cfg-night-remove" onclick="removeNightShift(${i})">✕</button>
    </div>`).join('');
}

// CELL CLICK
function onCellClick(e) {
  const cell = e.currentTarget;
  const machine = cell.dataset.machine, di = +cell.dataset.day, si = +cell.dataset.slot;
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
          if (container) container.innerHTML = renderRMATable();
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
function t2m(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function fmtDate() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
function dlCsv(csv, name) { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); const a = Object.assign(document.createElement('a'), { href: url, download: name }); document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); }
function escH(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// ─────────────────────────────────────────────────────────────
//  RESIZABLE COLUMNS & ROWS — SCHEDULE TABLES
//  Only active on red (header) cells. Drag right edge = resize col.
//  Drag bottom edge = resize row.
// ─────────────────────────────────────────────────────────────
function initResizable(viewType) {
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
      const newW = Math.max(50, startW + (ev.clientX - startX));
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
