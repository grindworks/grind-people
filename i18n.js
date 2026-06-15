/**
 * Grind PWA Common I18n Module (Multi-file Support)
 */
window.I18n = (() => {
    let messages = {};
    let currentLang = 'en';

    return {
        /** Initialize language system (Async) */
        init: async function (lang = 'ja') {
            // PHP版と同じサニタイズ
            const validLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

            try {
                // PHPの require __DIR__ . "/lang/{$lang}.php" に相当！
                const module = await import(`./lang/${validLang}.js`);
                messages = module.default;
                currentLang = validLang;
            } catch (e) {
                // ファイルが存在しない場合は en.js にフォールバック
                console.warn(`Language file [${validLang}.js] not found. Falling back to en.js`);
                try {
                    const fallback = await import(`./lang/en.js`);
                    messages = fallback.default;
                } catch (fallbackErr) {
                    console.error("Fallback language file also not found.", fallbackErr);
                }
                currentLang = 'en';
            }

            // 状態の保存とHTMLの反映
            localStorage.setItem('app_lang', currentLang);
            document.documentElement.lang = currentLang;
            this.updateDOM();
        },

        /** Retrieve translated string. */
        get: function (key, params = []) {
            // 💡 既存のフラットキー完全一致を優先し、なければドット記法でネストを解決するハイブリッドアプローチ
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
            document.querySelectorAll('[data-i18n]').forEach(el => {
                el.innerHTML = this.get(el.getAttribute('data-i18n'));
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
