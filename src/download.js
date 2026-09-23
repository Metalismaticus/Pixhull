// @ts-check
/**
 * The local-app page.
 *
 * Shares the app's language and theme, both of which live in localStorage, so
 * arriving here from the app keeps whatever was chosen there rather than
 * resetting to English on a light background.
 */

import { t, getLang, setLang, applyTranslations } from './i18n.js';
import { detectTheme, getTheme, setTheme, toggleTheme } from './ui/theme.js';

/** @param {string} id */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el;
};

function refreshThemeButton() {
  $('theme-icon').textContent = getTheme() === 'light' ? '◑' : '◐';
}

function refreshLanguageButton() {
  $('btn-lang').textContent = getLang().toUpperCase();
}

/**
 * Copy-to-clipboard on every command block. The page exists so somebody can
 * paste a command into a config file; making them select it by hand would be a
 * poor joke.
 */
function wireCopyButtons() {
  for (const el of document.querySelectorAll('pre[data-copy]')) {
    const pre = /** @type {HTMLElement} */ (el);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = t('dl.copy');
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = t('dl.copied');
      } catch {
        // Clipboard access can be refused; selecting the text still works.
        button.textContent = t('dl.copyFailed');
      }
      setTimeout(() => { button.textContent = t('dl.copy'); }, 1600);
    });
    pre.appendChild(button);
  }
}

function retranslate() {
  applyTranslations();
  refreshLanguageButton();
  for (const b of document.querySelectorAll('pre[data-copy] .copy')) {
    b.textContent = t('dl.copy');
  }
}

setTheme(detectTheme());
refreshThemeButton();
setLang(getLang());
applyTranslations();
refreshLanguageButton();
wireCopyButtons();

$('btn-theme').addEventListener('click', () => {
  toggleTheme();
  refreshThemeButton();
});

$('btn-lang').addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'ru' : 'en');
  retranslate();
});
