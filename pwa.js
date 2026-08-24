// Progressive-web-app registration. Kept as its own module (app.js untouched)
// so the service worker is a purely additive layer: if registration fails for
// any reason, the app runs exactly as before.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline caching is a bonus, never a requirement — swallow failures.
    });
  });
}
