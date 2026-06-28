/**
 * Grind PWA Common I18n Module (Multi-file Support)
 */
window.I18n = (() => {
    let messages = {};
    let currentLang = 'en';

    return {
        /** Initialize language system (Async) */
        init: async function (lang = 'ja') {
            // Same sanitization as PHP version
            const validLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

            try {
                // Equivalent to PHP's require __DIR__ . "/lang/{$lang}.php"!
                const module = await import(`./lang/${validLang}.js`);
                messages = module.default;
                currentLang = validLang;
            } catch (e) {
                // Fallback to en.js if file does not exist
                console.warn(`Language file [${validLang}.js] not found. Falling back to en.js`);
                try {
                    const fallback = await import(`./lang/en.js`);
                    messages = fallback.default;
                } catch (fallbackErr) {
                    console.error("Fallback language file also not found.", fallbackErr);
                }
                currentLang = 'en';
            }

            // Save state and reflect in HTML
            localStorage.setItem('app_lang', currentLang);
            document.documentElement.lang = currentLang;
            this.updateDOM();
        },

        /** Retrieve translated string. */
        get: function (key, params = []) {
            // 💡 Hybrid approach prioritizing exact flat key match, falling back to resolving nesting with dot notation
            let text = messages[key];
            if (text === undefined) {
                text = key.split('.').reduce((obj, k) => (obj && obj[k] !== undefined) ? obj[k] : undefined, messages);
            }
            text = text !== undefined ? String(text) : key;

            if (params.length > 0) {
                if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null) {
                    const objParams = params[0];
                    if (Array.isArray(objParams)) {
                        objParams.forEach((val, i) => {
                            const safeVal = (val === null || val === undefined) ? '' : String(val);
                            text = text.split(`{${i}}`).join(safeVal);
                        });
                    } else {
                        for (const [k, v] of Object.entries(objParams)) {
                            const safeVal = (v === null || v === undefined) ? '' : String(v);
                            text = text.split(`{${k}}`).join(safeVal);
                        }
                    }
                } else {
                    params.forEach((val, i) => {
                        const safeVal = (val === null || val === undefined) ? '' : String(val);
                        text = text.split(`{${i}}`).join(safeVal);
                    });
                }
            }
            return text;
        },

        /** Update all DOM elements with data-i18n attributes. */
        updateDOM: function () {
            // Secure text insertion (Default)
            document.querySelectorAll('[data-i18n]').forEach(el => {
                el.textContent = this.get(el.getAttribute('data-i18n'));
            });
            // Explicit insertion allowing HTML tags
            document.querySelectorAll('[data-i18n-html]').forEach(el => {
                el.innerHTML = this.get(el.getAttribute('data-i18n-html'));
            });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                el.setAttribute('placeholder', this.get(el.getAttribute('data-i18n-placeholder')));
            });
            document.querySelectorAll('[data-i18n-title]').forEach(el => {
                el.setAttribute('title', this.get(el.getAttribute('data-i18n-title')));
            });
        },

        getLang: () => currentLang
    };
})();

/** Global translation helper. */
window._t = function(key, ...params) {
    return window.I18n.get(key, params);
};
