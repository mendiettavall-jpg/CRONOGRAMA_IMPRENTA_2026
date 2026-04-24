window.renderPlanificacion = function renderPlanificacion() {
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
        ${window.renderRMATable()}
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
        await window.buscarRMA(val);
        input.value = '';
      }
    });
  }

  // Listener para navegación por teclado en la tabla
  const tableContainer = document.getElementById('rma-list-container');
  if (tableContainer) {
    tableContainer.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('plan-maquina-input')) {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        const total = rmaSessionList.length;

        if (e.key === 'Enter') {
          e.preventDefault();
          // Calcular el siguiente índice (si es el último, se queda en el mismo)
          const nextIdx = (idx < total - 1) ? idx + 1 : idx;
          cargarDatosTecnicos(nextIdx);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (idx < total - 1) {
            const nextInput = tableContainer.querySelector(`.plan-maquina-input[data-idx="${idx + 1}"]`);
            if (nextInput) nextInput.focus();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (idx > 0) {
            const prevInput = tableContainer.querySelector(`.plan-maquina-input[data-idx="${idx - 1}"]`);
            if (prevInput) prevInput.focus();
          }
        }
      }
    });
  }
};

window.renderRMATable = function renderRMATable() {

  if (rmaSessionList.length === 0) {
    return `<div class="empty-state" style="padding: 60px 40px;">
              <i class="uil uil-search"></i>
              <p>No hay RMAs añadidos aún.</p>
            </div>`;
  }

  const rowsHtml = rmaSessionList.map((item, index) => {
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
                 data-idx="${index}"
                 value="${item.maquina || ''}" 
                 oninput="updateRmaMaquina('${item.n}', this.value, this)"
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

  const htmlStr = `
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
        <button class="btn-generar-crono" onclick="generarCronogramaEtapa()" style="background:var(--accent-red);color:#fff;border:none;padding:8px 16px;border-radius:8px;font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">
          <i class="uil uil-calendar-alt"></i> GENERAR CRONOGRAMA
        </button>
      </div>
    </div>
  `;

  // Exponer para test de streaming sin afectar el flujo local de script.js
  window.rmaSessionListDebug = rmaSessionList;
  return htmlStr;
};

window.updateRmaMaquina = function updateRmaMaquina(rmaN, val, inputEl) {

  const item = rmaSessionList.find(i => window.normCol(i.n) === window.normCol(rmaN));
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
};

window.buscarRMA = async function buscarRMA(n) {
  // Validar duplicados
  if (rmaSessionList.some(item => String(item.n) === String(n))) {
    showSaveToast("El RMA #" + n + " ya está en la lista");
    return;
  }

  if (!window.supabaseClient) {
    console.error("Supabase client no inicializado");
    showSaveToast("Error: Sin conexión");
    return;
  }

  try {
    const { data, error } = await window.apiGetRmaByNumero(n);

    if (error) throw error;

    if (!data || data.length === 0) {
      showSaveToast("RMA #" + n + " no encontrado");
      return;
    }

    if (data && data.length > 0) {
      const rmaItem = data[0];
      const searchKey = window.normCol(rmaItem.codigo_material);

      // 2. Buscar datos técnicos iniciales en BT Imprenta
      // Usamos una consulta robusta y filtramos en JS para coincidir con la lógica del Batch
      const { data: btRows, error: btError } = await window.apiGetBtImprentaSearchCodigo(rmaItem.codigo_material.trim());
      
      const btMatch = btRows ? btRows.find(r => window.normCol(r.codigo) === searchKey) : null;
      
      if (!btError && btMatch) {
        rmaItem.linea = btMatch.linea || '-';
        rmaItem.n_colores = btMatch.cantidad_de_colores || '-';
      } else {
        rmaItem.linea = '-';
        rmaItem.n_colores = '-';
      }

      // 3. Inicializar campos de carga posterior (vacíos)
      rmaItem.maquina = '';
      // ciclos, tirajes, etc. se mantienen undefined hasta presionar CARGAR

      rmaSessionList.unshift(rmaItem);
      const container = document.getElementById('rma-list-container');
      if (container) container.innerHTML = window.renderRMATable();
    }

  } catch (err) {
    console.error("Error al buscar RMA:", err);
    showSaveToast("Error al consultar Supabase");
  }
};
