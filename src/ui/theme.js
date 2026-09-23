// @ts-check
/**
 * Light / dark theme.
 *
 * The theme lives as `data-theme` on `<html>` and every colour is a CSS custom
 * property, including the viewport clear colour - the WebGL canvas reads
 * `--viewport-bg` back out of the stylesheet rather than keeping its own copy,
 * so there is exactly one place where a colour is defined.
 */

const STORAGE_KEY = 'pixhull.theme';

/** @typedef {'light'|'dark'} Theme */

/** @returns {Theme} */
export function detectTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Blocked storage just means we fall back to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** @returns {Theme} */
export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** @param {Theme} theme */
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not remembering the choice is not a reason to refuse it.
  }
}

/** @returns {Theme} the theme now in effect */
export function toggleTheme() {
  const next = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}

/**
 * Read a CSS custom property holding `#rgb` or `#rrggbb` as GL float components.
 * @param {string} name
 * @returns {[number, number, number, number]}
 */
export function cssColorToGl(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let hex = raw.replace('#', '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) return [0, 0, 0, 1];
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}
