// Applies the theme before first paint (kept out of index.html because the CSP blocks inline scripts). Dark is the
// default; a saved "light" choice overrides it. src/lib/theme.ts reads and writes the same key.
(function () {
  var t = null;
  try { t = localStorage.getItem('tokenburn-theme'); } catch (e) {}
  document.documentElement.classList.toggle('dark', t !== 'light');
})();
