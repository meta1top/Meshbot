(() => {
  try {
    const t = localStorage.getItem("meshbot-theme");
    const d = document.documentElement;
    if (
      t === "dark" ||
      (t !== "light" && matchMedia("(prefers-color-scheme:dark)").matches)
    ) {
      d.classList.add("dark");
    } else {
      d.classList.remove("dark");
    }
  } catch (_) {}
})();
