// Applies the OS light/dark preference before first paint (kept out of index.html because the CSP blocks inline scripts).
(function () {
  var m = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () { document.documentElement.classList.toggle('dark', m.matches); };
  apply();
  m.addEventListener('change', apply);
})();
