(function () {
  if (window.navigationInputGuard) return;
  window.navigationInputGuard = true;

  // Delegate so forms created later (including dialogs) receive the same guard.
  document.addEventListener('wheel', function (event) {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === 'number'
      && document.activeElement === input) {
      event.preventDefault();
    }
  }, { capture: true, passive: false });
})();
