// Theme is a CSS class on <html> plus a localStorage preference. The initial
// class is set pre-paint by an inline script in index.html (no flash), and the
// toggle icon follows the `.dark` class via CSS — so there is no React state to
// hold. This is a plain module function any component calls directly, which is
// why the old toggleTheme prop-drill (SkillApp -> Home/TopBar/Terminals) is gone.
export function toggleTheme() {
  const isDark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("skillviewer-theme", isDark ? "dark" : "light");
  } catch {}
}
