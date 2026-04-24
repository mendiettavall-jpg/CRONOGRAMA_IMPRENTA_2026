window.escH = function escH(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
  }[tag]));
};

window.getCleanTroquelKey = function getCleanTroquelKey(val) {
  const s = String(val || '').trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'null') return null;
  return s;
};

window.normCol = function normCol(val) {
  return String(val || "").trim().toUpperCase();
};

window.normMaq = function normMaq(val) {
  return window.normCol(val).replace(/-/g, "").replace(/\s+/g, "");
};
