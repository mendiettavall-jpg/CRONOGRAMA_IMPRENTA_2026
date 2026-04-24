window.calcCiclos = function calcCiclos(nColoresRaw, maquina, materialRequerido) {
  const nColores = parseFloat(nColoresRaw);
  
  if (isNaN(nColores) || !maquina) {
    return null;
  }

  const maq = String(maquina).toUpperCase().trim();
  let divisor = 2; // Default for SPEEDMASTER/MOZP
  if (maq === 'GTO-52') {
    divisor = 4;
  }

  let ciclos = Math.ceil(nColores / divisor);
  
  // Validación estricta de SOBRES
  const mat = String(materialRequerido || '').toUpperCase().trim();
  if (mat === 'SOBRES') {
    ciclos += 1;
  }
  
  return ciclos;
};

window.calcTirajes = function calcTirajes(cantidadRequerida, tirajesPorPliego) {
  const cantidad = parseFloat(cantidadRequerida);
  const tirajesPliego = parseFloat(tirajesPorPliego);

  if (isNaN(cantidad) || isNaN(tirajesPliego) || tirajesPliego <= 0) {
    return null;
  }

  const tirajeBase = cantidad / tirajesPliego;
  // Margen de seguridad del 10% (Regla fija de negocio)
  const tirajeFinal = Math.ceil(tirajeBase * 1.10);
  
  return tirajeFinal;
};
