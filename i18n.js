/**
 * Grind PWA Common I18n Module (Multi-file Support)
 */
window.I18n = (() => {
  let messages = {};
  let currentLang = 'en';

  return {
    /** Initialize language system (Async) */
    init: async function (lang = 'en') {
      // Allow only safe characters in the language code
      const validLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

      try {
        // Load the language file as a module
        const module = await import(`./lang/${validLang}.js`);
        messages = module.default;
        currentLang = validLang;
      } catch (e) {
        // Fall back to en.js when the file is missing
        console.warn(`Language file [${validLang}.js] not found. Falling back to en.js`);
        try {
          const fallback = await import(`./lang/en.js`);
          messages = fallback.default;
        } catch (fallbackErr) {
          console.error('Fallback language file also not found.', fallbackErr);
        }
        currentLang = 'en';
      }

      // Persist the choice and update the page
      try {
        localStorage.setItem('app_lang', currentLang);
      } catch (e) {
        console.warn('Failed to save language to localStorage');
      }
      document.documentElement.lang = currentLang;
      this.updateDOM();
    },

    /** Retrieve translated string. */
    get: function (key, params = []) {
      // Prefer an exact flat key; otherwise resolve dot notation as a nested path
      let text = messages[key];
      if (text === undefined) {
        text = key
          .split('.')
          .reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : undefined), messages);
      }
      text = text !== undefined ? String(text) : key;

      if (params.length > 0) {
        text = text.replace(/\{(\w+)\}/g, (match, key) => {
          const val =
            params.length === 1 && typeof params[0] === 'object' && params[0] !== null
              ? params[0][key]
              : params[key];
          return val === null || val === undefined ? '' : String(val);
        });
      }
      return text;
    },

    /** Update all DOM elements with data-i18n attributes. */
    updateDOM: function () {
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = this.get(el.getAttribute('data-i18n'));
      });
      document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        el.innerHTML = this.get(el.getAttribute('data-i18n-html'));
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', this.get(el.getAttribute('data-i18n-placeholder')));
      });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', this.get(el.getAttribute('data-i18n-title')));
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', this.get(el.getAttribute('data-i18n-aria-label')));
      });
    },

    getLang: () => currentLang,
  };
})();

/** Global translation helper. */
window._t = function (key, ...params) {
  return window.I18n ? window.I18n.get(key, params) : key;
};
