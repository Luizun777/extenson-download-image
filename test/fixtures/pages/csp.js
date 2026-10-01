'use strict';
// Script externo de csp.html: marca que se ejecutó y vuelca a consola cualquier violación de CSP.
document.addEventListener('securitypolicyviolation', (e) => {
  console.error('CSP violation: ' + e.violatedDirective + ' ' + (e.blockedURI || ''));
});
document.documentElement.dataset.cspJs = 'ok';
document.getElementById('js-status').textContent = 'csp.js ejecutado';
