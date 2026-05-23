(() => {
  const currentScript = document.currentScript;
  const src = currentScript?.src ? new URL("index.js", currentScript.src).href : "";
  if (!src) return;
  const script = document.createElement("script");
  script.src = src;
  script.onload = () => console.log("[Native Feed Bridge] Webkit shim loaded");
  document.documentElement.appendChild(script);
})();
