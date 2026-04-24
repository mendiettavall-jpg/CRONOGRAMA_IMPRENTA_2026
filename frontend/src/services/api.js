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

// Exponer el cliente globalmente para mantener la compatibilidad con el código existente
window.supabaseClient = supabaseClient;

// ================================
// CAPA DE SERVICIOS (CONSULTAS)
// ================================

async function apiGetAllBtImprenta() {
    if (!supabaseClient) return { data: null, error: new Error("Sin conexión a Supabase") };
    return await supabaseClient.from('bt_imprenta').select('*');
}

async function apiGetBtImprentaByCodigos(codigos) {
    if (!supabaseClient) return { data: null, error: new Error("Sin conexión a Supabase") };
    return await supabaseClient
      .from('bt_imprenta')
      .select('codigo, n_troquel, cajas_por_tiraje, tirajes_por_pliego, maquina_preferencial, codigo_2')
      .in('codigo', codigos);
}

async function apiGetRmaByNumero(n) {
    if (!supabaseClient) return { data: null, error: new Error("Sin conexión a Supabase") };
    return await supabaseClient
      .from('rma')
      .select('n, producto, presentacion_comercial, material_requerido, codigo_material, cantidad_requerida_para_cubrir')
      .eq('n', n)
      .limit(1);
}

async function apiGetBtImprentaSearchCodigo(codigo) {
    if (!supabaseClient) return { data: null, error: new Error("Sin conexión a Supabase") };
    return await supabaseClient
      .from('bt_imprenta')
      .select('codigo, linea, cantidad_de_colores')
      .eq('codigo', codigo);
}

async function apiGetAllTiempos() {
    if (!supabaseClient) return { data: null, error: new Error("Sin conexión a Supabase") };
    return await supabaseClient.from('tiempos').select('*');
}

// ================================
// EXPOSICIÓN GLOBAL
// ================================
window.apiGetAllBtImprenta = apiGetAllBtImprenta;
window.apiGetBtImprentaByCodigos = apiGetBtImprentaByCodigos;
window.apiGetRmaByNumero = apiGetRmaByNumero;
window.apiGetBtImprentaSearchCodigo = apiGetBtImprentaSearchCodigo;
window.apiGetAllTiempos = apiGetAllTiempos;
