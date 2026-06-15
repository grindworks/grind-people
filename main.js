let db = null; // SQLiteデータベースのインスタンス
let SQL = null; // sql.jsのモジュール
let fileHandle = null; // File System Access APIのファイルハンドル
let isDirty = false; // 未保存の変更があるかどうか
window.getIsDirty = () => isDirty;
let pendingCSVData = []; // CSVパース結果の一時保存
let pendingCSVBuffer = null; // CSVのバイナリデータ
let currentActiveTag = null; // 現在選択中のカテゴリ（タグ）
let currentDisplayedTotal = 0; // カウントアップ用
let collapsedBlocks = new Set(); // 折りたたまれたブロックのIDを記憶
let totalAnimationId = null; // アニメーションの多重起動防止用ID
let draftTimer = null; // ドラフト自動保存用タイマー
let statusTimeoutId = null; // ステータスバー通知のタイマーID
let isSaving = false; // 保存処理の多重実行防止フラグ
let lastSavedPasswordHash = ""; // パスワードのハッシュ値を保持 (平文保持の回避)
let preDetailActiveElement = null; // 詳細モーダルを開く直前のフォーカス要素
let originalDetailDataSnapshot = null; // 詳細モーダルの「変更なし」検知用スナップショット

const isMac =
  (navigator.userAgentData && navigator.userAgentData.platform === "macOS") ||
  navigator.platform.toUpperCase().indexOf("MAC") >= 0 ||
  navigator.userAgent.toUpperCase().indexOf("MAC") >= 0;

let customRoleDict = []; // カスタム役職辞書の配列

// --- スクロールロック制御 (Layout Shift対策) ---
function lockScroll() {
  document.body.style.overflow = "hidden";
}

// SHA-256 ハッシュを計算するヘルパー関数
async function sha256(message) {
  if (typeof message !== 'string' || message.length === 0) return "";
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

function unlockScroll() {
  document.body.style.overflow = "";
}

// --- 画面背面のUIを完全にロックするヘルパー ---
function toggleMainUI(disabled) {
  const els = [
    document.getElementById("app-ui"),
    document.getElementById("toc-container"),
    document.querySelector("header"),
  ];
  els.forEach((el) => {
    if (el) {
      if (disabled) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  });
}

// --- ダークモード管理 ---
function initDarkMode() {
  const saved = localStorage.getItem("theme");
  if (
    saved === "dark" ||
    (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  document.documentElement.style.colorScheme =
    document.documentElement.classList.contains("dark") ? "dark" : "light";
  updateMetaThemeColor(document.documentElement.classList.contains("dark"));
}

function toggleDarkMode() {
  if (document.startViewTransition) {
    document.startViewTransition(() => executeThemeToggle());
  } else {
    executeThemeToggle();
  }
}

function executeThemeToggle() {
  const isDark = document.documentElement.classList.toggle("dark");
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateMetaThemeColor(isDark);
}

function updateMetaThemeColor(isDark) {
  const metaTheme = document.getElementById("meta-theme-color");
  if (metaTheme) {
    metaTheme.setAttribute("content", isDark ? "#0f172a" : "#f8fafc");
  }
}

// ページロード時にダークモードを即座に適用（FOUC防止）
initDarkMode();

window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => {
    if (!localStorage.getItem("theme")) {
      const isDark = e.matches;
      document.documentElement.classList.toggle("dark", isDark);
      updateMetaThemeColor(isDark);
    }
  });

// --- 設定ドロップダウンメニュー管理 ---
window.toggleSettingsMenu = function (event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("settings-dropdown");
  if (menu) menu.classList.toggle("hidden");
};

window.closeSettingsMenu = function () {
  const menu = document.getElementById("settings-dropdown");
  if (menu && !menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
  }
};

document.addEventListener("click", (event) => {
  const menu = document.getElementById("settings-dropdown");
  const btn = document.getElementById("settings-menu-btn");
  if (menu && !menu.classList.contains("hidden") && btn && !menu.contains(event.target) && !btn.contains(event.target)) {
    window.closeSettingsMenu();
  }
});

// --- 設定保存用ユーティリティ (SQLiteベース) ---
function getDbSetting(key, defaultValue = null) {
  if (!db) return defaultValue;
  let stmt;
  try {
    stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([key]);
    if (stmt.step()) {
      return stmt.get()[0];
    }
  } catch (e) {
    console.error("Setting read error:", e);
  } finally {
    if (stmt) stmt.free();
  }
  return defaultValue;
}

function setDbSetting(key, value, markDirty = true) {
  if (!db) return;
  try {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
      key,
      value,
    ]);
    if (markDirty) setDirty(true);
  } catch (e) {
    console.error("Setting write error:", e);
  }
}

// --- 自動バックアップ (IndexedDB) ロジック ---
const DB_NAME = "GrindPeopleDB";
const STORE_NAME = "drafts";

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          idb.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.warn(
        "IndexedDBがブロックされています。ドラフト自動保存は無効化されます。",
      );
      reject(e);
    }
  });
}

async function saveDraft(uints) {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(uints, "latest_draft");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("Draft save failed", e);
  }
}

async function loadDraft() {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get("latest_draft");
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function clearDraft() {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete("latest_draft");
  } catch (e) {
    console.error("Draft clear failed", e);
  }
}

// 未保存状態（isDirty）のセットとUIバッジの更新
function setDirty(state) {
  isDirty = state;
  const badge = document.getElementById("dirty-badge");
  if (badge) {
    if (state) {
      badge.classList.remove("hidden");
      badge.classList.add("flex");
    } else {
      badge.classList.add("hidden");
      badge.classList.remove("flex");
    }
  }

  // タブのタイトルとファイル名バッジの反映
  const fileName =
    fileHandle && fileHandle.name ? fileHandle.name : "Unsaved.people";
  const titleBase = `${fileName} - People`;
  document.title = state ? `* ${titleBase}` : titleBase;
  const filenameBadge = document.getElementById("current-filename");
  if (filenameBadge) {
    filenameBadge.textContent = fileName;
    filenameBadge.classList.remove("hidden");
  }

  // 自動バックアップの実行 (10秒デバウンス: 入力が落ち着いたタイミングで実行し、db.export() によるタイピング中のフリーズを防止)
  if (state && db) {
    if (draftTimer) {
      clearTimeout(draftTimer);
    }
    draftTimer = setTimeout(async () => {
      try {
        if (!isDirty || isSaving) return; // 【追加】手動保存中 (isSaving) ならオートセーブを中止する

        let data = db.export();
        const password = document.getElementById("file-password").value;
        if (password) {
          data = await encryptData(data, password);
        }

        if (!isDirty) return; // 【追加】非同期処理中に手動保存された場合は破棄する

        await saveDraft(data);

        // 【Gold-Rank Polish】オートセーブ完了のマイクロインタラクション
        const badge = document.getElementById("dirty-badge");
        if (badge) {
          const dot = badge.querySelector("span");
          if (dot) {
            // 一瞬だけ緑色にして安心感を与える
            dot.classList.replace("bg-orange-500", "bg-green-400");
            dot.classList.replace(
              "shadow-[0_0_8px_var(--color-orange-500)]",
              "shadow-[0_0_8px_var(--color-green-400)]",
            );
            setTimeout(() => {
              // その後フワッと消す
              badge.classList.add("hidden");
              badge.classList.remove("flex");
              dot.classList.replace("bg-green-400", "bg-orange-500");
              dot.classList.replace(
                "shadow-[0_0_8px_var(--color-green-400)]",
                "shadow-[0_0_8px_var(--color-orange-500)]",
              );
            }, 800);
          }
        }
      } catch (e) {
        console.error("Draft save failed", e);
      } finally {
        draftTimer = null; // 保存完了後にタイマーを解放
      }
    }, 30000); // 10秒から30秒に延長し、タイピング中のブロッキングを軽減
  } else if (!state) {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    // clearDraft()は呼ばず、IndexedDBにスナップショットを残し続ける
  }
}

// --- 共通ユーティリティ ---
window.focusAndSelectAll = function (el) {
  if (!el) return;
  el.focus();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.select();
  } else if (
    typeof window.getSelection !== "undefined" &&
    typeof document.createRange !== "undefined"
  ) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
};

function escapeHtml(unsafe) {
  return (unsafe ?? "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// セキュアなパスワード入力プロンプト (Promiseラッパー)
function requestPasswordPrompt(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("password-prompt-modal");
    const msgEl = document.getElementById("password-prompt-message");
    const input = document.getElementById("password-prompt-input");
    const btnSubmit = document.getElementById("password-prompt-submit");
    const btnCancel = document.getElementById("password-prompt-cancel");

    msgEl.textContent = message;
    input.value = "";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    toggleMainUI(true);
    lockScroll();
    setTimeout(() => input.focus(), 100);

    const cleanup = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      // 他のモーダルやパレットが開いている場合は背景ロック解除をスキップ
      if (
        !isCommandPaletteOpen &&
        document.getElementById("csv-mapping-modal").classList.contains("hidden") &&
        document.getElementById("export-modal").classList.contains("hidden") &&
        document.getElementById("role-dict-editor-modal").classList.contains("hidden") &&
        document.getElementById("contact-detail-modal").classList.contains("hidden")
      ) {
        toggleMainUI(false);
        unlockScroll();
      }
      btnSubmit.removeEventListener("click", onSubmit);
      btnCancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeyDown);
    };
    const onSubmit = () => {
      const pwd = input.value;
      input.value = ""; // DOMからパスワードを消去
      cleanup();
      resolve(pwd);
    };
    const onCancel = () => {
      input.value = ""; // DOMからパスワードを消去
      cleanup();
      resolve(null);
    };
    const onKeyDown = (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        onSubmit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };

    btnSubmit.addEventListener("click", onSubmit);
    btnCancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeyDown);
  });
}

// セキュアな汎用プロンプト・確認・通知ダイアログ (ネイティブ prompt/confirm/alert の代替)
window.requestCustomPrompt = function (
  title,
  message,
  defaultValue = "",
  mode = "prompt",
) {
  return new Promise((resolve) => {
    const modal = document.getElementById("generic-dialog-modal");
    const titleEl = document.getElementById("generic-dialog-title");
    const msgEl = document.getElementById("generic-dialog-message");
    const input = document.getElementById("generic-dialog-input");
    const btnSubmit = document.getElementById("generic-dialog-submit");
    const btnCancel = document.getElementById("generic-dialog-cancel");

    titleEl.textContent = title;
    msgEl.innerHTML = escapeHtml(message).replace(/\n/g, "<br>");

    // モードに応じたUI切り替え
    if (mode === "prompt") {
      input.classList.remove("hidden");
      input.value = defaultValue;
      btnCancel.classList.remove("hidden");
    } else if (mode === "confirm") {
      input.classList.add("hidden");
      btnCancel.classList.remove("hidden");
    } else if (mode === "alert") {
      input.classList.add("hidden");
      btnCancel.classList.add("hidden"); // アラート時はキャンセルボタンを隠す
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");
    toggleMainUI(true);
    lockScroll();

    if (mode === "prompt") {
      setTimeout(() => {
        input.focus();
        input.select();
      }, 100);
    } else {
      setTimeout(() => btnSubmit.focus(), 100);
    }

    const cleanup = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      // 他のモーダルやパレットが開いている場合は背景ロック解除をスキップ
      if (
        !isCommandPaletteOpen &&
        document.getElementById("csv-mapping-modal").classList.contains("hidden") &&
        document.getElementById("export-modal").classList.contains("hidden") &&
        document.getElementById("role-dict-editor-modal").classList.contains("hidden") &&
        document.getElementById("contact-detail-modal").classList.contains("hidden")
      ) {
        toggleMainUI(false);
        unlockScroll();
      }
    };

    btnSubmit.onclick = () => {
      cleanup();
      resolve(mode === "prompt" ? input.value : true);
    };
    btnCancel.onclick = () => {
      cleanup();
      resolve(mode === "prompt" ? null : false);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        btnSubmit.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (mode !== "alert") btnCancel.click();
        else btnSubmit.click();
      }
    };
  });
};

function handlePlainTextPaste(event) {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData(
    "text/plain",
  );
  let cleanText = text.replace(/[\r\n\t]+/g, " ").trim();

  // 気を利かせて自動整形する (TEL: などのプレフィックスを除去)
  if (event.target.getAttribute("data-field") === "contact_info") {
    cleanText = cleanText
      .replace(/^(TEL|FAX|Email|Mail|E-mail|電話)[\s:：]*/i, "")
      .replace(/\s+/g, "");
  }

  let success = false;
  if (document.queryCommandSupported("insertText")) {
    success = document.execCommand("insertText", false, cleanText);
  }

  if (!success) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    selection.deleteFromDocument();

    const textNode = document.createTextNode(cleanText);
    const range = selection.getRangeAt(0);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    event.target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// --- 新機能: Smart Paste (署名スマート解析) ---
function handleSmartPaste(event) {
  const text = (event.clipboardData || window.clipboardData).getData(
    "text/plain",
  );
  if (!text || !text.includes("\n")) return; // 複数行でない場合は通常のペースト処理に任せる

  const emailMatch = text.match(
    /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/
  );
  // 電話番号の正規表現: 090-1234-5678, +81 90 1234 5678, 等に対応
  const phoneMatch = text.match(
    /(?:TEL|Phone|電話|Mobile|携帯)?(?:[\s:：]{0,5})(\+?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4})/i
  );

  if (emailMatch || phoneMatch) {
    event.preventDefault();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let name = lines[0] || "";
    let email = emailMatch ? emailMatch[1] : "";
    let phone = phoneMatch ? phoneMatch[1] : "";

    // 余計な記号を除去
    if (name.includes(":") || name.includes("：")) {
      name = name.split(/[:：]/)[1].trim();
    }

    let contactInfo = email;
    if (phone && !email) contactInfo = phone;
    else if (phone && email) contactInfo = `${email} / ${phone}`;

    // 役職や部署名を探すヒューリスティクス
    let role = "";
    const roleKeywords = [
      "部",
      "長",
      "課",
      "班",
      "代表",
      "役員",
      "CEO",
      "CTO",
      "Manager",
      "Director",
      "Lead",
    ];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line !== name && !line.includes(email) && !line.includes(phone)) {
        if (roleKeywords.some((kw) => line.includes(kw))) {
          role = line;
          break;
        }
      }
    }

    const form = event.target.closest("form");
    if (form) {
      const memoInput = form.querySelector(".item-memo");
      const contactInput = form.querySelector(".item-contact");
      const roleInput = form.querySelector(".item-role");

      if (memoInput) memoInput.value = name;
      if (contactInput) contactInput.value = contactInfo;
      if (roleInput && role && !roleInput.value) roleInput.value = role;

      setDirty(true);
      showToast(window._t("toast.smart_paste"), "✨");

      // ★ 解析完了後、連絡先欄へフォーカスを移し Enter で直ぐに登録できるようにする
      setTimeout(() => {
        if (contactInput) contactInput.focus();
      }, 10);
    }
  }
}

// --- 暗号化ロジック (Web Crypto API) ---
const MAGIC_BYTES = new TextEncoder().encode("GRINDEN2"); // 最新仕様 (60万回)
const MAGIC_BYTES_LEGACY = new TextEncoder().encode("GRINDENC"); // 過去仕様 (10万回)

async function deriveKey(password, salt, iterations = 600000) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptData(data, password) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  // 新規暗号化時はOWASP推奨の60万回を使用
  const key = await deriveKey(password, salt, 600000);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data,
  );

  const result = new Uint8Array(
    MAGIC_BYTES.length + salt.length + iv.length + encrypted.byteLength,
  );
  result.set(MAGIC_BYTES, 0);
  result.set(salt, MAGIC_BYTES.length);
  result.set(iv, MAGIC_BYTES.length + salt.length);
  result.set(
    new Uint8Array(encrypted),
    MAGIC_BYTES.length + salt.length + iv.length,
  );
  return result;
}

async function decryptData(encryptedData, password) {
  const magic = encryptedData.slice(0, 8);
  const magicStr = new TextDecoder().decode(magic);
  const isEncryptedV2 = magicStr === "GRINDEN2";
  const isEncryptedLegacy = magicStr === "GRINDENC";
  if (!isEncryptedV2 && !isEncryptedLegacy) return encryptedData; // 暗号化されていないファイルはそのまま返す

  const salt = encryptedData.slice(8, 24);
  const iv = encryptedData.slice(24, 36);
  const data = encryptedData.slice(36);

  try {
    if (isEncryptedV2) {
      const key = await deriveKey(password, salt, 600000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        data,
      );
      return new Uint8Array(decrypted);
    } else {
      // Legacy (10万回仕様)
      const legacyKey = await deriveKey(password, salt, 100000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        legacyKey,
        data,
      );
      return new Uint8Array(decrypted);
    }
  } catch (e) {
    throw new Error(window._t("error.decrypt_fail"));
  }
}
// --------------------------------------

// データベースの後方互換性（スキーマ移行）を担保する
function migrateDatabase() {
  if (!db) return;
  try {
    const res = db.exec("PRAGMA table_info(records)");

    // 安全対策: テーブル情報が取得できない場合はマイグレーションをスキップ
    if (!res || res.length === 0 || !res[0].values) {
      console.warn("Table info is missing or corrupted. Skipping migration.");
      return;
    }

    if (res.length > 0 && res[0].values) {
      const columns = res[0].values.map((col) => col[1]);
      if (!columns.includes("role")) {
        db.run("ALTER TABLE records ADD COLUMN role TEXT");
        setDirty(true);
      }
      if (!columns.includes("contact_info")) {
        db.run("ALTER TABLE records ADD COLUMN contact_info TEXT");
        setDirty(true);
      }
      if (!columns.includes("tags")) {
        db.run("ALTER TABLE records ADD COLUMN tags TEXT");
        setDirty(true);
      }
    }
    // テンプレート用テーブルの作成
    db.run(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        data TEXT
      );
    `);
    // 設定用テーブルの作成
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // ★ ユニバーサル連絡先フィールド用テーブル (EAV方式)
    db.run(`
      CREATE TABLE IF NOT EXISTS contact_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        field_key TEXT NOT NULL,
        field_value TEXT,
        field_type TEXT DEFAULT 'other',
        sort_order INTEGER DEFAULT 0,
        UNIQUE(record_id, field_key, field_type, sort_order)
      );
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_cf_record ON contact_fields(record_id)`,
    );
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_cf_key ON contact_fields(field_key)`,
    );

    // 既存データの contact_fields への自動マイグレーション
    try {
      const migrated = getDbSetting("contact_fields_migrated");
      if (!migrated) {
        db.run("BEGIN TRANSACTION;");
        let migrateStmt = null;
        let insertFieldStmt = null;
        try {
          migrateStmt = db.prepare(
            "SELECT id, memo, contact_info, role FROM records WHERE parent_id IS NOT NULL",
          );
          insertFieldStmt = db.prepare(
            "INSERT OR IGNORE INTO contact_fields (record_id, field_key, field_value, field_type, sort_order) VALUES (?, ?, ?, ?, ?)",
          );
          while (migrateStmt.step()) {
            const [id, memo, contactInfo, role] = migrateStmt.get();
            if (contactInfo && contactInfo.trim()) {
              const ci = contactInfo.trim();
              if (ci.includes("@")) {
                insertFieldStmt.run([id, "email", ci, "work", 0]);
              } else {
                insertFieldStmt.run([id, "phone", ci, "mobile", 0]);
              }
            }
            if (role && role.trim()) {
              insertFieldStmt.run([id, "job_title", role.trim(), "other", 0]);
            }
          }
          db.run("COMMIT;");
        } catch (e) {
          db.run("ROLLBACK;");
          throw e;
        } finally {
          if (migrateStmt) migrateStmt.free();
          if (insertFieldStmt) insertFieldStmt.free();
        }
        setDbSetting("contact_fields_migrated", "true");
      }
    } catch (e) {
      console.warn("contact_fields migration skipped", e);
    }

    // 🎯 Gold-Rank: 既存のlocalStorageからSQLiteへのシームレスな移行
    try {
      const keysToMigrate = ["customRoleDict", "roleDict"];
      let checkStmt, insertStmt;
      try {
        checkStmt = db.prepare("SELECT 1 FROM settings WHERE key = ?");
        insertStmt = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?)",
        );

        for (const key of keysToMigrate) {
          const oldVal = localStorage.getItem(key);
          if (oldVal !== null && oldVal !== undefined) {
            checkStmt.bind([key]);
            const exists = checkStmt.step();
            checkStmt.reset();

            if (!exists) {
              insertStmt.run([key, oldVal]);
              localStorage.removeItem(key); // 吸い上げ完了後、古いデータを消去
              setDirty(true);
            }
          }
        }
      } finally {
        if (checkStmt) checkStmt.free();
        if (insertStmt) insertStmt.free();
      }
    } catch (e) {
      console.warn("マイグレーションの実行をスキップしました", e);
    }
  } catch (e) {
    console.error("Migration error:", e);
  }
}

// --- ユニバーサル連絡先ハブ: プラットフォームマッピング定義 ---
const PLATFORM_MAPS = {
  google_csv: {
    "Given Name": { key: "given_name" },
    "Family Name": { key: "family_name" },
    "Additional Name": { key: "middle_name" },
    "Name Prefix": { key: "name_prefix" },
    "Name Suffix": { key: "name_suffix" },
    Nickname: { key: "nickname" },
    "Given Name Yomi": { key: "given_name_yomi" },
    "Family Name Yomi": { key: "family_name_yomi" },
    "Organization 1 - Name": { key: "company" },
    "Organization 1 - Department": { key: "department" },
    "Organization 1 - Title": { key: "job_title" },
    "E-mail 1 - Value": { key: "email", type: "work", order: 0 },
    "E-mail 2 - Value": { key: "email", type: "home", order: 1 },
    "E-mail 3 - Value": { key: "email", type: "other", order: 2 },
    "Phone 1 - Value": { key: "phone", type: "mobile", order: 0 },
    "Phone 2 - Value": { key: "phone", type: "work", order: 1 },
    "Phone 3 - Value": { key: "phone", type: "home", order: 2 },
    "Address 1 - Street": { key: "addr_street", type: "work" },
    "Address 1 - City": { key: "addr_city", type: "work" },
    "Address 1 - Region": { key: "addr_region", type: "work" },
    "Address 1 - Postal Code": { key: "addr_postal", type: "work" },
    "Address 1 - Country": { key: "addr_country", type: "work" },
    "Address 2 - Street": { key: "addr_street", type: "home" },
    "Address 2 - City": { key: "addr_city", type: "home" },
    "Address 2 - Region": { key: "addr_region", type: "home" },
    "Address 2 - Postal Code": { key: "addr_postal", type: "home" },
    "Address 2 - Country": { key: "addr_country", type: "home" },
    Birthday: { key: "birthday" },
    Notes: { key: "note" },
    "Website 1 - Value": { key: "url" },
  },
  outlook_csv: {
    "First Name": { key: "given_name" },
    "Last Name": { key: "family_name" },
    "Middle Name": { key: "middle_name" },
    Title: { key: "name_prefix" },
    Suffix: { key: "name_suffix" },
    Nickname: { key: "nickname" },
    Company: { key: "company" },
    Department: { key: "department" },
    "Job Title": { key: "job_title" },
    "E-mail Address": { key: "email", type: "work", order: 0 },
    "E-mail 2 Address": { key: "email", type: "home", order: 1 },
    "E-mail 3 Address": { key: "email", type: "other", order: 2 },
    "Mobile Phone": { key: "phone", type: "mobile", order: 0 },
    "Business Phone": { key: "phone", type: "work", order: 1 },
    "Home Phone": { key: "phone", type: "home", order: 2 },
    "Business Fax": { key: "phone", type: "fax_work", order: 3 },
    "Home Fax": { key: "phone", type: "fax_home", order: 4 },
    "Company Main Phone": { key: "phone", type: "main", order: 5 },
    "Business Street": { key: "addr_street", type: "work" },
    "Business City": { key: "addr_city", type: "work" },
    "Business State": { key: "addr_region", type: "work" },
    "Business Postal Code": { key: "addr_postal", type: "work" },
    "Business Country/Region": { key: "addr_country", type: "work" },
    "Home Street": { key: "addr_street", type: "home" },
    "Home City": { key: "addr_city", type: "home" },
    "Home State": { key: "addr_region", type: "home" },
    "Home Postal Code": { key: "addr_postal", type: "home" },
    "Home Country/Region": { key: "addr_country", type: "home" },
    Birthday: { key: "birthday" },
    Anniversary: { key: "anniversary" },
    Notes: { key: "note" },
    "Web Page": { key: "url" },
  },
};

// --- contact_fields CRUD ユーティリティ ---
function getContactFields(recordId) {
  if (!db) return [];
  const fields = [];
  let stmt;
  try {
    stmt = db.prepare(
      "SELECT id, field_key, field_value, field_type, sort_order FROM contact_fields WHERE record_id = ? ORDER BY sort_order ASC, id ASC",
    );
    stmt.bind([recordId]);
    while (stmt.step()) {
      const [fId, k, v, t, o] = stmt.get();
      fields.push({
        id: fId,
        field_key: k,
        field_value: v,
        field_type: t,
        sort_order: o,
      });
    }
  } catch (e) {
    console.error("getContactFields:", e);
  } finally {
    if (stmt) stmt.free();
  }
  return fields;
}

function setContactField(
  recordId,
  fieldKey,
  fieldValue,
  fieldType = "other",
  sortOrder = 0,
) {
  if (!db || !fieldValue?.trim()) return;
  try {
    db.run(
      "INSERT OR REPLACE INTO contact_fields (record_id, field_key, field_value, field_type, sort_order) VALUES (?, ?, ?, ?, ?)",
      [recordId, fieldKey, fieldValue.trim(), fieldType, sortOrder],
    );
  } catch (e) {
    console.error("setContactField:", e);
  }
}

function deleteContactFieldsForRecord(recordId) {
  if (!db) return;
  try {
    db.run("DELETE FROM contact_fields WHERE record_id = ?", [recordId]);
  } catch (e) {
    console.error("deleteContactFields:", e);
  }
}

function clearContactFieldsByKey(recordId, fieldKey) {
  if (!db) return;
  try {
    db.run("DELETE FROM contact_fields WHERE record_id = ? AND field_key = ?", [
      recordId,
      fieldKey,
    ]);
  } catch (e) {}
}

// vCardパーサー: vCardテキスト → レコード配列
function parseVCardText(text) {
  const contacts = [];
  const cards = text
    .split(/BEGIN:VCARD/i)
    .filter((c) => c.trim() !== "")
    .map((c) => "BEGIN:VCARD" + c);
  for (const card of cards) {
    if (!card.match(/BEGIN:VCARD/i)) continue;
    const contact = { fields: [], displayName: "", org: "" };

    // 💡 修正: フリーズ（Catastrophic Backtracking）を防ぐため、先にUnfold（行継続の結合）を行ってからシンプルな正規表現でパージする
    const unfolded = card.replace(/\r?\n[ \t]/g, "");
    const photoRemovedCard = unfolded.replace(/^PHOTO[^:]*:.*\r?\n?/gmi, "");
    const lines = photoRemovedCard.split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.match(/^(BEGIN|END|VERSION):/i)) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const left = line.substring(0, colonIdx);
      const value = line.substring(colonIdx + 1).trim();
      if (!value) continue;
      const parts = left.split(";");
      const propName = parts[0].toUpperCase();
      const params = parts.slice(1).map((p) => p.toUpperCase());
      const typeParam = params.find((p) => p.startsWith("TYPE="));
      const typeVal = typeParam
        ? typeParam.replace("TYPE=", "").toLowerCase().split(",")[0]
        : "other";
      switch (propName) {
        case "FN":
          contact.displayName = value;
          break;
        case "N": {
          const np = value.split(";");
          if (np[0])
            contact.fields.push({
              key: "family_name",
              value: np[0],
              type: "other",
            });
          if (np[1])
            contact.fields.push({
              key: "given_name",
              value: np[1],
              type: "other",
            });
          if (np[2])
            contact.fields.push({
              key: "middle_name",
              value: np[2],
              type: "other",
            });
          if (np[3])
            contact.fields.push({
              key: "name_prefix",
              value: np[3],
              type: "other",
            });
          if (np[4])
            contact.fields.push({
              key: "name_suffix",
              value: np[4],
              type: "other",
            });
          break;
        }
        case "NICKNAME":
          contact.fields.push({ key: "nickname", value, type: "other" });
          break;
        case "ORG": {
          const op = value.split(";");
          contact.org = op[0] || "";
          if (op[0])
            contact.fields.push({
              key: "company",
              value: op[0],
              type: "other",
            });
          if (op[1])
            contact.fields.push({
              key: "department",
              value: op[1],
              type: "other",
            });
          break;
        }
        case "TITLE":
          contact.fields.push({ key: "job_title", value, type: "other" });
          break;
        case "TEL": {
          let pt = "other";
          const tl = params.join(",").toLowerCase();
          if (tl.includes("cell") || tl.includes("mobile")) pt = "mobile";
          else if (tl.includes("work")) pt = "work";
          else if (tl.includes("home")) pt = "home";
          else if (tl.includes("fax"))
            pt = tl.includes("work") ? "fax_work" : "fax_home";
          contact.fields.push({ key: "phone", value, type: pt });
          break;
        }
        case "EMAIL": {
          let et = "other";
          const el = params.join(",").toLowerCase();
          if (el.includes("work")) et = "work";
          else if (el.includes("home")) et = "home";
          contact.fields.push({ key: "email", value, type: et });
          break;
        }
        case "ADR": {
          const ap = value.split(";");
          const at = typeVal === "other" ? "home" : typeVal;
          if (ap[2])
            contact.fields.push({ key: "addr_street", value: ap[2], type: at });
          if (ap[3])
            contact.fields.push({ key: "addr_city", value: ap[3], type: at });
          if (ap[4])
            contact.fields.push({ key: "addr_region", value: ap[4], type: at });
          if (ap[5])
            contact.fields.push({ key: "addr_postal", value: ap[5], type: at });
          if (ap[6])
            contact.fields.push({
              key: "addr_country",
              value: ap[6],
              type: at,
            });
          break;
        }
        case "BDAY": {
          let bday = value;
          if (bday.length === 8 && /^\d{8}$/.test(bday)) {
            bday = `${bday.substring(0,4)}-${bday.substring(4,6)}-${bday.substring(6,8)}`;
          }
          contact.fields.push({ key: "birthday", value: bday, type: "other" });
          break;
        }
        case "NOTE": {
          const unescapedNote = value
            .replace(/\\n/gi, "\n")
            .replace(/\\,/g, ",");
          contact.fields.push({
            key: "note",
            value: unescapedNote,
            type: "other",
          });
          break;
        }
        case "URL":
          contact.fields.push({ key: "url", value, type: typeVal });
          break;
        case "X-PHONETIC-LAST-NAME":
          contact.fields.push({
            key: "family_name_yomi",
            value,
            type: "other",
          });
          break;
        case "X-PHONETIC-FIRST-NAME":
          contact.fields.push({ key: "given_name_yomi", value, type: "other" });
          break;
        case "X-SOCIALPROFILE": {
          const st = params.join(",").toLowerCase();
          if (st.includes("twitter") || st.includes("x"))
            contact.fields.push({ key: "social_x", value, type: "other" });
          else if (st.includes("facebook"))
            contact.fields.push({
              key: "social_facebook",
              value,
              type: "other",
            });
          else if (st.includes("instagram"))
            contact.fields.push({
              key: "social_instagram",
              value,
              type: "other",
            });
          else if (st.includes("line"))
            contact.fields.push({ key: "social_line", value, type: "other" });
          else contact.fields.push({ key: "url", value, type: "social" });
          break;
        }
      }
    }

    if (!contact.displayName) {
      const fName =
        contact.fields.find((f) => f.key === "family_name")?.value || "";
      const gName =
        contact.fields.find((f) => f.key === "given_name")?.value || "";
      contact.displayName = `${fName} ${gName}`.replace(/\s+/g, " ").trim();
    }

    if (contact.displayName || contact.fields.length > 0)
      contacts.push(contact);
  }
  return contacts;
}

// vCardインポート実行
async function importVCardFile(file) {
  if (!file) return;

  // Block files larger than 50MB to prevent out-of-memory (OOM) crashes
  if (file.size > 52428800) {
    await window.requestCustomPrompt(
      window._t("error.fatal_title"),
      window._t("error.file_too_large_50"),
      "",
      "alert",
    );
    return;
  }

  // ファイルサイズの安全装置 (20MBに変更し、顔写真付きvCardの誤爆を回避)
  if (file.size > 20971520) {
    const isConfirmed = await window.requestCustomPrompt(
      window._t("error.warning_title"),
      window._t("error.file_too_large_20"),
      "",
      "confirm",
    );
    if (!isConfirmed) {
      return;
    }
  }
  if (!db) return;
  const buffer = await file.arrayBuffer();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (e) {
    text = new TextDecoder("shift_jis").decode(buffer);
  }
  const contacts = parseVCardText(text);
  if (contacts.length === 0) {
    showToast(window._t("error.vcard_parse"), "⚠️", "error");
    return;
  }
  const isConfirmed = await window.requestCustomPrompt(
    window._t("confirm.import_vcard_title"),
    window._t("confirm.import_vcard_desc", contacts.length),
    "",
    "confirm",
  );
  if (!isConfirmed) return;

  db.run("BEGIN TRANSACTION;");
  let checkStmt = null;
  try {
    checkStmt = db.prepare(
      "SELECT 1 FROM records WHERE memo = ? AND IFNULL(contact_info, '') = IFNULL(?, '') LIMIT 1",
    );
    // 組織ごとにグループ化
    const orgMap = new Map();
    contacts.forEach((c) => {
      const org = c.org || window._t("label.vcard_import");
      // 比較キー: 全角半角スペースを削除し、NFKC正規化と小文字化を行うことで揺らぎを吸収
      const orgKey = org
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s　]+/g, "");
      if (!orgMap.has(orgKey)) {
        orgMap.set(orgKey, { displayName: org, members: [] });
      }
      orgMap.get(orgKey).members.push(c);
    });

    for (const [orgKey, data] of orgMap) {
      const orgName = data.displayName;
      const members = data.members;
      db.run("INSERT INTO records (memo, contact_info) VALUES (?, ?)", [
        orgName,
        null,
      ]);
      const pRes = db.exec("SELECT last_insert_rowid()");
      const parentId = pRes[0]?.values?.[0]?.[0];
      if (!parentId) throw new Error("親IDの取得に失敗しました");

      for (const contact of members) {
        const name = contact.displayName || "";
        const phoneField = contact.fields.find((f) => f.key === "phone");
        const emailField = contact.fields.find((f) => f.key === "email");
        const titleField = contact.fields.find((f) => f.key === "job_title");
        const contactInfo = emailField?.value || phoneField?.value || null;
        const role = titleField?.value || null;

        // 重複チェック
        checkStmt.bind([name, contactInfo]);
        if (checkStmt.step()) {
          checkStmt.reset();
          continue; // 重複しているのでスキップ
        }
        checkStmt.reset();

        db.run(
          "INSERT INTO records (parent_id, memo, contact_info, role) VALUES (?, ?, ?, ?)",
          [parentId, name, contactInfo, role],
        );
        const cRes = db.exec("SELECT last_insert_rowid()");
        const childId = cRes[0]?.values?.[0]?.[0];
        if (!childId) throw new Error("子IDの取得に失敗しました");

        // contact_fields に全フィールドを保存
        const counters = {};
        for (const f of contact.fields) {
          const counterKey = f.key;
          counters[counterKey] = counters[counterKey] || 0;
          setContactField(
            childId,
            f.key,
            f.value,
            f.type,
            counters[counterKey],
          );
          counters[counterKey]++;
        }
      }
      collapsedBlocks.add(parentId);
    }
    db.run("COMMIT;");
    setDirty(true);
    currentActiveTag = null;
    showToast(
      window._t("toast.import", contacts.length),
      '<span class="text-green-400">✨</span>',
    );
  } catch (err) {
    db.run("ROLLBACK;");
    showToast(window._t("error.vcard_import"), "⚠️", "error");
    console.error(err);
  } finally {
    if (checkStmt) checkStmt.free();
  }
  renderData();
}

// 1. WebAssembly版 SQLiteエンジンの初期化
async function initSQLite() {
  try {
    if (typeof initSqlJs === "undefined") {
      throw new Error(
        window._t("error.sqljs_missing"),
      );
    }

    const config = {
      locateFile: (filename) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}`,
    };
    SQL = await initSqlJs(config);

    let initialData = null;
    const draft = await loadDraft();
    if (draft) {
      const isConfirmed = await window.requestCustomPrompt(
        window._t("confirm.restore_draft_title"),
        window._t("confirm.restore_draft_desc"),
        "",
        "confirm",
      );
      if (isConfirmed) {
        initialData = draft;
        let Uints = draft;
        const magic = Uints.slice(0, 8);
        const magicStr = new TextDecoder().decode(magic);
        const isEncrypted = magicStr === "GRINDENC" || magicStr === "GRINDEN2";

        if (isEncrypted) {
          let password = document.getElementById("file-password").value;
          let success = false;
          let attempt = 0;
          while (!success) {
            try {
              Uints = await decryptData(Uints, password);
              success = true;
              if (password) {
                document.getElementById("file-password").value = password;
                lastSavedPasswordHash = await sha256(password);
              }
            } catch (err) {
              const msg =
                attempt > 0
                  ? window._t("prompt.pw_wrong")
                  : window._t("prompt.pw_backup");
              password = await requestPasswordPrompt(msg);
              if (password === null) {
                await window.requestCustomPrompt(
                  window._t("alert.cancel_startup_title"),
                  window._t("alert.cancel_startup_desc"),
                  "",
                  "alert",
                );
                document.getElementById("app-ui")?.classList.add("hidden");
                const errorScreen =
                  document.getElementById("fatal-error-screen");
                if (errorScreen) {
                  errorScreen.querySelector("h2").textContent = window._t("error.security_stop_title");
                  errorScreen.querySelector("p").innerHTML = window._t("error.security_stop_desc");
                  errorScreen.classList.remove("hidden");
                  errorScreen.classList.add("flex");
                }
                throw new Error("User canceled decryption");
              }
              attempt++;
            }
          }
        }
        initialData = Uints;
      } else {
        await clearDraft();
      }
    }

    if (initialData) {
      try {
        db = new SQL.Database(initialData);
        migrateDatabase();
        setDirty(true);

        showToast(
          window._t("toast.restored"),
          '<span class="text-orange-400">↺</span>',
        );
      } catch (dbError) {
        console.error("ドラフトの復元に失敗しました。", dbError);
        await window.requestCustomPrompt(
          window._t("error.fatal_title"),
          window._t("error.draft_corrupted"),
          "",
          "alert",
        );
        await clearDraft();
        db = new SQL.Database();
        db.run(`
          CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            memo TEXT,
            contact_info TEXT,
            role TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sort_order INTEGER DEFAULT 0,
            tags TEXT
          );
        `);
        migrateDatabase();
      }
    } else {
      db = new SQL.Database();
      db.run(`
        CREATE TABLE IF NOT EXISTS records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER,
          memo TEXT,
          contact_info TEXT,
          role TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          sort_order INTEGER DEFAULT 0,
          tags TEXT
        );
      `);
      migrateDatabase();
      showToast(window._t("toast.sqlite_ready"), '<span class="text-green-400">●</span>');
    }

    // SQLiteエンジンのローディング表示を消す
    hideStatus();

    // DB内の設定を読み込んでUIに反映
    loadSettingsFromDb();

    document.getElementById("app-ui").classList.remove("hidden");

    renderData();

    // PWAとしてOSからファイルがダブルクリックされた場合の処理
    handleLaunchFiles();
  } catch (err) {
    showToast(window._t("error.sqlite_fail"), "<span>⚠️</span>", "error");
    console.error(err);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.style.display = "none";
    const errorScreen = document.getElementById("fatal-error-screen");
    if (errorScreen) {
      const errorMsgEl = errorScreen.querySelector("p");
      if (errorMsgEl)
        errorMsgEl.innerHTML = window._t("error.sqlite_fatal", `<span class="text-xs text-red-500 font-mono bg-red-50 dark:bg-red-900/30 p-2 rounded inline-block text-left overflow-auto max-h-32 my-2 border border-red-200 dark:border-red-800">${escapeHtml(err.message || err.toString())}</span>`);
      errorScreen.classList.remove("hidden");
      errorScreen.classList.add("flex");
    }
    // エラー時もローディング表示を消す
    hideStatus();
  }
}

// OS上で .people ファイルがダブルクリックされた時の処理 (File Handling API)
function handleLaunchFiles() {
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;

      if (isDirty) {
        const isConfirmed = await window.requestCustomPrompt(
          window._t("confirm.title"),
          window._t("confirm.discard_changes"),
          "",
          "confirm",
        );
        if (!isConfirmed) {
          return;
        }
      }

      const handle = launchParams.files[0];
      if (handle.name.endsWith(".vcf")) {
        const file = await handle.getFile();
        await importVCardFile(file);
      } else if (handle.name.endsWith(".csv")) {
        const file = await handle.getFile();
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const csvInput = document.getElementById("csv-input");
        if (csvInput) {
          csvInput.files = dataTransfer.files;
          csvInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        await processFileHandle(handle);
      }
    });
  }
}

// ステータス表示を数秒後に消す関数
function hideStatus() {
  if (statusTimeoutId) clearTimeout(statusTimeoutId);

  statusTimeoutId = setTimeout(() => {
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.classList.remove("opacity-100", "translate-y-0");
      statusEl.classList.add("opacity-0", "-translate-y-4");
      statusEl.style.pointerEvents = "none";
    }
  }, 3000);
}

// トースト通知を表示するヘルパー関数 (スタック対応)
function showToast(message, iconHtml = "✅", type = "normal") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    container.className =
      "fixed bottom-10 sm:bottom-12 inset-x-0 z-[9999] flex flex-col-reverse items-center gap-2 pointer-events-none px-4 pb-[env(safe-area-inset-bottom)]";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");

  const bgClass =
    type === "error"
      ? "bg-red-500/90 border-red-600/50"
      : type === "warning"
        ? "bg-red-900/90 border-red-700/50"
        : "bg-slate-800/90 border-slate-700/50";

  toast.innerHTML = `${iconHtml} <span class="break-all line-clamp-2">${message}</span>`;
  toast.className = `backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border transition-all duration-300 flex items-center gap-2 animate-toast-in ${bgClass}`;

  container.appendChild(toast);

  // 画面が埋まるのを防ぐため、最大表示数を3個に制限
  while (container.childElementCount > 3) {
    container.firstChild.remove();
  }

  setTimeout(() => {
    toast.classList.replace("animate-toast-in", "animate-toast-out");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// 2. ブロックまたはアイテムの追加
function addBlock() {
  const memoInput = document.getElementById("new-block-memo");
  const trimmedMemo = memoInput.value.trim();
  if (!trimmedMemo) return;

  let defaultTag = null;
  if (currentActiveTag) {
    defaultTag = currentActiveTag.replace(/^[#＃]/, ""); // #を除去して保存
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const sec = String(now.getSeconds()).padStart(2, "0");
  const localTime = `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;

  db.run(
    "INSERT INTO records (memo, contact_info, tags, created_at) VALUES (?, ?, ?, ?)",
    [trimmedMemo, null, defaultTag, localTime],
  );
  const res = db.exec("SELECT last_insert_rowid()");
  const newId = res[0]?.values?.[0]?.[0];

  if (!newId) {
    console.error("IDの取得に失敗しました");
    return;
  }

  memoInput.value = "";
  setDirty(true);
  renderData(newId);
}

function addItem(parentId, memo, contactInfo, dateStr, roleStr) {
  const safeMemo = (memo || "").trim();
  if (!safeMemo && !contactInfo) return;

  if (dateStr) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (dateStr > todayStr) {
      showToast(
        window._t("toast.future_date"),
        '<span class="text-orange-400">⚠️</span>',
        "warning",
      );
    }
  }

  let defaultTag = null;
  if (currentActiveTag) {
    defaultTag = currentActiveTag.replace(/^[#＃]/, "");
  }

  insertRecord(parentId, safeMemo, contactInfo, dateStr, roleStr, defaultTag);

  renderData(parentId);
}

function insertRecord(
  parentId,
  memo,
  contactInfo,
  dateStr = null,
  roleStr = null,
  tags = null,
) {
  let nextSortOrder = 0;
  if (parentId) {
    try {
      const orderStmt = db.prepare("SELECT IFNULL(MAX(sort_order), -1) + 1 FROM records WHERE parent_id = ?");
      orderStmt.bind([parentId]);
      if (orderStmt.step()) nextSortOrder = orderStmt.get()[0];
      orderStmt.free();
    } catch (e) {}
  }

  let query =
    "INSERT INTO records (parent_id, memo, contact_info, role, tags, sort_order) VALUES (?, ?, ?, ?, ?, ?)";
  let params = [parentId, memo, contactInfo, roleStr, tags, nextSortOrder];

  if (dateStr) {
    // タイムゾーンによるバグを回避するため、入力された日付を文字列のまま保存する
    query =
      "INSERT INTO records (parent_id, memo, contact_info, role, tags, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
    params.push(dateStr + " 00:00:00");
  } else {
    // SQLiteのCURRENT_TIMESTAMP(UTC)による9時間ズレを防ぐため、JS側でローカル時間を記録
    query =
      "INSERT INTO records (parent_id, memo, contact_info, role, tags, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const sec = String(now.getSeconds()).padStart(2, "0");
    params.push(`${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`);
  }

  let stmt;
  try {
    stmt = db.prepare(query);
    stmt.run(params);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
}

// 【新機能 1】 過去のメモ履歴を抽出して Datalist に登録する
function renderMemoSuggestions() {
  if (!db) return;
  const datalist = document.getElementById("memo-suggestions");
  if (!datalist) return;

  try {
    // 親ブロックではない(parent_id IS NOT NULL)過去のメモを重複排除して直近使った順に取得
    // SQLiteでの安全な書き方(GROUP BY + MAX)を採用
    const res = db.exec(
      "SELECT memo FROM records WHERE parent_id IS NOT NULL AND memo != '' GROUP BY memo ORDER BY MAX(id) DESC",
    );
    datalist.innerHTML = "";
    if (res.length > 0) {
      res[0].values.forEach(([memo]) => {
        const option = document.createElement("option");
        option.value = memo;
        datalist.appendChild(option);
      });
    }
  } catch (e) {
    console.error("Failed to render memo suggestions:", e);
  }
}

// 【新機能 2】 入力されたメモから、過去の科目を自動推論して埋める
function autoSuggestRole(memoInput) {
  if (!db) return;
  const memo = memoInput.value.trim();
  if (!memo) return;

  const form = memoInput.closest("form");
  const roleInput = form.querySelector(".item-role");

  // すでにユーザーが役割を手入力している場合は、上書きせずに尊重する
  if (roleInput.value.trim() !== "") return;

  let stmt;
  try {
    // 過去の明細から「同じメモ」で使われた最新の「役職」を1件だけ検索
    stmt = db.prepare(
      "SELECT role FROM records WHERE parent_id IS NOT NULL AND memo = ? AND role IS NOT NULL AND role != '' ORDER BY id DESC LIMIT 1",
    );
    stmt.bind([memo]);

    if (stmt.step()) {
      const role = stmt.get()[0];
      if (role) {
        roleInput.value = role; // 役割を自動入力

        // （おまけ）自動入力されたことがユーザーに伝わるよう、一瞬だけ色を変えるマイクロインタラクション
        roleInput.classList.add(
          "!bg-purple-100",
          "!text-purple-700",
          "transition-colors",
        );
        setTimeout(
          () =>
            roleInput.classList.remove("!bg-purple-100", "!text-purple-700"),
          1000,
        );
      }
    }
  } catch (e) {
    console.error("Auto suggest role failed:", e);
  } finally {
    if (stmt) stmt.free();
  }
}

// --- インプレース編集機能 ---
function updateRecord(id, field, newValue, element) {
  if (!db) return;

  // ホワイトリストによるSQLインジェクション対策
  const allowedFields = ["contact_info", "memo", "role", "created_at", "tags"];
  if (!allowedFields.includes(field)) {
    console.error("Invalid field name");
    return;
  }

  // ★ 安全に文字列化（null/undefined フォールバック付き）してからサニタイズ
  let val = String(newValue ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (field === "contact_info" && val === "") {
    val = null;
  }

  if (field === "memo") {
    // 氏名を直接編集した場合は、裏側にある古い姓名データをリセットし、整合性を保つ
    clearContactFieldsByKey(id, "family_name");
    clearContactFieldsByKey(id, "given_name");
    clearContactFieldsByKey(id, "middle_name");
    clearContactFieldsByKey(id, "name_prefix");
    clearContactFieldsByKey(id, "name_suffix");
  }

  // 変更があるかチェック (内容が変わっていない場合は何もしない)
  let oldValForEAV = null;
  let checkStmt;
  try {
    checkStmt = db.prepare(`SELECT ${field} FROM records WHERE id = ?`);
    checkStmt.bind([id]);
    if (checkStmt.step()) {
      const currentVal = checkStmt.get()[0];
      if (currentVal == val) {
        // 型の違い（"100"と100など）を許容するため == を使用
        return; // 変更なし
      }
      oldValForEAV = currentVal; // 💡 変更前の値を安全に退避しておく
    }
  } finally {
    if (checkStmt) checkStmt.free();
  }

  let stmt;
  try {
    stmt = db.prepare(`UPDATE records SET ${field} = ? WHERE id = ?`);
    stmt.run([val, id]);
  } finally {
    if (stmt) stmt.free();
  }

  // EAVテーブル (contact_fields) との完全同期
  if (field === "role") {
    clearContactFieldsByKey(id, "job_title");
    if (val) setContactField(id, "job_title", val, "other", 0);
  } else if (field === "contact_info") {
    // 💡 修正: もう片方の連絡先を巻き添えで消さないよう、退避済みの変更前の値からタイプを特定する
    const oldVal = oldValForEAV;
    const oldType = (oldVal && oldVal.includes("@")) ? "email" : "phone";

    if (val) {
      const newType = val.includes("@") ? "email" : "phone";
      const subType = val.includes("@") ? "work" : "mobile";

      if (oldVal) {
        db.run("DELETE FROM contact_fields WHERE record_id = ? AND field_key = ? AND sort_order = 0", [id, oldType]);
      }
      db.run("DELETE FROM contact_fields WHERE record_id = ? AND field_key = ? AND sort_order = 0", [id, newType]);

      setContactField(id, newType, val, subType, 0);
    } else {
      if (oldVal) {
        db.run("DELETE FROM contact_fields WHERE record_id = ? AND field_key = ? AND sort_order = 0", [id, oldType]);
      }
    }
  }

  // ★ ゴースト行（氏名・連絡先・役割がすべて空の明細）の自動クリーンアップ
  let checkGhostStmt;
  try {
    checkGhostStmt = db.prepare(
      "SELECT parent_id, memo, contact_info, role FROM records WHERE id = ?",
    );
    checkGhostStmt.bind([id]);
    if (checkGhostStmt.step()) {
      const [pId, m, cInfo, r] = checkGhostStmt.get();
      if (
        pId !== null &&
        (!m || m.trim() === "") &&
        (!cInfo || cInfo.trim() === "") &&
        (!r || r.trim() === "")
      ) {
        // 💡 修正: 裏側に詳細データ（住所・メモなど）が存在しないか確認し、存在すれば削除をスキップする
        let hasDetails = false;
        try {
          const detailStmt = db.prepare("SELECT 1 FROM contact_fields WHERE record_id = ? LIMIT 1");
          detailStmt.bind([id]);
          if (detailStmt.step()) hasDetails = true;
          detailStmt.free();
        } catch (e) {}

        if (!hasDetails) {
          // 非同期に逃がすことで、現在のblurイベントやフォーカス移動を安全に完了させ、その後フォーカスを復元する
          setTimeout(async () => {
            const parentIdForFocus = pId;
            await deleteRecord(id, true);

            // 削除された行ではなく、そのブロックの新規追加欄にフォーカスを移す
            requestAnimationFrame(() => {
              const newFocusTarget = document.querySelector(`#block-form-${parentIdForFocus} .item-memo`);
              if (newFocusTarget) {
                newFocusTarget.focus();
              }
            });
          }, 10);
          return;
        }
      }
    }
  } catch (e) {
  } finally {
    if (checkGhostStmt) checkGhostStmt.free();
  }

  setDirty(true);

  // Tabキー等によるフォーカス移動を追跡して復元するマジック
  const activeEl = document.activeElement;
  let focusSelector = null;

  if (activeEl) {
    if (
      typeof activeEl.hasAttribute === "function" &&
      activeEl.hasAttribute("data-field") &&
      activeEl.hasAttribute("data-id")
    ) {
      const field = activeEl.getAttribute("data-field");
      const id = activeEl.getAttribute("data-id");
      focusSelector = `[data-id="${id}"][data-field="${field}"]`;
    } else if (activeEl.classList.contains("item-memo")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains("item-contact")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-contact`;
    } else if (
      activeEl.hasAttribute("data-field") &&
      activeEl.getAttribute("data-field") === "role"
    ) {
      const id = activeEl.getAttribute("data-id");
      focusSelector = `input[data-id="${id}"][data-field="role"]`;
    } else if (
      activeEl.hasAttribute("data-field") &&
      activeEl.getAttribute("data-field") === "tags"
    ) {
      const id = activeEl.getAttribute("data-id");
      focusSelector = `input[data-id="${id}"][data-field="tags"]`;
    } else if (activeEl.classList.contains("item-role")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-role`;
    }
  }

  // ★ 連絡先や日付が変更された場合のみ再計算・再描画
  if (field === "contact_info") {
    if (element) {
      element.innerText = val !== null ? val : "";
    }
  } else if (field === "tags" || (field === "memo" && /[#＃]/.test(val))) {
    // タグが変更されたらUIを即時反映させるため再描画
    // 他ボタンのクリックイベントを阻害しないよう、再描画を遅延させる
    setTimeout(() => {
      // 別の入力欄にフォーカスが移っている場合は再描画をスキップし、入力を邪魔しない
      const activeEl = document.activeElement;
      const isTypingElsewhere =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.hasAttribute("contenteditable"));

      // ★ 入力中でない場合のみ即時再描画 (タイピング中のDOM再構築を防止し競合を回避)
      if (!isTypingElsewhere) {
        renderData();
        if (focusSelector) {
          requestAnimationFrame(() => {
            try {
              const target = document.querySelector(focusSelector);
              if (target) {
                target.focus();
                if (
                  typeof target.setSelectionRange === "function" &&
                  target.value !== undefined
                ) {
                  const len = target.value.length;
                  target.setSelectionRange(len, len);
                } else if (target.hasAttribute("contenteditable")) {
                  const range = document.createRange();
                  const sel = window.getSelection();
                  range.selectNodeContents(target);
                  range.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }
            } catch (e) {}
          });
        }
      } else {
        updateTagUIOnly();
      }
    }, 100);
  } else {
    // メモや役割の変更は、すでに画面上の文字（innerText / value）が書き換わっているため、
    // DBへの保存(UPDATE)と setDirty(true) だけで十分。DOMの再構築はスキップし、超速タイピングを邪魔しない。
    if (field === "memo" && element && element.tagName === "H2") {
      const tocItem = document.querySelector(`.toc-item[href="#block-${id}"]`);
      if (tocItem) {
        // 💡 修正: ハードコーディングを排除し、i18n翻訳システムを使用
        tocItem.textContent = val || window._t("label.unnamed");
        tocItem.title = val || window._t("label.unnamed");
      }
    }
  }

  // ★ DOMのテキストが完全に空になった場合、ゴミタグを消し去って empty 疑似クラスを効かせる
  if ((field === "memo" || field === "contact_info") && element) {
    if (val === "" || val === null) {
      element.innerHTML = "";
    }
  }
}

// --- タグUIのみを再計算して更新する (タイピング阻害防止用) ---
function updateTagUIOnly() {
  if (!db) return;
  const res = db.exec("SELECT id, parent_id, memo, tags FROM records ORDER BY sort_order ASC, id ASC");
  let records = [];
  if (res.length > 0 && res[0].values) {
    records = res[0].values.map(([id, parent_id, memo, tags]) => ({
      id, parent_id, memo, tags, children: []
    }));
  }
  const recordMap = records.reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
  const tree = [];
  records.forEach((record) => {
    if (record.parent_id && recordMap[record.parent_id]) recordMap[record.parent_id].children.push(record);
    else tree.push(record);
  });

  let tagTotals = Object.create(null);
  tree.forEach((block) => {
    const blockTagsField = (block.tags || "").split(/[,、\s]+/).map(t => t.trim()).filter(Boolean).map(t => t.startsWith("#") || t.startsWith("＃") ? t : "#" + t);
    const blockMemoTags = (block.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
    const combinedBlockTags = [...blockMemoTags, ...blockTagsField];

    if (block.children.length === 0) {
      const rawTags = [...combinedBlockTags].map((t) => t.replace("＃", "#"));
      const allTags = [...new Set(rawTags)];
      allTags.forEach((tag) => {
        if (!tagTotals[tag]) tagTotals[tag] = { count: 0, items: [] };
      });
    } else {
      block.children.forEach((item) => {
        const itemMemoTags = (item.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
        const itemTagsField = (item.tags || "").split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith("#") || t.startsWith("＃") ? t : "#" + t));
        const rawTags = [...itemMemoTags, ...itemTagsField, ...combinedBlockTags].map((t) => t.replace("＃", "#"));
        const allTags = [...new Set(rawTags)];

        allTags.forEach((tag) => {
          if (!tagTotals[tag]) tagTotals[tag] = { count: 0, items: [] };
          tagTotals[tag].count += 1;
        });
      });
    }
  });

  updateCategoryFiltersUI(tagTotals);

  const tagDatalist = document.getElementById("tag-suggestions");
  if (tagDatalist) {
    tagDatalist.innerHTML = "";
    Object.keys(tagTotals).forEach((tag) => {
      const option = document.createElement("option");
      option.value = tag.replace(/^[#＃]/, "");
      tagDatalist.appendChild(option);
    });
  }
}

// ハッカー的カウントアップ演出
function animateTotal(newTotal) {
  const el = document.getElementById("grand-total-num");
  if (!el) return;

  // 既に実行中のアニメーションがあればキャンセル（描画の暴走・CPUスパイク防止）
  if (totalAnimationId !== null) {
    cancelAnimationFrame(totalAnimationId);
  }

  const start = currentDisplayedTotal;
  const duration = 500;
  const startTime = performance.now();

  function update(currentTime) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = Math.floor(start + (newTotal - start) * ease);
    el.textContent = current.toLocaleString("ja-JP");
    currentDisplayedTotal = current;
    if (progress < 1) {
      totalAnimationId = requestAnimationFrame(update);
    } else {
      el.textContent = newTotal.toLocaleString("ja-JP");
      currentDisplayedTotal = newTotal;
      totalAnimationId = null; // 完了時にリセット
    }
  }
  totalAnimationId = requestAnimationFrame(update);
}

// ブロックの折りたたみ（アコーディオン）切り替え
function toggleBlock(id) {
  if (collapsedBlocks.has(id)) {
    collapsedBlocks.delete(id);
  } else {
    collapsedBlocks.add(id);
  }
  const bodyEl = document.getElementById(`block-body-${id}`);
  const iconEl = document.getElementById(`block-icon-${id}`);
  if (bodyEl && iconEl) {
    if (collapsedBlocks.has(id)) {
      bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
      bodyEl.offsetHeight; // リフローを強制してトランジションを有効化する
      bodyEl.style.maxHeight = "0px";
      bodyEl.style.opacity = "0";
      iconEl.style.transform = "rotate(-90deg)";
    } else {
      bodyEl.style.maxHeight = bodyEl.scrollHeight + 500 + "px";
      bodyEl.style.opacity = "1";
      iconEl.style.transform = "rotate(0deg)";
      setTimeout(() => {
        if (!collapsedBlocks.has(id)) {
          bodyEl.style.maxHeight = "99999px";
        }
      }, 300);
    }
  }
}

// --- すべて展開 / すべて折りたたみ ---
function toggleAllBlocks(collapse) {
  if (!db) return;

  if (collapse) {
    // DBから全ての親ブロックIDを取得し、確実に全て折りたたむ
    let stmt;
    try {
      stmt = db.prepare("SELECT id FROM records WHERE parent_id IS NULL");
      while (stmt.step()) {
        collapsedBlocks.add(stmt.get()[0]);
      }
    } finally {
      if (stmt) stmt.free();
    }
  } else {
    // セットを空にして全展開
    collapsedBlocks.clear();
  }

  // ✅ View Transition API を使って、滑らかに一斉開閉させる
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// --- カテゴリ（タグ）フィルター制御 ---
function setCategoryFilter(tag) {
  currentActiveTag = tag;

  // フィルター適用時にスクロール位置をトップに戻し、迷子を防ぐ
  window.scrollTo({ top: 0, behavior: "instant" });

  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

function updateCategoryFiltersUI(tagTotals) {
  const container = document.getElementById("category-filters");
  if (!container) return;

  // スクロール位置を記憶
  const currentScrollLeft = container.scrollLeft;

  container.innerHTML = ""; // 既存の中身をクリア

  // 「すべて表示」ボタンの生成
  const allBtn = document.createElement("button");
  allBtn.id = "filter-btn-all";
  allBtn.textContent = window._t("filter.all");
  allBtn.className =
    currentActiveTag === null
      ? "snap-start px-4 py-1.5 rounded-full text-xs font-bold transition-colors shadow-sm shrink-0 bg-slate-800 text-white border border-slate-800 dark:bg-white dark:text-slate-900"
      : "snap-start px-4 py-1.5 rounded-full text-xs font-bold transition-colors shadow-sm shrink-0 bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 dark:bg-dark-surface dark:text-slate-300 dark:border-dark-border dark:hover:bg-dark-surface-hover";
  allBtn.onclick = () => setCategoryFilter(null);
  container.appendChild(allBtn);

  // タグを人数の多い順にソートしてピル（ボタン）を生成
  Object.entries(tagTotals)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([tag, data]) => {
      const isSelected = currentActiveTag === tag;
      const btn = document.createElement("button");
      btn.className = `snap-start px-3 py-1.5 rounded-full text-xs font-bold transition-all shrink-0 flex items-center gap-1.5 ${isSelected ? "bg-primary text-white border border-primary shadow-md scale-105" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 dark:bg-dark-surface dark:text-slate-300 dark:border-dark-border dark:hover:bg-dark-surface-hover"}`;

      btn.innerHTML = `<span class="truncate max-w-[120px] sm:max-w-[200px]">${escapeHtml(tag)}</span> <span class="${isSelected ? "text-white/80" : "text-slate-400 dark:text-slate-500"} font-normal text-[10px] ml-1">${data.count}</span>`;
      btn.onclick = () => setCategoryFilter(tag);
      container.appendChild(btn);
    });

  // レンダリング直後にスクロール位置を復元
  requestAnimationFrame(() => {
    container.scrollLeft = currentScrollLeft;
  });
}

// 3. ブロック構造の描画
function renderData(focusBlockId = null) {
  if (!db) return;
  const container = document.getElementById("blocks-container");

  const res = db.exec(
    "SELECT id, parent_id, memo, contact_info, created_at, role, tags FROM records ORDER BY sort_order ASC, id ASC",
  );

  // レコードを格納する配列（空の場合は空ステートを描画するため処理を続行）
  let records = [];
  if (res.length > 0 && res[0].values) {
    records = res[0].values.map(
      ([id, parent_id, memo, contactInfo, created_at, role, tags]) => {
        return {
          id,
          parent_id,
          memo,
          contact_info: contactInfo,
          created_at,
          role,
          tags,
          children: [],
        };
      },
    );
  }

  const recordMap = records.reduce((acc, record) => {
    acc[record.id] = record;
    return acc;
  }, {});

  const tree = [];
  records.forEach((record) => {
    if (record.parent_id && recordMap[record.parent_id]) {
      recordMap[record.parent_id].children.push(record);
    } else {
      tree.push(record);
    }
  });

  // タグ集計用 (事前に全データから抽出しておく)
  let tagTotals = Object.create(null);
  tree.forEach((block) => {
    const blockTagsField = (block.tags || "")
      .split(/[,、\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith("#") || t.startsWith("＃") ? t : "#" + t));
    const blockMemoTags =
      (block.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
    const combinedBlockTags = [...blockMemoTags, ...blockTagsField];

    if (block.children.length === 0) {
      const rawTags = [...combinedBlockTags].map((t) => t.replace("＃", "#"));
      const allTags = [...new Set(rawTags)];
      allTags.forEach((tag) => {
        if (!tagTotals[tag]) tagTotals[tag] = { count: 0, items: [] };
      });
    } else {
      block.children.forEach((item) => {
        const itemMemoTags =
          (item.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
        const itemTagsField = (item.tags || "")
          .split(/[,、\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => (t.startsWith("#") || t.startsWith("＃") ? t : "#" + t));

        const rawTags = [
          ...itemMemoTags,
          ...itemTagsField,
          ...combinedBlockTags,
        ].map((t) => t.replace("＃", "#"));
        const allTags = [...new Set(rawTags)];

        allTags.forEach((tag) => {
          if (!tagTotals[tag]) tagTotals[tag] = { count: 0, items: [] };
          tagTotals[tag].count += 1;
          tagTotals[tag].items.push({
            id: item.id,
            date: item.created_at,
            memo: item.memo,
            name: item.memo,
            org: block.memo,
            role: item.role,
            contact_info: item.contact_info,
            item_tags: item.tags,
            org_tags: block.tags,
          });
        });
      });
    }
  });

  // 画面上部のカテゴリタブUIを更新
  updateCategoryFiltersUI(tagTotals);

  const tagDatalist = document.getElementById("tag-suggestions");
  if (tagDatalist) {
    tagDatalist.innerHTML = "";
    Object.keys(tagTotals).forEach((tag) => {
      const option = document.createElement("option");
      option.value = tag.replace(/^[#＃]/, ""); // 入力時は # なしでサジェスト
      tagDatalist.appendChild(option);
    });
  }

  // カテゴリ（タグ）によるフィルタリングの適用
  const filteredTree = [];
  tree.forEach((block) => {
    if (!currentActiveTag) {
      filteredTree.push(block);
    } else {
      // 親ブロック自体がタグを含んでいるか
      const blockTagsField = (block.tags || "")
        .split(/[,、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith("#") || t.startsWith("＃") ? t : "#" + t));
      const blockHasTag =
        (block.memo || "").replace("＃", "#").includes(currentActiveTag) ||
        blockTagsField
          .map((t) => t.replace("＃", "#"))
          .includes(currentActiveTag);

      if (blockHasTag) {
        // 親がタグを持っていれば、子要素はすべて表示
        filteredTree.push(block);
      } else {
        // 子要素の中にタグを持っている人がいれば、その人だけを残す
        const filteredChildren = block.children.filter((item) => {
          const itemTagsField = (item.tags || "")
            .split(/[,、\s]+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t) =>
              t.startsWith("#") || t.startsWith("＃") ? t : "#" + t,
            );
          return (
            (item.memo || "").replace("＃", "#").includes(currentActiveTag) ||
            itemTagsField
              .map((t) => t.replace("＃", "#"))
              .includes(currentActiveTag)
          );
        });
        if (filteredChildren.length > 0) {
          filteredTree.push({ ...block, children: filteredChildren });
        }
      }
    }
  });

  // 親ブロックを「新しいものが一番上」になるようID降順でソート
  filteredTree.sort((a, b) => b.id - a.id);

  // 合計人数ラベルの表記更新
  const totalLabelEl = document.getElementById("grand-total-label");
  if (totalLabelEl) {
    totalLabelEl.textContent = currentActiveTag
      ? window._t("label.filtered_by", currentActiveTag)
      : window._t("label.total_contacts");
  }

  // 左側 TOC (目次) の構築
  const tocContainer = document.getElementById("toc-container");
  const tocList = document.getElementById("toc-list");
  if (tocContainer && tocList) {
    const prevScrollTop = tocContainer.scrollTop; // スクロール位置を記憶
    tocList.innerHTML = "";

    filteredTree.forEach((block) => {
      const a = document.createElement("a");
      a.href = `#block-${block.id}`;
      a.className =
        "toc-item block px-2 py-1 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-dark-surface-hover rounded truncate transition-colors text-slate-500 dark:text-slate-400 cursor-pointer text-sm font-medium";
      a.textContent = block.memo || window._t("label.unnamed");
      a.title = block.memo || window._t("label.unnamed");
      a.onclick = (e) => {
        e.preventDefault();

        // ★ クリックしたブロック以外をすべて折りたたむ (排他制御でフィルタのような集中モードにする)
        let stmt;
        try {
          stmt = db.prepare("SELECT id FROM records WHERE parent_id IS NULL");
          while (stmt.step()) {
            const pid = stmt.get()[0];
            if (pid === block.id) {
              collapsedBlocks.delete(pid); // 対象は展開
            } else {
              collapsedBlocks.add(pid); // 他はすべて折りたたむ
            }
          }
        } finally {
          if (stmt) stmt.free();
        }

        const applyScroll = () => {
          // 💡 DOMの折りたたみが落ち着くまで少し待機し、1回だけシンプルにスクロールさせる
          setTimeout(() => {
            const targetEl = document.getElementById(`block-${block.id}`);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }, 150);
        };

        // 再描画して状態を反映
        if (document.startViewTransition) {
          document.startViewTransition(() => {
            renderData();
            applyScroll();
          });
        } else {
          renderData();
          applyScroll();
        }
      };
      tocList.appendChild(a);
    });

    // レンダリング後にスクロール位置を復元
    requestAnimationFrame(() => {
      tocContainer.scrollTop = prevScrollTop;
      // 検索フィルターが入力中なら再適用
      const tocFilter = document.getElementById("toc-filter");
      if (tocFilter && tocFilter.value) {
        applyTocFilter(tocFilter.value);
      }
    });
  }

  // ブロック要素の簡易差分更新 (AutoAnimateのチラつき防止)
  const existingBlocks = Array.from(container.children);
  const existingBlockMap = new Map();
  existingBlocks.forEach((el) => {
    if (el.id.startsWith("block-")) {
      const id = parseInt(el.id.replace("block-", ""), 10);
      existingBlockMap.set(id, el);
    } else if (el.id === "empty-state") {
      el.remove();
    }
  });

  const blockControls = document.getElementById("block-controls");

  if (filteredTree.length === 0) {
    // データがない時はコントロールを隠す
    if (blockControls) {
      blockControls.classList.add("hidden");
      blockControls.classList.remove("flex");
    }

    const isFilterActive = currentActiveTag !== null;

    // ✅ File System Access APIの対応状況を自動判定
    const isFsaSupported = "showSaveFilePicker" in window;
    const browserNoticeHtml = isFsaSupported
      ? `<div class="mt-8 flex flex-col items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
           <p class="font-bold flex items-center gap-1">
             <svg class="w-3.5 h-3.5"><use href="#icon-sparkles"></use></svg> ${window._t("empty.browser_rec_title")}
           </p>
           <p class="opacity-80">${window._t("empty.browser_rec_desc")}</p>
         </div>`
      : `<div class="mt-8 flex flex-col items-center gap-1.5 text-[11px] text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-4 py-2.5 rounded-xl border border-orange-200 dark:border-orange-800/50">
           <p class="font-bold flex items-center gap-1 text-xs">
             ${window._t("empty.browser_warn_title")}
           </p>
           <p class="opacity-90 max-w-[260px] leading-relaxed">${window._t("empty.browser_warn_desc")}</p>
         </div>`;

    container.innerHTML = `
      <div id="empty-state" class="flex flex-col items-center justify-center py-24 sm:py-32 text-center relative overflow-hidden rounded-3xl border border-slate-200/50 dark:border-dark-border/50 bg-slate-50/50 dark:bg-dark-surface/30 backdrop-blur-xl shadow-inner transition-all animate-fade-in group">
        <div class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9IjAiLz4KPHBhdGggZD0iTTAgMEw4IDhaTTAgOEw4IDBaIiBzdHJva2U9IiMzMzMiIHN0cm9rZS1vcGFjaXR5PSIwLjA1IiBzdHJva2Utd2lkdGg9IjEiLz4KPC9zdmc+')] opacity-50 dark:invert"></div>
        <div class="relative z-10 flex flex-col items-center px-4">
          <div class="w-24 h-24 mb-6 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center ring-8 ring-primary/5 dark:ring-primary/10 animate-float group-hover:scale-110 transition-transform duration-500">
            <svg class="w-10 h-10 text-primary drop-shadow-md"><use href="${isFilterActive ? "#icon-search" : "#icon-users"}"></use></svg>
          </div>
          <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${isFilterActive ? window._t("empty.title_filtered") : window._t("empty.title_welcome")}</h2>
          <p class="text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed mb-8">${isFilterActive ? window._t("empty.desc_filtered") : window._t("empty.desc_welcome")}</p>
          ${
            !isFilterActive
              ? `
          <button onclick="document.getElementById('new-block-memo').focus()" class="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-2.5 rounded-full text-sm font-bold shadow-xl shadow-slate-900/20 dark:shadow-white/10 hover:shadow-2xl hover:-translate-y-0.5 transition-all active:scale-95 flex items-center gap-2">
            <span class="text-xl leading-none font-light">+</span> ${window._t("empty.btn_new")}
          </button>
          ${browserNoticeHtml}
          `
              : ""
          }
        </div>
      </div>
    `;
    existingBlockMap.forEach((el) => el.remove());

    let mobileTagContainer = document.getElementById("mobile-tag-container");
    if (mobileTagContainer) mobileTagContainer.remove();

    animateTotal(0);
    renderMemoSuggestions();
    return;
  }

  // データがある時はコントロールを表示 (ただしフィルター適用中は強制展開されるため隠す)
  if (blockControls) {
    if (currentActiveTag) {
      blockControls.classList.add("hidden");
      blockControls.classList.remove("flex");
    } else {
      blockControls.classList.remove("hidden");
      blockControls.classList.add("flex");
    }
  }

  let currentDomIndex = 0;
  let grandTotal = 0;

  filteredTree.forEach((block) => {
    block.children.forEach((item) => {
      grandTotal += 1;
    });

    // 既存のDOMがあれば再利用し、なければ新規作成
    let blockEl = existingBlockMap.get(block.id);
    blockEl = updateOrCreateBlockElement(block, blockEl);
    existingBlockMap.delete(block.id);

    // 要素の順序が異なっていればDOM上の位置を修正する
    if (container.children[currentDomIndex] !== blockEl) {
      container.insertBefore(
        blockEl,
        container.children[currentDomIndex] || null,
      );
    }
    currentDomIndex++;
  });

  // 存在しなくなった古いブロックを削除
  existingBlockMap.forEach((el) => el.remove());

  // 左側 TOC の下部にタグ一覧を生成
  if (tocContainer && Object.keys(tagTotals).length > 0) {
    const tagDivider = document.createElement("div");
    tagDivider.className =
      "mt-8 font-bold text-slate-400 mb-2 px-2 uppercase text-[10px] tracking-widest flex items-center gap-1";
    tagDivider.innerHTML = `<svg class="w-3 h-3"><use href="#icon-folder"></use></svg> PROJECTS`;
    if (tocList) tocList.appendChild(tagDivider);

    // タグを人数が多い順にソートして表示
    Object.entries(tagTotals)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([tag, data]) => {
        const a = document.createElement("div");
        a.className =
          "group px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-surface-hover rounded transition-colors flex justify-between items-center";
        a.innerHTML = `
          <div class="flex items-center gap-2 overflow-hidden flex-1 cursor-pointer">
            <span class="text-sm font-medium text-slate-600 dark:text-slate-300 group-hover:text-primary transition-colors truncate" title="${window._t("title.click_list")}">${escapeHtml(tag)}</span>
            <span class="text-[10px] tabular-nums tracking-tight font-bold text-slate-400 bg-slate-100 dark:bg-dark-bg px-1.5 py-0.5 rounded group-hover:bg-white dark:group-hover:bg-dark-surface-hover transition-colors">${data.count} ${window._t("unit.people")}</span>
          </div>
          <button class="export-btn opacity-0 group-hover:opacity-100 text-slate-400 hover:text-primary transition-opacity ml-2 shrink-0 p-1" title="${window._t("title.export_vcard")}">
            <svg class="w-4 h-4"><use href="#icon-download"></use></svg>
          </button>
        `;
        a.querySelector("div").onclick = (e) => {
          e.preventDefault();
          // ★ モーダルを出すのではなく、メイン画面のフィルタを直接かける
          setCategoryFilter(tag);
        };
        a.querySelector(".export-btn").onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          exportTagVCard(tag, data.items);
        };
        if (tocList) tocList.appendChild(a);
      });
  }

  // スマホ用のタグ表示エリアを（既存のものがあれば削除して）再生成
  const mainContainer = document.getElementById("blocks-container");

  let prevMobileTagScroll = 0;
  const existingMobileGrid = document.querySelector("#mobile-tag-container .grid");
  if (existingMobileGrid) {
    prevMobileTagScroll = existingMobileGrid.scrollTop;
  }

  let mobileTagContainer = document.getElementById("mobile-tag-container");
  if (mobileTagContainer) mobileTagContainer.remove();

  if (Object.keys(tagTotals).length > 0 && currentActiveTag === null) {
    mobileTagContainer = document.createElement("div");
    mobileTagContainer.id = "mobile-tag-container";
    mobileTagContainer.className =
      "xl:hidden mt-12 mb-8 bg-white dark:bg-dark-surface p-6 rounded-xl border border-slate-200 dark:border-dark-border shadow-sm";
    mobileTagContainer.innerHTML = `<h3 class="text-xs font-bold text-slate-400 mb-4 tracking-widest flex items-center gap-1"><svg class="w-4 h-4"><use href="#icon-folder"></use></svg> PROJECTS (TAGS)</h3>`;

    const grid = document.createElement("div");
    grid.className =
      "grid grid-cols-2 gap-3 max-h-[40vh] overflow-y-auto overscroll-contain pr-1";

    Object.entries(tagTotals)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([tag, data]) => {
        const btn = document.createElement("div");
        btn.className =
          "text-left p-3 rounded-lg bg-slate-50 dark:bg-dark-bg hover:bg-slate-100 dark:hover:bg-dark-surface-hover border border-slate-100 dark:border-dark-border transition-colors flex flex-col gap-1 relative group cursor-pointer";
        btn.innerHTML = `
          <span class="text-sm font-bold text-slate-700 truncate pr-6">${escapeHtml(tag)}</span>
          <span class="text-xs tabular-nums tracking-tight text-slate-500">${data.count} ${window._t("unit.people")}</span>
          <button class="export-btn absolute -top-1 -right-1 text-slate-300 hover:text-primary transition-colors p-3" title="${window._t("title.export_vcard")}">
            <svg class="w-4 h-4"><use href="#icon-download"></use></svg>
          </button>
        `;
        // ★ モーダルではなくメイン画面フィルタ
        btn.onclick = () => setCategoryFilter(tag);
        btn.querySelector(".export-btn").onclick = (e) => {
          e.stopPropagation();
          exportTagVCard(tag, data.items);
        };
        grid.appendChild(btn);
      });

    mobileTagContainer.appendChild(grid);
    // スマホではスクロールせずにアクセスできるよう、一番「上」に挿入する
    mainContainer.insertBefore(mobileTagContainer, mainContainer.firstChild);

    if (prevMobileTagScroll > 0) {
      requestAnimationFrame(() => {
        const newGrid = document.querySelector("#mobile-tag-container .grid");
        if (newGrid) newGrid.scrollTop = prevMobileTagScroll;
      });
    }
  }

  // 数字のアニメーション更新
  animateTotal(Math.round(grandTotal));

  renderMemoSuggestions();

  if (focusBlockId) {
    const targetInput = document.querySelector(
      `#block-form-${focusBlockId} .item-memo`,
    );
    if (targetInput) {
      targetInput.focus({ preventScroll: true });
      targetInput.scrollIntoView({ behavior: "instant", block: "center" });
    }
  }

  // --- TOC（目次）の自動ハイライト (Scrollspy) ---
  if (window.tocObserver) window.tocObserver.disconnect();

  window.tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          document.querySelectorAll(".toc-item").forEach((el) => {
            el.classList.remove(
              "text-primary",
              "dark:text-blue-400",
              "bg-primary-50",
              "dark:bg-primary/20",
              "font-bold",
            );
            el.classList.add(
              "text-slate-500",
              "dark:text-slate-400",
              "font-medium",
            );
          });
          const activeToc = document.querySelector(
            `.toc-item[href="#${entry.target.id}"]`,
          );
          if (activeToc) {
            activeToc.classList.remove(
              "text-slate-500",
              "dark:text-slate-400",
              "font-medium",
            );
            activeToc.classList.add(
              "text-primary",
              "dark:text-blue-400",
              "bg-primary-50",
              "dark:bg-primary/20",
              "font-bold",
            );
            const tocContainer = document.getElementById("toc-container");
            const tocFilter = document.getElementById("toc-filter");
            const isFiltering = tocFilter && tocFilter.value.trim() !== "";

            if (tocContainer && !tocContainer.matches(":hover") && !isFiltering) {
              // scrollIntoViewはページ全体のスクロールを阻害してカクつきを生むため、コンテナ内の相対位置で安全にスクロールさせる
              const scrollPos =
                activeToc.offsetTop -
                tocContainer.clientHeight / 2 +
                activeToc.clientHeight / 2;
              tocContainer.scrollTo({
                top: scrollPos,
                behavior: "smooth",
              });
            }
          }
        }
      });
    },
    { rootMargin: "-20% 0px -60% 0px" },
  );

  // ブロック要素 (.group/block) のみを安全に監視対象にする
  document.querySelectorAll(".group\\/block").forEach((block) => {
    window.tocObserver.observe(block);
  });
}

function updateOrCreateBlockElement(block, existingEl = null) {
  const blockEl = existingEl || document.createElement("div");
  if (!existingEl) {
    blockEl.id = `block-${block.id}`; // TOCアンカー用
    blockEl.className = "group/block relative scroll-mt-36 sm:scroll-mt-48";
    // 画面外の要素のレンダリングをスキップし、数万件でも60fpsを維持する魔法
    blockEl.style.contentVisibility = "auto";
    blockEl.style.containIntrinsicSize = "auto 150px";
  }

  const blockTotal = block.children.length;

  let itemsHtml = "";
  block.children.forEach((item) => {
    const avatarSvg = generateAvatarSVG(item.memo || "", item.id);
    const avatarHtml = `<div class="w-8 h-8 rounded-full overflow-hidden shrink-0 mr-3 shadow-sm border border-white/20 hidden sm:block">${avatarSvg}</div>`;
    const roleStr = item.role || "";

    // ★ 役職のデザインをダークモード対応し、ライトモードでもコントラストを高めて見やすくしました
    let roleDisp = `<input type="text" data-id="${item.id}" data-field="role" list="role-suggestions" value="${escapeHtml(roleStr)}" placeholder="${window._t("placeholder.role")}" spellcheck="false" autocomplete="off" onfocus="this.select()" oninput="setDirty(true)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();window.focusAndSelectAll(this.closest('.group/item').querySelector('[data-field=\\'memo\\']'));}" onblur="updateRecord(${item.id}, 'role', this.value, this)" class="text-xs text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-dark-surface border border-slate-200 dark:border-dark-border px-1.5 py-0.5 rounded mr-2 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary dark:focus:border-primary focus:bg-white dark:focus:bg-dark-bg cursor-text transition-colors hover:bg-slate-200 dark:hover:bg-dark-surface-hover w-20 sm:w-32 shrink-0 text-center placeholder-slate-400 dark:placeholder-slate-500">`;

    itemsHtml += `
      <div class="flex justify-between items-center px-4 sm:px-8 py-3.5 border-b border-slate-50 dark:border-dark-border/30 group/item hover:bg-slate-50/80 dark:hover:bg-dark-surface-hover transition-colors">
        <div class="flex items-center flex-1 min-w-0">
          ${avatarHtml}
          ${roleDisp}
            <span data-id="${item.id}" data-field="memo" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '' || this.innerHTML === '<br>') this.innerHTML = ''; setDirty(true);" onpaste="handlePlainTextPaste(event)" ondrop="event.preventDefault();" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();window.focusAndSelectAll(this.closest('.group/item').querySelector('[data-field=\\'contact_info\\']'));}" onblur="updateRecord(${item.id}, 'memo', this.innerText, this)" class="text-slate-700 dark:text-slate-200 font-medium block min-w-0 flex-1 truncate outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-16 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:text-slate-400 empty:before:text-xs empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50" data-empty-text="✎ ${window._t('placeholder.enter_name')}">${escapeHtml(item.memo)}</span>
        </div>
        <div class="flex items-center space-x-2 sm:space-x-4 ml-2 sm:ml-auto shrink-0 min-w-0">
          <!-- ★ ここが既存メンバーの連絡先表示欄です -->
          <span data-id="${item.id}" data-field="contact_info" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '' || this.innerHTML === '<br>') this.innerHTML = ''; setDirty(true);" onpaste="handlePlainTextPaste(event)" ondrop="event.preventDefault();" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'contact_info', this.innerText, this)" class="font-mono text-sm tracking-tight text-slate-600 dark:text-slate-400 outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors block truncate max-w-[120px] sm:max-w-[220px] empty:inline-block empty:min-w-20 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:text-slate-300 empty:before:text-xs empty:before:font-sans empty:before:pointer-events-none empty:focus:before:opacity-50" data-empty-text="✎ ${window._t('placeholder.tel_email_short')}">${escapeHtml(item.contact_info || "")}</span>
          <div class="flex items-center space-x-1 md:opacity-0 md:group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity">
            <!-- ★ タッチターゲットを拡大 (p-2) しました -->
            <button tabindex="-1" onclick="shareContact(${item.id})" aria-label="${window._t("aria.share")}" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-2 transition-colors" title="${window._t("title.share_vcard")}">
              <svg class="w-4 h-4"><use href="#icon-share"></use></svg>
            </button>
            <button tabindex="-1" onclick="showContactDetail(${item.id})" aria-label="${window._t("aria.detail")}" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-2 transition-colors" title="${window._t("title.edit_detail")}">
              <svg class="w-4 h-4"><use href="#icon-pencil"></use></svg>
            </button>
            <button tabindex="-1" onclick="duplicateRecord(${item.id})" aria-label="${window._t("aria.duplicate")}" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-2 transition-colors" title="${window._t("title.duplicate")}">
              <svg class="w-4 h-4"><use href="#icon-copy"></use></svg>
            </button>
            <!-- ★ 削除ボタンもタップしやすく拡大しました -->
            <button tabindex="-1" onclick="deleteRecord(${item.id})" aria-label="${window._t("aria.delete")}" class="text-slate-300 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-200 rounded transition-colors text-2xl leading-none px-2 py-1 -mt-0.5" title="${window._t("title.delete")}">&times;</button>
          </div>
        </div>
      </div>
    `;
  });

  // ★ フィルター適用中は、ユーザーを迷わせないため強制的にブロックを展開する
  const isCollapsed = collapsedBlocks.has(block.id) && !currentActiveTag;
  const maxH = isCollapsed ? "0px" : "99999px";
  const op = isCollapsed ? "0" : "1";
  const iconRotation = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";

  blockEl.innerHTML = `
    <div class="bg-white dark:bg-dark-surface rounded-xl shadow-sm border border-slate-200 dark:border-dark-border overflow-hidden transition-all hover:border-slate-300 dark:hover:border-dark-border-hover hover:shadow-md">

    <!-- ★ レイアウト崩壊の原因だった sticky 関連のクラスを削除し、元の安全なフローに戻しました -->
    <div onclick="toggleBlock(${block.id})" class="bg-slate-50/50 dark:bg-dark-surface px-4 sm:px-8 py-5 border-b border-slate-100 dark:border-dark-border flex justify-between items-start transition-colors cursor-pointer select-none group/header hover:bg-slate-100 dark:hover:bg-dark-surface-hover">

      <div class="flex flex-col overflow-hidden w-full">
        <div class="flex items-center gap-3">
          <svg id="block-icon-${block.id}" class="w-5 h-5 text-slate-400 transition-transform duration-200 shrink-0" style="transform: ${iconRotation};"><use href="#icon-chevron-down"></use></svg>
          <!-- ★ select-text でiOSのフォーカスバグを防止 -->
          <h2 data-id="${block.id}" data-field="memo" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '' || this.innerHTML === '<br>') this.innerHTML = ''; setDirty(true);" onpaste="handlePlainTextPaste(event)" ondrop="event.preventDefault();" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault(); const form = document.getElementById('block-form-${block.id}'); if(form){ window.focusAndSelectAll(form.querySelector('.item-memo')); } else { this.blur(); } }" onblur="updateRecord(${block.id}, 'memo', this.innerText, this)" class="select-text text-xl font-extrabold text-slate-900 dark:text-white tracking-tight outline-none focus:bg-white dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-primary/30 px-1 rounded cursor-text truncate transition-colors empty:inline-block empty:min-w-24 empty:bg-slate-200 dark:empty:bg-dark-bg empty:before:text-slate-400 empty:before:text-sm empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50" data-empty-text="✎ ${window._t('placeholder.group_name')}">${escapeHtml(block.memo)}</h2>
        </div>

        <!-- ★ 専用タグ入力欄 -->
        <div class="flex items-center gap-1.5 mt-1.5 ml-8 opacity-60 hover:opacity-100 focus-within:opacity-100 transition-opacity" onclick="event.stopPropagation()">
          <svg class="w-3.5 h-3.5 text-slate-400 shrink-0"><use href="#icon-tag"></use></svg>
          <input type="text" data-id="${block.id}" data-field="tags" list="tag-suggestions" spellcheck="false" autocomplete="off" value="${escapeHtml(block.tags || "")}" placeholder="${window._t("placeholder.add_tag")}" oninput="setDirty(true)" onblur="updateRecord(${block.id}, 'tags', this.value, this)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" class="bg-transparent border-0 focus:ring-0 p-0 text-xs text-slate-500 dark:text-slate-400 placeholder-slate-300 w-full outline-none font-medium">
        </div>
      </div>
      <div class="flex items-center shrink-0">
        <div class="font-bold tabular-nums tracking-tight text-slate-900 dark:text-white text-lg"><span id="block-total-${block.id}">${blockTotal}</span> <span class="text-slate-400 text-sm font-sans">${window._t("unit.people")}</span></div>
        <div class="flex items-center pl-2 border-l border-slate-200/50 dark:border-dark-border/50 ml-4 shrink-0 h-8 gap-1">
          <!-- ★ テンプレート保存ボタンをはみ出させず、ここに安全に統合しました -->
          <button onclick="event.stopPropagation(); saveTemplate(${block.id})" aria-label="${window._t("aria.save_tpl")}" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-primary/10 hover:text-primary hover:shadow-[0_0_10px_rgba(15,98,254,0.2)] md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all cursor-pointer" title="${window._t("title.save_tpl")}">
            <svg class="w-5 h-5"><use href="#icon-squares-plus"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); sortBlockByDate(${block.id})" aria-label="${window._t("aria.sort")}" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-dark-surface-hover hover:text-slate-600 dark:hover:text-slate-300 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-300 transition-all cursor-pointer" title="${window._t("title.sort_oldest")}">
            <svg class="w-4 h-4"><use href="#icon-sort"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); shareBlock(${block.id})" aria-label="${window._t("aria.share_group")}" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-primary/10 hover:text-primary md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all cursor-pointer" title="${window._t("title.share_group")}">
            <svg class="w-5 h-5"><use href="#icon-share"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); deleteRecord(${block.id})" aria-label="${window._t("aria.delete_block")}" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 transition-all cursor-pointer" title="${window._t("title.delete_block")}">
            <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
    </div>
    <div id="block-body-${block.id}" class="transition-all duration-300 ease-in-out overflow-hidden" style="max-height: ${maxH}; opacity: ${op};">
      <div class="">${itemsHtml}</div>
      <div class="px-4 sm:px-8 py-4 bg-white dark:bg-dark-surface transition-colors">
      <form id="block-form-${block.id}" class="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 py-2 -mx-3 rounded-md transition-all focus-within:bg-slate-50 dark:focus-within:bg-dark-surface-hover focus-within:ring-1 focus-within:ring-slate-200 dark:focus-within:ring-dark-border" onsubmit="event.preventDefault(); addItem(
        ${block.id},
        this.querySelector('.item-memo').value,
        this.querySelector('.item-contact').value,
        null,
        this.querySelector('.item-role').value
      );">
        <span class="text-primary text-xl leading-none font-light hidden sm:inline">+</span>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <button type="submit" aria-label="${window._t("btn.add_member")}" class="text-primary bg-primary/10 hover:bg-primary/20 rounded-full w-10 h-10 flex items-center justify-center text-2xl leading-none font-light sm:hidden transition-colors outline-none focus:ring-2 focus:ring-primary/50 shrink-0">+</button>
          <input type="text" placeholder="${window._t("placeholder.role")}" value="" list="role-suggestions" spellcheck="false" autocomplete="off" oninput="setDirty(true)" onfocus="this.select()" onkeydown="if(event.key==='Enter'){ if(event.isComposing) { event.preventDefault(); return; } event.preventDefault();this.closest('form').querySelector('.item-memo').focus();}" class="item-role bg-transparent border-0 focus:ring-0 p-0 text-slate-600 dark:text-slate-300 placeholder-slate-400 w-20 sm:w-32 shrink-0 text-sm outline-none text-center min-w-0">
        </div>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 pl-6 mt-2 sm:mt-0 min-w-0 border-l border-slate-200/50 dark:border-dark-border/50 sm:pl-3 relative group/paste">
          <!-- ★ onfocusのスクロールをPC限定にしてJankを防止 -->
          <input type="text" placeholder="${window._t("placeholder.add_name")}" list="memo-suggestions" spellcheck="false" autocomplete="off" onpaste="handleSmartPaste(event)" oninput="setDirty(true)" onblur="autoSuggestRole(this)" onfocus="if(window.matchMedia('(min-width: 769px)').matches) { setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300); }" onkeydown="if(event.key==='Enter'){ if(event.isComposing) { event.preventDefault(); return; } event.preventDefault();this.closest('form').querySelector('.item-contact').focus();}" class="item-memo bg-transparent border-0 focus:ring-0 p-0 text-slate-900 dark:text-white placeholder-slate-400 flex-1 text-sm font-medium outline-none min-w-0">
          <svg class="w-4 h-4 text-primary absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/paste:opacity-30 pointer-events-none transition-opacity" title="${window._t("title.smart_paste_help")}"><use href="#icon-sparkles"></use></svg>

          <!-- ★ ここが消えていた新規追加用の連絡先入力欄 (item-contact) です！ -->
          <input type="text" inputmode="email" placeholder="${window._t("placeholder.tel_email")}" spellcheck="false" autocomplete="off" class="item-contact bg-transparent border-0 focus:ring-0 p-0 text-right font-mono text-slate-600 dark:text-slate-400 placeholder-slate-400 w-28 sm:w-48 shrink-0 text-sm outline-none min-w-0" oninput="setDirty(true)" onfocus="if(window.matchMedia('(min-width: 769px)').matches) { setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300); }" onkeydown="if(event.isComposing){ event.preventDefault(); return; } if((event.key==='Enter') || (event.key==='Tab' && !event.shiftKey)){ const form = this.closest('form'); if(form.querySelector('.item-memo').value.trim() || this.value.trim()){ event.preventDefault(); form.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true})); } }">
        </div>
        <button type="submit" class="hidden">${window._t("btn.add")}</button>
      </form>
      </div>
    </div>
  `;
  return blockEl;
}

// --- テンプレート（1Shot生成）機能 ---
async function saveTemplate(blockId) {
  if (!db) return;

  // ブロックのタイトルを取得
  let blockMemo = window._t("label.unnamed");
  let blockStmt;
  try {
    blockStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
    blockStmt.bind([blockId]);
    if (blockStmt.step()) {
      blockMemo = blockStmt.get()[0] || window._t("label.unnamed");
    } else {
      return;
    }
  } finally {
    if (blockStmt) blockStmt.free();
  }

  // 子要素（明細）の構成を取得
  let items = [];
  let itemsStmt;
  try {
    itemsStmt = db.prepare(
      "SELECT id, memo, role, contact_info, tags FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
    );
    itemsStmt.bind([blockId]);
    while (itemsStmt.step()) {
      const row = itemsStmt.get();
      items.push({
        memo: row[1],
        role: row[2],
        contact_info: row[3],
        tags: row[4],
        fields: getContactFields(row[0]),
      });
    }
  } finally {
    if (itemsStmt) itemsStmt.free();
  }

  let tplName = await window.requestCustomPrompt(
    window._t("prompt.save_tpl_title"),
    window._t("prompt.save_tpl_desc"),
    window._t("prompt.save_tpl_default", blockMemo),
    "prompt",
  );
  if (!tplName) return;

  let stmt;
  try {
    stmt = db.prepare("INSERT INTO templates (name, data) VALUES (?, ?)");
    stmt.run([tplName, JSON.stringify(items)]);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
  showToast(window._t("toast.tpl_saved", escapeHtml(tplName)), "✨");
}

function insertTemplate(templateId) {
  if (!db) return;

  let tplName = "";
  let rawData = "[]";
  let stmt;
  try {
    stmt = db.prepare("SELECT name, data FROM templates WHERE id = ?");
    stmt.bind([templateId]);
    if (!stmt.step()) return;
    const row = stmt.get();
    tplName = row[0];
    rawData = row[1];
  } finally {
    if (stmt) stmt.free();
  }

  let tplData = [];
  try {
    tplData = JSON.parse(rawData || "[]");
  } catch (e) {
    showToast(
      window._t("error.tpl_load"),
      "⚠️",
      "error",
    );
    return;
  }

  // 万が一パース結果がオブジェクト等で配列でない場合のクラッシュ(TypeError)を防止
  if (!Array.isArray(tplData)) {
    showToast(
      window._t("error.tpl_corrupted"),
      "⚠️",
      "error",
    );
    return;
  }

  let defaultTag = null;
  if (currentActiveTag) {
    defaultTag = currentActiveTag.replace(/^[#＃]/, "");
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const sec = String(now.getSeconds()).padStart(2, "0");
  const localTime = `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;

  // 新しい親ブロックを作成
  db.run(
    "INSERT INTO records (memo, contact_info, tags, created_at) VALUES (?, ?, ?, ?)",
    [tplName, null, defaultTag, localTime],
  );
  const parentRes = db.exec("SELECT last_insert_rowid()");
  const parentId = parentRes[0]?.values?.[0]?.[0];
  if (!parentId) {
    console.error("IDの取得に失敗しました");
    return;
  }

  // 今日の日付を取得 (子要素の created_at 用)
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;

  // 子要素を展開して一気にINSERT
  let insertStmt = null;
  let insertFieldStmt = null;
  try {
    insertStmt = db.prepare(
      "INSERT INTO records (parent_id, memo, contact_info, role, created_at, tags) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertFieldStmt = db.prepare(
      "INSERT INTO contact_fields (record_id, field_key, field_value, field_type, sort_order) VALUES (?, ?, ?, ?, ?)",
    );
    for (let item of tplData) {
      insertStmt.run([
        parentId,
        item.memo,
        item.contact_info,
        item.role,
        dateStr,
        item.tags || null,
      ]);
      const childRes = db.exec("SELECT last_insert_rowid()");
      const childId = childRes[0]?.values?.[0]?.[0];
      if (!childId) continue;

      if (item.fields && Array.isArray(item.fields)) {
        for (let f of item.fields) {
          insertFieldStmt.run([
            childId,
            f.field_key,
            f.field_value,
            f.field_type || "other",
            f.sort_order || 0,
          ]);
        }
      }
    }
  } finally {
    if (insertStmt) insertStmt.free();
    if (insertFieldStmt) insertFieldStmt.free();
  }

  setDirty(true);
  renderData(parentId);
}

// 3.5 データの削除（DELETE文の実行）
async function deleteRecord(id, force = false) {
  if (!db) return;

  // ブロックかメンバーかを判定し、子供の数を数える
  let isParent = false;
  let childCount = 0;
  let pStmt = null;
  let cStmt = null;
  try {
    pStmt = db.prepare("SELECT parent_id FROM records WHERE id = ?");
    pStmt.bind([id]);
    if (pStmt.step() && pStmt.get()[0] === null) {
      isParent = true;
      cStmt = db.prepare("SELECT COUNT(*) FROM records WHERE parent_id = ?");
      cStmt.bind([id]);
      if (cStmt.step()) childCount = cStmt.get()[0];
    }
  } catch (e) {
  } finally {
    if (pStmt) pStmt.free();
    if (cStmt) cStmt.free();
  }

  if (!force) {
    const msg =
      isParent && childCount > 0
        ? window._t("confirm.delete_group", childCount)
        : window._t("confirm.delete_record");

    const isConfirmed = await window.requestCustomPrompt(
      window._t("confirm.title"),
      msg,
      "",
      "confirm",
    );
    if (!isConfirmed) return;
  }

  // contact_fields の関連データも連動削除
  try {
    db.run(
      "DELETE FROM contact_fields WHERE record_id = ? OR record_id IN (SELECT id FROM records WHERE parent_id = ?)",
      [id, id],
    );
  } catch (e) {
    console.warn("contact_fields cascade delete:", e);
  }

  let stmt;
  try {
    stmt = db.prepare("DELETE FROM records WHERE id = ? OR parent_id = ?");
    stmt.run([id, id]);
  } finally {
    if (stmt) stmt.free();
  }

  // ゾンビステートのクリーンアップ
  collapsedBlocks.delete(id);

  setDirty(true);
  renderData();
}

// 手動でブロック内の明細を日付順に並べ替える
async function sortBlockByDate(blockId) {
  if (!db) return;
  const isConfirmed = await window.requestCustomPrompt(
    window._t("confirm.sort_title"),
    window._t("confirm.sort_desc"),
    "",
    "confirm",
  );
  if (!isConfirmed) return;

  let stmt;
  let items = [];
  try {
    stmt = db.prepare("SELECT id, created_at FROM records WHERE parent_id = ?");
    stmt.bind([blockId]);
    while (stmt.step()) {
      const [id, created_at] = stmt.get();
      items.push({ id, created_at: created_at || "" });
    }
  } finally {
    if (stmt) stmt.free();
  }

  items.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return a.id - b.id; // 日付が同じなら元の順序を維持
  });

  let updateStmt;
  try {
    db.run("BEGIN TRANSACTION;");
    updateStmt = db.prepare("UPDATE records SET sort_order = ? WHERE id = ?");
    items.forEach((item, index) => {
      updateStmt.run([index, item.id]);
    });
    db.run("COMMIT;");
    setDirty(true);
    renderData();
    showToast(window._t("toast.sorted"), "🧹");
  } catch (e) {
    db.run("ROLLBACK;");
    console.error("並べ替えに失敗しました", e);
  } finally {
    if (updateStmt) updateStmt.free();
  }
}

// 3.6 明細の複製
function duplicateRecord(id) {
  if (!db) return;

  let stmt;
  let insertStmt;
  try {
    stmt = db.prepare(
      "SELECT parent_id, memo, contact_info, role, created_at, sort_order, tags FROM records WHERE id = ?",
    );
    stmt.bind([id]);
    if (stmt.step()) {
      const [
        parent_id,
        memo,
        contact_info,
        role,
        created_at,
        sort_order,
        tags,
      ] = stmt.get();

      insertStmt = db.prepare(
        "INSERT INTO records (parent_id, memo, contact_info, role, created_at, sort_order, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insertStmt.run([
        parent_id,
        memo,
        contact_info,
        role,
        created_at,
        sort_order,
        tags,
      ]);

      // 新しく挿入されたレコードのIDを取得
      const res = db.exec("SELECT last_insert_rowid()");
      const newId = res[0]?.values?.[0]?.[0];

      if (!newId) {
        console.error("複製先IDの取得に失敗しました");
        return;
      }

      // 💡 関連する contact_fields の詳細データをコピーする処理
      let fieldsStmt;
      let insertFieldStmt;
      try {
        fieldsStmt = db.prepare(
          "SELECT field_key, field_value, field_type, sort_order FROM contact_fields WHERE record_id = ?",
        );
        fieldsStmt.bind([id]);
        insertFieldStmt = db.prepare(
          "INSERT INTO contact_fields (record_id, field_key, field_value, field_type, sort_order) VALUES (?, ?, ?, ?, ?)",
        );
        while (fieldsStmt.step()) {
          const [fKey, fVal, fType, fSort] = fieldsStmt.get();
          insertFieldStmt.run([newId, fKey, fVal, fType, fSort]);
        }
      } catch (e) {
        console.error("Failed to duplicate contact_fields:", e);
      } finally {
        if (fieldsStmt) fieldsStmt.free();
        if (insertFieldStmt) insertFieldStmt.free();
      }

      setDirty(true);
      renderData();

      showToast(
        window._t("toast.duplicated"),
        '<span class="text-green-400">📋</span>',
      );

      // 画面の再描画が終わった直後に、新しい行の名前にフォーカスを当てて全選択する
      requestAnimationFrame(() => {
        const newMemoEl = document.querySelector(
          `span[data-id="${newId}"][data-field="memo"]`,
        );
        if (newMemoEl) {
          newMemoEl.scrollIntoView({ behavior: "smooth", block: "center" });
          newMemoEl.focus();
          window.getSelection().selectAllChildren(newMemoEl);
        }
      });
    }
  } catch (e) {
    console.error("Duplicate failed:", e);
  } finally {
    if (stmt) stmt.free();
    if (insertStmt) insertStmt.free();
  }
}

// 4. 【核心部】 File System Access API を使った保存
async function savePeopleFile(isSaveAs = false) {
  if (!db) return;
  if (isSaving) return;
  isSaving = true;

  // 手動保存が走った場合、裏で待機中のオートセーブをキャンセルする
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }

  let activeSelector = null;
  const activeEl = document.activeElement;
  if (
    activeEl &&
    typeof activeEl.blur === "function" &&
    activeEl.tagName !== "BODY" &&
    activeEl.id !== "cmd-input"
  ) {
    if (
      typeof activeEl.hasAttribute === "function" &&
      activeEl.hasAttribute("data-id") &&
      activeEl.hasAttribute("data-field")
    ) {
      activeSelector = `[data-id="${activeEl.getAttribute("data-id")}"][data-field="${activeEl.getAttribute("data-field")}"]`;
    } else if (activeEl.classList.contains("item-memo")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains("item-contact")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-contact`;
    } else if (
      activeEl.hasAttribute("data-field") &&
      activeEl.getAttribute("data-field") === "role"
    ) {
      const id = activeEl.getAttribute("data-id");
      activeSelector = `input[data-id="${id}"][data-field="role"]`;
    } else if (
      activeEl.hasAttribute("data-field") &&
      activeEl.getAttribute("data-field") === "tags"
    ) {
      const id = activeEl.getAttribute("data-id");
      activeSelector = `input[data-id="${id}"][data-field="tags"]`;
    } else if (activeEl.classList.contains("item-role")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-role`;
    } else if (activeEl.id) {
      activeSelector = `#${activeEl.id}`;
    }
    activeEl.blur(); // DBに値を確定させる
  }

  try {
    db.run("VACUUM");
    let data = db.export();
    const currentPassword = document.getElementById("file-password").value;
    const currentPasswordHash = await sha256(currentPassword);

    if (lastSavedPasswordHash !== "" && currentPassword === "") {
      const isConfirmed = await window.requestCustomPrompt(
        window._t("alert.pw_empty_title"),
        window._t("alert.pw_empty_desc"),
        "",
        "confirm",
      );
      if (!isConfirmed) {
        isSaving = false;
        return;
      }
    }

    if (currentPassword !== "" && currentPasswordHash !== lastSavedPasswordHash) {
      const confirmPw = await requestPasswordPrompt(
        window._t("prompt.pw_new"),
      );
      if (confirmPw === null) {
        isSaving = false;
        return;
      }
      if (confirmPw !== currentPassword) {
        showToast(
          window._t("error.pw_mismatch"),
          "⚠️",
          "error",
        );
        isSaving = false;
        return;
      }
    }

    if (currentPassword) {
      data = await encryptData(data, currentPassword);
    }

    const showSaveSuccessFeedback = () => {
      const saveBtn = document.getElementById("btn-save");
      if (saveBtn) {
        const iconSvg = saveBtn.querySelector("svg");
        if (iconSvg && !iconSvg.hasAttribute("data-animating")) {
          iconSvg.setAttribute("data-animating", "true");
          const originalUse = `<use href="#icon-save"></use>`;
          iconSvg.innerHTML = `<use href="#icon-sparkles"></use>`;
          iconSvg.classList.add("text-green-500", "scale-125");
          saveBtn.classList.add("ring-2", "ring-green-500/20", "bg-green-50");

          setTimeout(() => {
            iconSvg.innerHTML = originalUse;
            iconSvg.classList.remove("text-green-500", "scale-125");
            saveBtn.classList.remove(
              "ring-2",
              "ring-green-500/20",
              "bg-green-50",
            );
            iconSvg.removeAttribute("data-animating");
          }, 1500);
        }
      }
    };

    if (isSaveAs || !fileHandle || fileHandle.isDummy) {
      if ("showSaveFilePicker" in window) {
        try {
          fileHandle = await window.showSaveFilePicker({
            suggestedName:
              fileHandle && fileHandle.name
                ? fileHandle.name
                : "Contacts.people",
            types: [
              {
                description: "People Database",
                accept: { "application/x-sqlite3": [".people"] },
              },
            ],
          });
        } catch (err) {
          console.log("Save cancelled.", err);
          return;
        }
      } else {
        const blob = new Blob([data], { type: "application/x-sqlite3" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download =
          fileHandle && fileHandle.name ? fileHandle.name : "Contacts.people";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setDirty(false);
        await clearDraft();
        showToast(
          window._t("toast.downloaded", escapeHtml(a.download)),
          '<span class="text-green-400">💾</span>',
        );
        showSaveSuccessFeedback();
        lastSavedPasswordHash = currentPasswordHash;
        return;
      }
    }

    if (fileHandle && !fileHandle.isDummy) {
      try {
        const permission = await fileHandle.queryPermission({
          mode: "readwrite",
        });
        if (permission !== "granted") {
          const request = await fileHandle.requestPermission({
            mode: "readwrite",
          });
          if (request !== "granted") {
            throw new Error(window._t("error.write_denied"));
          }
        }
      } catch (e) {
        await window.requestCustomPrompt(
          window._t("error.fatal_title"),
          window._t("error.write_permission"),
          "",
          "alert",
        );
        return;
      }
    }

    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    setDirty(false);
    await clearDraft();

    showToast(
      window._t("toast.saved_to", escapeHtml(fileHandle.name)),
      '<span class="text-green-400">💾</span>',
    );
    showSaveSuccessFeedback();
    lastSavedPasswordHash = currentPasswordHash;
  } catch (err) {
    console.error("Save failed:", err);
  } finally {
    isSaving = false;
    if (activeSelector) {
      requestAnimationFrame(() => {
        try {
          const el = document.querySelector(activeSelector);
          if (el) {
            el.focus({ preventScroll: true });
            if (el.hasAttribute("contenteditable")) {
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(el);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch (e) {}
      });
    }
  }
}

// 5. 【核心部】 ファイル読み込みの共通処理
async function processFileHandle(handle, isDummy = false) {
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.innerHTML = `<svg class="w-3 h-3 text-white animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span data-i18n="status.loading_file">${window._t("status.loading_file")}</span>`;
    statusEl.className =
      "flex w-max items-center gap-2 bg-blue-600/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl transition-all duration-300 translate-y-0 opacity-100 pointer-events-auto";
  }

  await new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );

  try {
    const file = await handle.getFile();

    // 巨大ファイルによるOOMクラッシュを防止
    if (file.size > 50 * 1024 * 1024) {
      await window.requestCustomPrompt(
        window._t("error.fatal_title"),
        window._t("error.file_too_large_50"),
        "",
        "alert",
      );
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    let Uints = new Uint8Array(arrayBuffer);

    const magic = Uints.slice(0, 8);
    const magicStr = new TextDecoder().decode(magic);
    const isEncrypted = magicStr === "GRINDENC" || magicStr === "GRINDEN2";

    if (isEncrypted) {
      let password = document.getElementById("file-password").value;
      let success = false;
      let attempt = 0;
      while (!success) {
        try {
          Uints = await decryptData(Uints, password);
          success = true;
          if (password) {
            document.getElementById("file-password").value = password;
            lastSavedPasswordHash = await sha256(password);
          }
        } catch (err) {
          const msg =
            attempt > 0
              ? window._t("prompt.pw_wrong")
              : window._t("prompt.pw_desc");
          password = await requestPasswordPrompt(msg);
          if (password === null) {
            hideStatus();
            return; // キャンセルして処理を中断
          }
          attempt++;
        }
      }
    } else {
      document.getElementById("file-password").value = "";
      lastSavedPasswordHash = "";
    }

    let newDb;
    try {
      newDb = new SQL.Database(Uints);
    } catch (e) {
      throw new Error("Invalid SQLite database file.");
    }

    if (db) {
      db.close();
    }
    db = newDb;
    migrateDatabase();

    loadSettingsFromDb(); // ファイル固有の設定をUIに反映

    // 🎯 ファイル切り替え時のグローバル状態完全リセット（データ汚染防止）
    collapsedBlocks.clear();
    currentActiveTag = null;
    currentDisplayedTotal = 0;

    // UI更新の前にハンドルをセットして正しいファイル名を反映させる
    fileHandle = handle;
    setDirty(false);
    await clearDraft();

    showToast(
      window._t("toast.file_loaded", escapeHtml(file.name)),
      '<span class="text-blue-400">📂</span>',
    );

    renderData();
    hideStatus();
  } catch (err) {
    console.log("Open cancelled or failed.", err);
    showToast(window._t("error.file_load_fail"), "⚠️", "error");
  }
}

// 5.1 「開く」ボタンから File System Access API を使った読み込み
async function loadPeopleFile() {
  if (isDirty) {
    const isConfirmed = await window.requestCustomPrompt(
      window._t("confirm.title"),
      window._t("confirm.discard_changes"),
      "",
      "confirm",
    );
    if (!isConfirmed) {
      return;
    }
  }

  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "People Database",
            accept: {
              "application/x-sqlite3": [".people"],
            },
          },
        ],
        multiple: false,
      });
      await processFileHandle(handle);
    } catch (err) {
      console.log("Open picker cancelled.", err);
    }
  } else {
    // Safari / Firefox 等のフォールバック (input type="file" を使う)
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".people,*/*";
    input.style.display = "none"; // 💡 画面に見えないようにする

    input.onchange = async (e) => {
      const file = e.target.files[0];
      document.body.removeChild(input); // 💡 処理が終わったらDOMから削除
      if (!file) return;

      // ダミーハンドルを作って共通処理へ流す
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    };

    // 💡 DOMに追加してからクリックしないとSafariで無視される
    document.body.appendChild(input);
    input.click();
  }
}

// エクスポートモーダルの制御
function showExportModal() {
  const modal = document.getElementById("export-modal");

  // 現在の抽出対象期間をモーダルに表示する
  const infoEl = document.getElementById("export-period-info");
  if (infoEl) {
    let periodText = currentActiveTag
      ? window._t("export.period_tag", currentActiveTag)
      : window._t("export.period_all");
    infoEl.innerHTML = window._t("export.period_info", periodText);
  }

  const lastFormat = localStorage.getItem("lastExportFormat");
  if (lastFormat) {
    const selectEl = document.getElementById("export-format");
    if (selectEl && selectEl.querySelector(`option[value="${lastFormat}"]`)) {
      selectEl.value = lastFormat;
    }
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  toggleMainUI(true);
}

function closeExportModal() {
  const modal = document.getElementById("export-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  toggleMainUI(false);
}

function executeExport() {
  const format = document.getElementById("export-format").value;
  localStorage.setItem("lastExportFormat", format);
  closeExportModal();
  exportCSV(format);
}

// 6. CSVエクスポート
function exportCSV(format = "vcard") {
  if (!db) return;

  if (format === "vcard") {
    exportVCard();
  } else if (format === "google_csv") {
    exportPlatformCSV("google");
  } else if (format === "outlook_csv") {
    exportPlatformCSV("outlook");
  } else {
    showToast(
      window._t("error.unsupported_format"),
      "⚠️",
      "error",
    );
  }
}

// --- vCard 生成の共通クレンジングロジック ---
function generateVCardData(items) {
  let vcardData = "";
  items.forEach((item) => {
    const rawName = item.name || "";
    const role = item.role || "";
    const contactInfo = item.contact_info || "";
    const org = item.org || "";

    // 最強のクレンジング機能: ハッシュタグ(#幹事 など)を氏名や組織名から除去
    let cleanName = rawName
      .replace(/[#＃][^\s　,、。\.・()（）「」]+/g, "")
      .trim();
    let cleanOrg = org.replace(/[#＃][^\s　,、。\.・()（）「」]+/g, "").trim();
    let cleanRole = role || "";
    let cleanContact = contactInfo || "";

    // vCardフォーマット破壊を防ぐため、すべての値から改行を除去
    cleanName = cleanName.replace(/[\r\n]+/g, " ").replace(/([;,])/g, "\\$1");
    cleanOrg = cleanOrg.replace(/[\r\n]+/g, " ").replace(/([;,])/g, "\\$1");
    cleanRole = cleanRole.replace(/[\r\n]+/g, " ").replace(/([;,])/g, "\\$1");
    cleanContact = cleanContact
      .replace(/[\r\n]+/g, " ")
      .replace(/([;,])/g, "\\$1");

    if (!cleanName) {
      if (cleanOrg) {
        cleanName = window._t("export.member_of", cleanOrg);
      } else {
        cleanName = window._t("export.unnamed");
      }
    }

    // 両方のフィールドのタグをマージして出力
    const itemMemoTags = (
      rawName.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
    ).map((t) => t.replace(/[#＃]/, ""));
    const orgMemoTags = (
      org.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
    ).map((t) => t.replace(/[#＃]/, ""));
    const itemFieldTags = (item.item_tags || "")
      .split(/[,、\s]+/)
      .map((t) => t.trim().replace(/^[#＃]/, ""))
      .filter(Boolean);
    const orgFieldTags = (item.org_tags || "")
      .split(/[,、\s]+/)
      .map((t) => t.trim().replace(/^[#＃]/, ""))
      .filter(Boolean);

    const allTags = [
      ...new Set([
        ...itemMemoTags,
        ...orgMemoTags,
        ...itemFieldTags,
        ...orgFieldTags,
      ]),
    ];

    const fields = item.fields || [];
    let fName = "",
      gName = "",
      mName = "",
      prefix = "",
      suffix = "";
    let fYomi = "",
      gYomi = "",
      nickname = "",
      company = "",
      dept = "";

    fields.forEach((f) => {
      if (!f.field_value) return;
      const v = f.field_value;
      if (f.field_key === "family_name") fName = v;
      if (f.field_key === "given_name") gName = v;
      if (f.field_key === "middle_name") mName = v;
      if (f.field_key === "name_prefix") prefix = v;
      if (f.field_key === "name_suffix") suffix = v;
      if (f.field_key === "family_name_yomi") fYomi = v;
      if (f.field_key === "given_name_yomi") gYomi = v;
      if (f.field_key === "nickname") nickname = v;
      if (f.field_key === "company") company = v;
      if (f.field_key === "department") dept = v;
    });

    const nProp =
      fName || gName
        ? `${fName};${gName};${mName};${prefix};${suffix}`
        : `${cleanName};;;;`;

    const finalOrg = company || cleanOrg;

    vcardData += "BEGIN:VCARD\r\n";
    vcardData += "VERSION:3.0\r\n";
    vcardData += `FN:${cleanName}\r\n`;
    if (cleanOrg) vcardData += `ORG:${cleanOrg}\r\n`;
    vcardData += `N:${nProp}\r\n`;

    if (fYomi || gYomi) {
      vcardData += `X-PHONETIC-FIRST-NAME:${gYomi}\r\n`;
      vcardData += `X-PHONETIC-LAST-NAME:${fYomi}\r\n`;
    }
    if (nickname) vcardData += `NICKNAME:${nickname}\r\n`;
    if (finalOrg || dept) vcardData += `ORG:${finalOrg || ""};${dept}\r\n`;
    if (cleanRole) vcardData += `TITLE:${cleanRole}\r\n`;

    // ★ OSの連絡先に自動でグループ分けさせるマジック
    if (allTags.length > 0) {
      vcardData += `CATEGORIES:${allTags.join(",")}\r\n`;
    }

    if (fields.length > 0) {
      let addresses = {};
      fields.forEach((f) => {
        if (!f.field_value) return;
        let v = f.field_value;
        // Prevent format corruption by removing newlines from fields (except notes)
        if (f.field_key !== "note") {
          v = v.replace(/[\r\n]+/g, " ");
        }
        const t = (f.field_type || "other").toUpperCase();

        switch (f.field_key) {
          case "email":
            vcardData += `EMAIL;TYPE=INTERNET,${t}:${v}\r\n`;
            break;
          case "phone":
            let telType = "CELL";
            if (t === "WORK") telType = "WORK";
            else if (t === "HOME") telType = "HOME";
            else if (t === "FAX_WORK") telType = "FAX,WORK";
            else if (t === "FAX_HOME") telType = "FAX,HOME";
            else if (t === "MAIN") telType = "MAIN";
            vcardData += `TEL;TYPE=${telType}:${v}\r\n`;
            break;
          case "url":
            vcardData += `URL:${v}\r\n`;
            break;
          case "note":
            // vCard Injection and other control character sanitization
            const sanitizedV = v
              .replace(/BEGIN:/gi, '(BEGIN):')
              .replace(/END:/gi, '(END):');
            const escapedV = sanitizedV
              .replace(/\\/g, '\\\\')
              .replace(/,/g, '\\,')
              .replace(/;/g, '\\;')
              .replace(/\r?\n/g, "\\n");
            vcardData += `NOTE:${escapedV}\r\n`;
            break;
          case "birthday":
            vcardData += `BDAY:${v}\r\n`;
            break;
          case "social_x":
          case "social_facebook":
          case "social_instagram":
          case "social_line":
            let socialType = f.field_key.replace("social_", "");
            if (socialType === "x") socialType = "twitter"; // Apple Contacts App compatibility
            vcardData += `X-SOCIALPROFILE;type=${socialType}:${v}\r\n`;
            break;
          default:
            if (f.field_key.startsWith("addr_")) {
              const addrType = f.field_type || "home";
              if (!addresses[addrType]) addresses[addrType] = {};
              addresses[addrType][f.field_key] = v;
            }
            break;
        }
      });
      Object.keys(addresses).forEach((type) => {
        const a = addresses[type];
        const street = a.addr_street || "";
        const city = a.addr_city || "";
        const region = a.addr_region || "";
        const postal = a.addr_postal || "";
        const country = a.addr_country || "";
        const adrType = type.toUpperCase() === "WORK" ? "WORK" : "HOME";
        if (street || city || region || postal || country) {
          vcardData += `ADR;TYPE=${adrType}:;;${street};${city};${region};${postal};${country}\r\n`;
        }
      });
    } else {
      if (cleanContact.toString().includes("@")) {
        vcardData += `EMAIL;TYPE=INTERNET:${cleanContact}\r\n`;
      } else if (cleanContact) {
        vcardData += `TEL;TYPE=CELL:${cleanContact}\r\n`;
      }
    }

    vcardData += "END:VCARD\r\n";
  });
  return vcardData;
}

function triggerVCardDownload(vcardData, filenameBase) {
  const blob = new Blob([vcardData], {
    type: "text/vcard;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const hh = String(today.getHours()).padStart(2, "0");
  const min = String(today.getMinutes()).padStart(2, "0");
  const sec = String(today.getSeconds()).padStart(2, "0");
  const dateSuffix = `${yyyy}${mm}${dd}_${hh}${min}${sec}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}_${dateSuffix}.vcf`;
  a.click();
  URL.revokeObjectURL(url);
}

// 6.5 全件vCardエクスポート
function exportVCard() {
  if (!db) return;

  // c.id, memo=氏名, role=役割, contact_info=電話・Email, parent.memo=会社・チーム名, タグ情報
  let query = `SELECT c.id AS id, c.memo AS name, c.role AS role, c.contact_info AS contact_info, p.memo AS organization, c.tags AS item_tags, p.tags AS org_tags FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC`;

  const values = [];
  let exportStmt;
  try {
    exportStmt = db.prepare(query);
    while (exportStmt.step()) {
      values.push(exportStmt.get());
    }
  } finally {
    if (exportStmt) exportStmt.free();
  }

  if (values.length === 0) {
    showToast(window._t("toast.no_export_data"), "⚠️", "warning");
    return;
  }

  const items = values.map((row) => ({
    id: row[0],
    name: row[1],
    role: row[2],
    contact_info: row[3],
    org: row[4],
    item_tags: row[5],
    org_tags: row[6],
    fields: getContactFields(row[0]),
  }));

  let filteredItems = items;
  if (currentActiveTag) {
    const activeTagRaw = currentActiveTag.replace(/^[#＃]/, "");
    filteredItems = items.filter((item) => {
      const itemMemoTags = (
        (item.name || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
      ).map((t) => t.replace(/[#＃]/, ""));
      const orgMemoTags = (
        (item.org || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
      ).map((t) => t.replace(/[#＃]/, ""));
      const itemFieldTags = (item.item_tags || "")
        .split(/[,、\s]+/)
        .map((t) => t.trim().replace(/^[#＃]/, ""))
        .filter(Boolean);
      const orgFieldTags = (item.org_tags || "")
        .split(/[,、\s]+/)
        .map((t) => t.trim().replace(/^[#＃]/, ""))
        .filter(Boolean);
      const allTags = [
        ...new Set([
          ...itemMemoTags,
          ...orgMemoTags,
          ...itemFieldTags,
          ...orgFieldTags,
        ]),
      ];
      return allTags.includes(activeTagRaw);
    });
  }

  if (filteredItems.length === 0) {
    showToast(window._t("toast.no_export_data"), "⚠️", "warning");
    return;
  }

  const vcardData = generateVCardData(filteredItems);
  triggerVCardDownload(vcardData, "contacts_all");
}

// 特定のタグだけのメンバーをエクスポート
async function exportTagVCard(tag, dataItems) {
  if (!dataItems || dataItems.length === 0) return;
  const isConfirmed = await window.requestCustomPrompt(
    window._t("confirm.export_tag_title"),
    window._t("confirm.export_tag_desc", [tag, dataItems.length]),
    "",
    "confirm",
  );
  if (!isConfirmed) return;

  // 各アイテムに詳細フィールドを付与
  const enrichedItems = dataItems.map((item) => ({
    ...item,
    fields: getContactFields(item.id),
  }));

  const vcardData = generateVCardData(enrichedItems);
  const safeTag = tag.replace(/[\\/:*?"<>|#＃\r\n]/g, "_"); // OSでファイル名に使えない禁則文字のみを除去
  triggerVCardDownload(vcardData, `contacts_${safeTag}`);
}

// 7. CSVインポート
async function importCSV(event) {
  const file = event.target.files[0];
  const inputElement = event.target; // 同期的に退避させておく
  if (!file) return;

  // 5MB (5 * 1024 * 1024 bytes) を超える場合は警告してクラッシュを防ぐ
  if (file.size > 5242880) {
    await window.requestCustomPrompt(
      window._t("error.fatal_title"),
      window._t("error.file_too_large_5"),
      "",
      "alert",
    );
    inputElement.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    pendingCSVBuffer = e.target.result; // ArrayBufferを保存
    showCSVModal();
    inputElement.value = "";
  };
  reader.onerror = function () {
    showToast(
      window._t("error.file_read_fail"),
      "⚠️",
      "error",
    );
    inputElement.value = "";
  };
  reader.readAsArrayBuffer(file); // ArrayBufferとして読み込む
}

// CSVマッピングモーダルを表示
function showCSVModal() {
  const modal = document.getElementById("csv-mapping-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  toggleMainUI(true);
  updateCSVPreview(); // プレビューとマッピングを初期描画

  setTimeout(() => {
    const firstInput = document.getElementById("map-date");
    if (firstInput) firstInput.focus();
  }, 100);
}

// CSVプレビューとマッピングを更新する (文字コード変更時にも呼ばれる)
function updateCSVPreview() {
  if (!pendingCSVBuffer) return;

  const encoding = document.getElementById("csv-encoding").value;
  const previewBody = document.getElementById("csv-preview-body");

  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    const text = decoder.decode(pendingCSVBuffer);

    pendingCSVData = []; // グローバル変数を更新
    let currentLine = [];
    let inQuotes = false;
    let cellStart = 0;
    let hasEscapedQuote = false;

    const extractCSVCell = (str, start, end, hasEscaped) => {
      let cell = str.substring(start, end);
      if (cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"')) {
        cell = cell.substring(1, cell.length - 1);
      }
      if (hasEscaped) {
        cell = cell.replace(/""/g, '"');
      }
      return cell;
    };

    if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
      cellStart = 1;
    }

    for (let i = cellStart; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"' && nextChar === '"') {
        hasEscapedQuote = true;
        i++; // エスケープされたクオートをスキップ
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        currentLine.push(extractCSVCell(text, cellStart, i, hasEscapedQuote));
        cellStart = i + 1;
        hasEscapedQuote = false;
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        let lineEnd = i;
        if (char === "\r" && nextChar === "\n") i++; // \r\n の対応

        currentLine.push(
          extractCSVCell(text, cellStart, lineEnd, hasEscapedQuote),
        );
        pendingCSVData.push(currentLine);
        currentLine = [];
        cellStart = i + 1;
        hasEscapedQuote = false;
      }
    }

    // 最後のセルをプッシュ
    if (cellStart <= text.length) {
      currentLine.push(
        extractCSVCell(text, cellStart, text.length, hasEscapedQuote),
      );
      pendingCSVData.push(currentLine);
    }

    // 最終行の空行を無視
    if (
      pendingCSVData.length > 0 &&
      pendingCSVData[pendingCSVData.length - 1].length === 1 &&
      pendingCSVData[pendingCSVData.length - 1][0].trim() === ""
    ) {
      pendingCSVData.pop();
    }
  } catch (e) {
    pendingCSVData = []; // エラー時はデータをクリア
    const unselectedHtml = `<option value="-1">${window._t("label.unselected")}</option>`;
    document.getElementById("map-date").innerHTML = unselectedHtml;
    if (document.getElementById("map-role"))
      document.getElementById("map-role").innerHTML = unselectedHtml;
    document.getElementById("map-memo").innerHTML = unselectedHtml;
    document.getElementById("map-contact").innerHTML = unselectedHtml;
    const previewHead = document.getElementById("csv-preview-head");
    if (previewHead) previewHead.innerHTML = "";
    previewBody.innerHTML = `<tr><td colspan="99" class="p-4 text-center text-red-500">${window._t("error.decode_fail", escapeHtml(encoding))}</td></tr>`;
    return;
  }

  // --- UI更新 ---
  const mapDate = document.getElementById("map-date");
  const mapRole = document.getElementById("map-role");
  const mapMemo = document.getElementById("map-memo");
  const mapContact = document.getElementById("map-contact");

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );
  const firstRow = pendingCSVData.length > 0 ? pendingCSVData[0] : [];

  let optionsHtml = `<option value="-1">${window._t("label.unselected")}</option>`;
  for (let i = 0; i < maxCols; i++) {
    const sample =
      firstRow[i] !== undefined ? firstRow[i].substring(0, 15) : "";
    optionsHtml += `<option value="${i}">${window._t("label.column")} ${i + 1} (${escapeHtml(sample)})</option>`;
  }

  const oldVals = {
    date: mapDate.value,
    role: mapRole ? mapRole.value : "-1",
    memo: mapMemo.value,
    contact: mapContact.value,
  };
  mapDate.innerHTML = optionsHtml;
  if (mapRole) mapRole.innerHTML = optionsHtml;
  mapMemo.innerHTML = optionsHtml;
  mapContact.innerHTML = optionsHtml;
  mapDate.value = oldVals.date;
  if (mapRole) mapRole.value = oldVals.role;
  mapMemo.value = oldVals.memo;
  mapContact.value = oldVals.contact;

  // 日付と役割は任意なので、列数が多くても勝手に割り当てない
  if (mapMemo.selectedIndex < 1 && maxCols >= 1) mapMemo.value = "0"; // 1列目は名前にしておくのが王道
  if (mapContact.selectedIndex < 1 && maxCols >= 2) mapContact.value = "1"; // 2列目を連絡先に

  renderCSVPreview();
}

function renderCSVPreview() {
  const previewHead = document.getElementById("csv-preview-head");
  const previewBody = document.getElementById("csv-preview-body");
  if (!previewHead || !previewBody || pendingCSVData.length === 0) return;

  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapRole = document.getElementById("map-role")
    ? parseInt(document.getElementById("map-role").value, 10)
    : -1;
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapContact = parseInt(document.getElementById("map-contact").value, 10);

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );

  // ヘッダーの構築
  let thHtml = `<th class="px-3 py-2 w-8 text-center border-r border-gray-200">${window._t("label.row")}</th>`;
  for (let i = 0; i < maxCols; i++) {
    let label = "";
    let badgeClass = "bg-slate-200 text-slate-500";
    if (i === mapDate) {
      label = window._t("label.date");
      badgeClass = "bg-blue-100 text-blue-700";
    } else if (i === mapRole) {
      label = window._t("label.role_title");
      badgeClass = "bg-purple-100 text-purple-700";
    } else if (i === mapMemo) {
      label = window._t("label.memo");
      badgeClass = "bg-green-100 text-green-700";
    } else if (i === mapContact) {
      label = window._t("label.contact");
      badgeClass = "bg-orange-100 text-orange-700";
    }

    if (label) {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">${label}</span></th>`;
    } else {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-medium ${badgeClass}">${window._t("label.column")} ${i + 1}</span></th>`;
    }
  }
  previewHead.innerHTML = `<tr>${thHtml}</tr>`;

  // プレビューの構築 (安全のためHTMLエスケープを行う)
  previewBody.innerHTML = "";
  const skipRowsInput = document.getElementById("csv-skip-rows");
  const skipRows = skipRowsInput
    ? Math.max(0, parseInt(skipRowsInput.value, 10) || 0)
    : 0;
  const previewRows = pendingCSVData.slice(skipRows, skipRows + 4); // スキップ行を考慮して最初の4行をプレビュー
  previewRows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.className = rowIndex === 0 ? "bg-slate-50" : "bg-white";
    let tdHtml = `<td class="px-3 py-2 font-bold text-slate-400 border-r border-slate-200 w-8 text-center">${skipRows + rowIndex + 1}</td>`;
    for (let i = 0; i < maxCols; i++) {
      const val = row[i] !== undefined ? row[i] : "";
      // 長すぎる文字列は省略して表示し、title属性で全文を確認できるようにする
      const displayVal = val.length > 20 ? val.substring(0, 20) + "..." : val;

      // マッピングされている列はハイライト
      let highlightClass = "";
      if (i === mapDate || i === mapRole || i === mapMemo || i === mapContact) {
        highlightClass = "text-slate-900 font-medium bg-slate-50/50";
      }

      tdHtml += `<td class="px-3 py-2 truncate max-w-[150px] ${highlightClass}" title="${escapeHtml(val)}">${escapeHtml(displayVal)}</td>`;
    }
    tr.innerHTML = tdHtml;
    previewBody.appendChild(tr);
  });
}

function closeCSVModal() {
  const modal = document.getElementById("csv-mapping-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  toggleMainUI(false);
  pendingCSVData = [];
  pendingCSVBuffer = null;
}

async function executeCSVImport() {
  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapRoleEl = document.getElementById("map-role");
  const mapRole = mapRoleEl ? parseInt(mapRoleEl.value, 10) : -1;
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapContact = parseInt(document.getElementById("map-contact").value, 10);
  const skipRows =
    parseInt(document.getElementById("csv-skip-rows").value, 10) || 0;

  if (mapMemo === -1 && mapContact === -1) {
    showToast(
      window._t("error.select_column"),
      "⚠️",
      "warning",
    );
    return;
  }

  // モーダルを閉じると pendingCSVData がクリアされてしまうため、退避しておく
  const dataToImport = [...pendingCSVData];

  closeCSVModal();

  let successCount = 0;
  let skipCount = 0;
  let suggestStmt = null;
  let insertStmt = null;
  let checkStmt = null;

  const startIndex = Math.max(0, skipRows);
  const MAX_IMPORT_ROWS = 3000;
  const rowsToProcess = dataToImport.length - startIndex;

  if (rowsToProcess > MAX_IMPORT_ROWS) {
    await window.requestCustomPrompt(
      window._t("error.warning_title"),
      window._t("alert.too_many_rows", [rowsToProcess, MAX_IMPORT_ROWS]),
      "",
      "alert",
    );
  }
  const endIndex = Math.min(
    dataToImport.length,
    startIndex + MAX_IMPORT_ROWS,
  );

  db.run("BEGIN TRANSACTION;");
  try {
    db.run("INSERT INTO records (memo, contact_info) VALUES (?, ?)", [
      window._t("label.csv_import"),
      null,
    ]);
    const parentRes = db.exec("SELECT last_insert_rowid()");
    const parentId = parentRes[0]?.values?.[0]?.[0];
    if (!parentId) throw new Error("親IDの取得に失敗しました");

    try {
      suggestStmt = db.prepare(
        "SELECT role FROM records WHERE parent_id IS NOT NULL AND memo = ? AND role IS NOT NULL AND role != '' ORDER BY id DESC LIMIT 1",
      );
    } catch (e) {
      console.warn("役職サジェストSQLの準備に失敗しました", e);
    }

    try {
      insertStmt = db.prepare(
        "INSERT INTO records (parent_id, memo, contact_info, created_at, role) VALUES (?, ?, ?, ?, ?)",
      );
      checkStmt = db.prepare(
        "SELECT 1 FROM records WHERE memo = ? AND IFNULL(contact_info, '') = IFNULL(?, '') LIMIT 1",
      );
    } catch (e) {
      console.warn("インポート用SQLの準備に失敗しました", e);
    }

    for (let i = startIndex; i < endIndex; i++) {
      const cols = dataToImport[i];
      if (cols.length === 0 || cols.every((c) => c === undefined || c === null || !c.toString().trim())) continue;

      const dateStr =
        mapDate !== -1 && cols[mapDate] !== undefined
          ? cols[mapDate].trim()
          : "";
      const roleStr =
        mapRole !== -1 && cols[mapRole] !== undefined
          ? cols[mapRole].trim()
          : "";
      const memo =
        mapMemo !== -1 && cols[mapMemo] !== undefined
          ? cols[mapMemo].trim()
          : "";
      const contactInfo =
        mapContact !== -1 && cols[mapContact] !== undefined
          ? cols[mapContact].trim()
          : "";

      // 氏名(memo) か 連絡先(contactInfo) のいずれかが入力されていればOK
      if (memo !== "" || contactInfo !== "") {
        if (checkStmt) {
          checkStmt.bind([memo, contactInfo]);
          if (checkStmt.step()) {
            checkStmt.reset();
            skipCount++;
            continue; // 重複しているのでスキップ！
          }
          checkStmt.reset();
        }

        let parsedDate = new Date(dateStr);
        // 💡 修正: 時刻付きデータでSafariがクラッシュするのを防ぐため、日付部分のみを抽出
        const dateMatch = dateStr ? dateStr.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) : null;
        if (dateMatch) {
          parsedDate = new Date(
            parseInt(dateMatch[1], 10),
            parseInt(dateMatch[2], 10) - 1,
            parseInt(dateMatch[3], 10),
          );
        }

        let finalRoleStr = roleStr;
        if (!finalRoleStr && memo && suggestStmt) {
          try {
            suggestStmt.bind([memo]);
            if (suggestStmt.step()) finalRoleStr = suggestStmt.get()[0];
          } catch (e) {
          } finally {
            suggestStmt.reset();
          }
        }

        let finalDateStr = "";
        if (dateStr && !isNaN(parsedDate.getTime())) {
          // タイムゾーンによる日付のズレを防ぐため、ローカル時間のまま手動で文字列化
          const yyyy = parsedDate.getFullYear();
          const mm = String(parsedDate.getMonth() + 1).padStart(2, "0");
          const dd = String(parsedDate.getDate()).padStart(2, "0");
          finalDateStr = `${yyyy}-${mm}-${dd} 00:00:00`;
        } else {
          const today = new Date();
          finalDateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
        }

        if (insertStmt) {
          try {
            insertStmt.run([
              parentId,
              memo,
              contactInfo,
              finalDateStr,
              finalRoleStr,
            ]);
            successCount++;
          } catch (e) {
            console.warn(e);
          }
        }
      }
    }

    if (successCount === 0) {
      db.run("DELETE FROM records WHERE id = ?", [parentId]);
    }

    db.run("COMMIT;");
    setDirty(true);

    // インポートしたブロックは初期状態で折りたたんでおく（見やすさへの配慮）
    collapsedBlocks.add(parentId);

    // インポートしたデータが見えなくなるのを防ぐため、フィルターを解除
    currentActiveTag = null;

    const msg =
      window._t("toast.import", successCount) +
      (skipCount > 0 ? window._t("toast.skipped_dup", skipCount) : "");
    showToast(msg, '<span class="text-green-400">✨</span>');
  } catch (err) {
    db.run("ROLLBACK;");
    showToast(window._t("error.import_fail"), "⚠️", "error");
    console.error(err);
  } finally {
    if (suggestStmt) suggestStmt.free();
    if (insertStmt) insertStmt.free();
    if (checkStmt) checkStmt.free();
  }
  renderData();
}

// 8. AI連携用のプロンプトコピー機能 (BYO-AIアプローチ)
function copyAIPrompt() {
  const promptText = window._t("prompt.ai_format");

  navigator.clipboard
    .writeText(promptText)
    .then(() => {
      showToast(window._t("toast.prompt_copied"), "📋");
    })
    .catch((err) => {
      console.error("コピーに失敗しました", err);
    });
}

// 8.5 データ一覧を Markdown 形式でコピーする機能
function copyAsMarkdown() {
  if (!db) return;
  const res = db.exec(
    "SELECT c.memo, p.memo, c.role, c.contact_info, c.tags, p.tags FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC",
  );
  if (res.length === 0) {
    showToast(window._t("toast.no_copy_data"), "⚠️", "warning");
    return;
  }

  let md = window._t("export.md_title");
  let count = 0;
  res[0].values.forEach(([name, org, role, contact, itemTags, orgTags]) => {
    if (currentActiveTag) {
      const activeTagRaw = currentActiveTag.replace(/^[#＃]/, "");
      const itemMemoTags = ((name || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []).map((t) => t.replace(/[#＃]/, ""));
      const orgMemoTags = ((org || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []).map((t) => t.replace(/[#＃]/, ""));
      const itemFieldTags = (itemTags || "").split(/[,、\s]+/).map((t) => t.trim().replace(/^[#＃]/, "")).filter(Boolean);
      const orgFieldTags = (orgTags || "").split(/[,、\s]+/).map((t) => t.trim().replace(/^[#＃]/, "")).filter(Boolean);
      const allTags = [...new Set([...itemMemoTags, ...orgMemoTags, ...itemFieldTags, ...orgFieldTags])];

      if (!allTags.includes(activeTagRaw)) return;
    }

    md += `- **${name || window._t("export.unnamed")}** (${org} / ${role || window._t("label.no_role")}) - ${contact || window._t("label.no_contact")}\n`;
    count++;
  });

  if (count === 0) {
    showToast(window._t("toast.no_copy_data"), "⚠️", "warning");
    return;
  }

  navigator.clipboard
    .writeText(md)
    .then(() => {
      showToast(window._t("toast.md_copied"), "📋");
    })
    .catch((err) => console.error("コピーに失敗しました", err));
}

// --- 連絡先詳細編集モーダル ---
const DETAIL_FIELD_MAP = {
  "detail-family-name": "family_name",
  "detail-given-name": "given_name",
  "detail-family-yomi": "family_name_yomi",
  "detail-given-yomi": "given_name_yomi",
  "detail-nickname": "nickname",
  "detail-company": "company",
  "detail-department": "department",
  "detail-job-title": "job_title",
  "detail-addr-postal": "addr_postal",
  "detail-addr-region": "addr_region",
  "detail-addr-street": "addr_street",
  "detail-addr-country": "addr_country",
  "detail-social-line": "social_line",
  "detail-social-x": "social_x",
  "detail-social-ig": "social_instagram",
  "detail-url": "url",
  "detail-birthday": "birthday",
  "detail-note": "note",
};

function showContactDetail(recordId) {
  preDetailActiveElement = document.activeElement;
  const modal = document.getElementById("contact-detail-modal");
  document.getElementById("detail-record-id").value = recordId;

  // タイトルに名前を表示
  let name = "";
  let stmt;
  try {
    stmt = db.prepare("SELECT memo FROM records WHERE id = ?");
    stmt.bind([recordId]);
    if (stmt.step()) name = stmt.get()[0] || "";
  } finally {
    if (stmt) stmt.free();
  }
  document.getElementById("detail-modal-title").textContent =
    name || window._t("detail.title");

  let orgName = "";
  try {
    let pStmt = db.prepare(
      "SELECT p.memo FROM records c JOIN records p ON c.parent_id = p.id WHERE c.id = ?",
    );
    pStmt.bind([recordId]);
    if (pStmt.step()) orgName = pStmt.get()[0] || "";
    pStmt.free();
  } catch (e) {}

  const companyInput = document.getElementById("detail-company");
  if (companyInput) {
    companyInput.placeholder = orgName ? window._t("placeholder.auto_org", orgName) : window._t("placeholder.company");
  }

  const fields = getContactFields(recordId);

  // 単一フィールドをセット
  for (const [elId, fieldKey] of Object.entries(DETAIL_FIELD_MAP)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const f = fields.find((f) => f.field_key === fieldKey);
    if (el.tagName === "TEXTAREA") el.value = f?.field_value || "";
    else el.value = f?.field_value || "";
  }

  // records テーブルのメインデータ（一覧で入力したもの）を取得
  let mainContactInfo = "";
  let mainRole = "";
  let stmtSync;
  try {
    stmtSync = db.prepare(
      "SELECT contact_info, role FROM records WHERE id = ?",
    );
    stmtSync.bind([recordId]);
    if (stmtSync.step()) {
      const row = stmtSync.get();
      mainContactInfo = row[0] || "";
      mainRole = row[1] || "";
    }
  } finally {
    if (stmtSync) stmtSync.free();
  }

  // 役割/役職の同期
  const roleEl = document.getElementById("detail-job-title");
  if (!roleEl.value && mainRole) {
    roleEl.value = mainRole;
  }

  const fNameEl = document.getElementById("detail-family-name");
  const gNameEl = document.getElementById("detail-given-name");

  // 姓も名も空欄で、かつメインの名前(records.memo)が存在する場合のみ自動分割
  if (!fNameEl.value && !gNameEl.value && name) {
    const parts = name.trim().split(/[\s　]+/); // 半角・全角スペースで分割
    if (parts.length > 1) {
      fNameEl.value = parts[0];
      gNameEl.value = parts.slice(1).join(" ");
    } else {
      fNameEl.value = name; // スペースが無ければ姓に全振り
    }
  }

  // 電話番号の複数行を構築
  const phonesContainer = document.getElementById("detail-phones");
  phonesContainer.innerHTML = "";
  const phones = fields.filter((f) => f.field_key === "phone");
  const emails = fields.filter((f) => f.field_key === "email");

  // 連絡先の同期 (詳細にデータが1つも無い場合、メインのデータを自動分類してセット)
  if (phones.length === 0 && emails.length === 0 && mainContactInfo) {
    if (mainContactInfo.includes("@")) {
      emails.push({ field_value: mainContactInfo, field_type: "work" });
    } else {
      phones.push({ field_value: mainContactInfo, field_type: "mobile" });
    }
  }

  if (phones.length === 0)
    addDetailPhoneRow("", "mobile", false); // 最低1行
  else phones.forEach((p) => addDetailPhoneRow(p.field_value, p.field_type, false));

  // メールの複数行を構築
  const emailsContainer = document.getElementById("detail-emails");
  emailsContainer.innerHTML = "";
  if (emails.length === 0) addDetailEmailRow("", "work", false);
  else emails.forEach((e) => addDetailEmailRow(e.field_value, e.field_type, false));

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  toggleMainUI(true);

  setTimeout(() => {
    const firstInput = document.getElementById("detail-family-name");
    if (firstInput) firstInput.focus();
  }, 100);

  originalDetailDataSnapshot = JSON.stringify(getDetailFormData());
}

function getDetailFormData() {
  const data = [];
  const elements = document.querySelectorAll("#contact-detail-modal input, #contact-detail-modal select, #contact-detail-modal textarea");
  for (const el of elements) {
    data.push(el.value);
  }
  return data;
}

async function closeContactDetail(checkChanges = true) {
  if (checkChanges) {
    const currentDataSnapshot = JSON.stringify(getDetailFormData());
    if (originalDetailDataSnapshot && originalDetailDataSnapshot !== currentDataSnapshot) {
      const isConfirmed = await window.requestCustomPrompt(
        window._t("confirm.title"),
        window._t("alert.unsaved_changes"),
        "",
        "confirm"
      );
      if (!isConfirmed) return; // キャンセルされたら閉じない
    }
  }

  const modal = document.getElementById("contact-detail-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  toggleMainUI(false);
  if (preDetailActiveElement) {
    preDetailActiveElement.focus();
    preDetailActiveElement = null;
  }
}

function addDetailPhoneRow(value = "", type = "mobile", autoFocus = true) {
  const container = document.getElementById("detail-phones");
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <select class="detail-phone-type bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-700 dark:text-slate-300 rounded px-2 py-1.5 text-xs outline-none w-20 shrink-0">
      <option value="mobile" ${type === "mobile" ? "selected" : ""}>${window._t("opt.mobile")}</option>
      <option value="work" ${type === "work" ? "selected" : ""}>${window._t("opt.work")}</option>
      <option value="home" ${type === "home" ? "selected" : ""}>${window._t("opt.home")}</option>
      <option value="other" ${type === "other" ? "selected" : ""}>${window._t("opt.other")}</option>
    </select>
    <input type="tel" value="${escapeHtml(value)}" placeholder="${window._t("placeholder.phone_sample")}" class="detail-phone-value flex-1 bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-900 dark:text-white rounded px-2.5 py-1.5 text-sm outline-none focus:border-primary">
    <button type="button" onclick="this.parentElement.remove()" class="text-slate-300 hover:text-red-500 text-lg leading-none cursor-pointer">&times;</button>
  `;
  container.appendChild(row);

  if (autoFocus) {
    requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const input = row.querySelector('input');
      if (input) input.focus();
    });
  }
}

function addDetailEmailRow(value = "", type = "work", autoFocus = true) {
  const container = document.getElementById("detail-emails");
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <select class="detail-email-type bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-700 dark:text-slate-300 rounded px-2 py-1.5 text-xs outline-none w-20 shrink-0">
      <option value="work" ${type === "work" ? "selected" : ""}>${window._t("opt.work2")}</option>
      <option value="home" ${type === "home" ? "selected" : ""}>${window._t("opt.personal")}</option>
      <option value="other" ${type === "other" ? "selected" : ""}>${window._t("opt.other")}</option>
    </select>
    <input type="email" value="${escapeHtml(value)}" placeholder="${window._t("placeholder.email_sample")}" class="detail-email-value flex-1 bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-900 dark:text-white rounded px-2.5 py-1.5 text-sm outline-none focus:border-primary">
    <button type="button" onclick="this.parentElement.remove()" class="text-slate-300 hover:text-red-500 text-lg leading-none cursor-pointer">&times;</button>
  `;
  container.appendChild(row);

  if (autoFocus) {
    requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const input = row.querySelector('input');
      if (input) input.focus();
    });
  }
}

function saveContactDetail() {
  const currentDataSnapshot = JSON.stringify(getDetailFormData());
  if (originalDetailDataSnapshot === currentDataSnapshot) {
    closeContactDetail();
    return;
  }

  const recordId = parseInt(
    document.getElementById("detail-record-id").value,
    10,
  );
  if (!recordId || !db) return;

  // 💡 修正: 既存のフィールドを全削除するのではなく、モーダルで扱う項目のみを削除対象にし、未知の拡張データを保護する
  const targetKeys = [...Object.values(DETAIL_FIELD_MAP), "phone", "email"];
  const placeholders = targetKeys.map(() => "?").join(",");
  try {
    db.run(`DELETE FROM contact_fields WHERE record_id = ? AND field_key IN (${placeholders})`, [recordId, ...targetKeys]);
  } catch (e) {
    console.error("Failed to delete specific contact fields:", e);
  }

  // 単一フィールドを保存
  for (const [elId, fieldKey] of Object.entries(DETAIL_FIELD_MAP)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const val = el.value?.trim();
    if (val) {
      const ft = fieldKey.startsWith("addr_") ? "home" : "other";
      setContactField(recordId, fieldKey, val, ft, 0);
    }
  }

  // 電話番号を保存
  const phoneRows = document.querySelectorAll("#detail-phones > div");
  phoneRows.forEach((row, i) => {
    const val = row.querySelector(".detail-phone-value")?.value?.trim();
    const type = row.querySelector(".detail-phone-type")?.value || "mobile";
    if (val) setContactField(recordId, "phone", val, type, i);
  });

  // メールを保存
  const emailRows = document.querySelectorAll("#detail-emails > div");
  emailRows.forEach((row, i) => {
    const val = row.querySelector(".detail-email-value")?.value?.trim();
    const type = row.querySelector(".detail-email-type")?.value || "work";
    if (val) setContactField(recordId, "email", val, type, i);
  });

  // records.contact_info も更新（メインの連絡先情報を同期）
  const firstPhone = document
    .querySelector("#detail-phones .detail-phone-value")
    ?.value?.trim();
  const firstEmail = document
    .querySelector("#detail-emails .detail-email-value")
    ?.value?.trim();
  const mainContact = firstEmail || firstPhone || null;
  try {
    db.run("UPDATE records SET contact_info = ? WHERE id = ?", [
      mainContact,
      recordId,
    ]);
  } catch (e) {}

  // records.role も同期
  const jobTitle = document.getElementById("detail-job-title")?.value?.trim();
  try {
    db.run("UPDATE records SET role = ? WHERE id = ?", [
      jobTitle || null,
      recordId,
    ]);
  } catch (e) {}

  // 姓・名からフルネームを生成して records.memo を同期
  const familyName =
    document.getElementById("detail-family-name")?.value?.trim() || "";
  const givenName =
    document.getElementById("detail-given-name")?.value?.trim() || "";
  const fullName = (familyName + " " + givenName).trim();
  try {
    db.run("UPDATE records SET memo = ? WHERE id = ?", [
      fullName || null,
      recordId,
    ]);
  } catch (e) {}

  setDirty(true);
  closeContactDetail(false);
  renderData();
  showToast(window._t("toast.detail_saved"), '<span class="text-green-400">✔</span>');
}

// --- vcfファイル入力ハンドラー ---
function handleVCFInput(event) {
  const file = event.target.files[0];
  if (!file) return;
  importVCardFile(file);
  event.target.value = "";
}

// --- 汎用プラットフォーム(Google/Outlook)向けCSVエクスポート ---
function exportPlatformCSV(platform) {
  if (!db) return;
  const isGoogle = platform === "google";
  const map = isGoogle ? PLATFORM_MAPS.google_csv : PLATFORM_MAPS.outlook_csv;
  const headers = Object.keys(map);
  const rows = [headers];

  let stmt;
  try {
    stmt = db.prepare(
      "SELECT c.id, c.memo, p.memo, c.role, c.contact_info, c.tags, p.tags FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC",
    );
    while (stmt.step()) {
      const [id, memo, org, role, contact, itemTags, orgTags] = stmt.get();

      if (currentActiveTag) {
        const activeTagRaw = currentActiveTag.replace(/^[#＃]/, "");
        const itemMemoTags = (memo?.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []).map((t) => t.replace(/[#＃]/, ""));
        const orgMemoTags = (org?.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []).map((t) => t.replace(/[#＃]/, ""));
        const itemFieldTags = (itemTags || "").split(/[,、\s]+/).map((t) => t.trim().replace(/^[#＃]/, "")).filter(Boolean);
        const orgFieldTags = (orgTags || "").split(/[,、\s]+/).map((t) => t.trim().replace(/^[#＃]/, "")).filter(Boolean);
        const allTags = [...new Set([...itemMemoTags, ...orgMemoTags, ...itemFieldTags, ...orgFieldTags])];

        if (!allTags.includes(activeTagRaw)) continue;
      }

      const fields = getContactFields(id);
      const usedFields = new Set();
      const row = headers.map((h) => {
        const m = map[h];
        const match = fields.find(
          (f) =>
            f.field_key === m.key &&
            (m.type ? f.field_type === m.type : true) &&
            !usedFields.has(f.id),
        ) || fields.find(
          (f) =>
            f.field_key === m.key &&
            !usedFields.has(f.id)
        );
        if (match) {
          usedFields.add(match.id);
          return match.field_value;
        }

        if (m.key === "given_name") return memo || "";
        if (m.key === "company") return org || "";
        if (m.key === "job_title") return role || "";
        if (
          m.key === "email" &&
          (m.order === undefined || m.order === 0) &&
          contact &&
          contact.includes("@")
        )
          return contact;
        if (
          m.key === "phone" &&
          (m.order === undefined || m.order === 0) &&
          contact &&
          !contact.includes("@")
        )
          return contact;

        return "";
      });
      if (row.some((v) => v)) rows.push(row);
    }
  } finally {
    if (stmt) stmt.free();
  }

  if (rows.length <= 1) {
    showToast(window._t("toast.no_export_data"), "⚠️", "warning");
    return;
  }
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          // 明示的に文字列(String)にキャストし、TypeErrorを防ぐ
          let cell = String(v || "");
          if (/^[=+\-@\t\r]/.test(cell)) {
            cell = "'" + cell;
          }
          return `"${cell.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
  downloadCSVFile(csv, isGoogle ? "google_contacts" : "outlook_contacts");
  showToast(
    window._t(isGoogle ? "toast.google_csv" : "toast.outlook_csv", rows.length - 1),
    '<span class="text-green-400">✔</span>',
  );
}

// CSVダウンロード共通関数
function downloadCSVFile(csvText, filenameBase) {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const hh = String(today.getHours()).padStart(2, "0");
  const min = String(today.getMinutes()).padStart(2, "0");
  const sec = String(today.getSeconds()).padStart(2, "0");
  const ds = `${yyyy}${mm}${dd}_${hh}${min}${sec}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}_${ds}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 9. PWAインストールプロンプトの制御
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  // ブラウザ標準の目立たないインストール通知をキャンセル
  e.preventDefault();
  // イベントを保持しておく
  deferredPrompt = e;

  // カスタムのインストールボタンを表示する
  const installBtn = document.getElementById("install-button");
  if (installBtn) {
    installBtn.classList.remove("hidden");
    // 多重登録を防ぐため、addEventListenerではなく onclick を使用
    installBtn.onclick = async () => {
      installBtn.classList.add("hidden");
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(window._t("log.install_result", outcome));
      deferredPrompt = null;
    };
  }
});

window.addEventListener("appinstalled", () => {
  const installBtn = document.getElementById("install-button");
  if (installBtn) installBtn.classList.add("hidden");
  console.log(window._t("log.installed"));
});

// --- コマンドパレット制御 ---
let isCommandPaletteOpen = false;
let selectedCommandIndex = 0;
let prePaletteActiveElement = null; // 🎯 Gold-Rank用: パレットを開く直前のフォーカス要素

function getBaseCommands() {
  return [
    {
      id: "save",
      icon: '<svg class="w-5 h-5"><use href="#icon-save"></use></svg>',
      title: window._t("cmd.save"),
      shortcut: isMac ? "⌘S" : "Ctrl+S",
      action: () => savePeopleFile(),
    },
    {
      id: "open",
      icon: '<svg class="w-5 h-5"><use href="#icon-folder"></use></svg>',
      title: window._t("cmd.open"),
      shortcut: isMac ? "⌘O" : "Ctrl+O",
      action: () => loadPeopleFile(),
    },
    {
      id: "saveas",
      icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
      title: window._t("cmd.save_as"),
      shortcut: isMac ? "⇧⌘S" : "Ctrl+Shift+S",
      action: () => savePeopleFile(true),
    },
    {
      id: "new",
      icon: '<svg class="w-5 h-5"><use href="#icon-sparkles"></use></svg>',
      title: window._t("cmd.new"),
      shortcut: isMac ? "⌥N" : "Alt+N",
      action: () => document.getElementById("new-block-memo").focus(),
    },
    {
      id: "export",
      icon: '<svg class="w-5 h-5"><use href="#icon-download"></use></svg>',
      title: window._t("cmd.export_all"),
      action: () => exportVCard(),
    },
    {
      id: "copy_prompt",
      icon: '<svg class="w-5 h-5"><use href="#icon-bot"></use></svg>',
      title: window._t("cmd.copy_prompt"),
      action: () => copyAIPrompt(),
    },
    {
      id: "markdown",
      icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
      title: window._t("cmd.copy_md"),
      action: copyAsMarkdown,
    },
    {
      id: "expandall",
      icon: '<svg class="w-5 h-5"><use href="#icon-chevron-down"></use></svg>',
      title: window._t("cmd.expand_all"),
      action: () => toggleAllBlocks(false),
    },
    {
      id: "collapseall",
      icon: '<svg class="w-5 h-5" style="transform: rotate(-90deg)"><use href="#icon-chevron-down"></use></svg>',
      title: window._t("cmd.collapse_all"),
      action: () => toggleAllBlocks(true),
    },
    {
      id: "import_vcf",
      icon: '<svg class="w-5 h-5 text-green-500"><use href="#icon-import"></use></svg>',
      title: window._t("cmd.import_vcf"),
      action: () => document.getElementById("vcf-input").click(),
    },
    {
      id: "import_csv",
      icon: '<svg class="w-5 h-5 text-blue-500"><use href="#icon-import"></use></svg>',
      title: window._t("cmd.import_csv"),
      action: () => document.getElementById("csv-input").click(),
    },
    {
      id: "export_google",
      icon: '<svg class="w-5 h-5 text-red-500"><use href="#icon-export"></use></svg>',
      title: window._t("cmd.export_google"),
      action: () => exportPlatformCSV("google"),
    },
    {
      id: "export_outlook",
      icon: '<svg class="w-5 h-5 text-blue-600"><use href="#icon-export"></use></svg>',
      title: window._t("cmd.export_outlook"),
      action: () => exportPlatformCSV("outlook"),
    },
    {
      id: "export_vcard",
      icon: '<svg class="w-5 h-5 text-purple-500"><use href="#icon-export"></use></svg>',
      title: window._t("cmd.export_vcard"),
      action: () => exportVCard(),
    },
  ];
}

function toggleCommandPalette() {
  const palette = document.getElementById("cmd-palette");
  const input = document.getElementById("cmd-input");

  if (!isCommandPaletteOpen) {
    // 🎯 開く瞬間に、どこにフォーカスしていたかを記憶
    prePaletteActiveElement = document.activeElement;
  }

  isCommandPaletteOpen = !isCommandPaletteOpen;
  if (isCommandPaletteOpen) {
    palette.classList.remove("hidden");
    palette.classList.add("flex");
    lockScroll();
    toggleMainUI(true);
    input.value = "";
    selectedCommandIndex = 0;
    renderCommandList();

    if (window.innerWidth > 768) {
      setTimeout(() => input.focus(), 50);
    } else {
      input.blur(); // スマホの場合はソフトウェアキーボードを出さず、リスト表示を優先
    }
  } else {
    palette.classList.add("hidden");
    palette.classList.remove("flex");
    unlockScroll();
    toggleMainUI(false);
    if (prePaletteActiveElement) {
      prePaletteActiveElement.focus();
      prePaletteActiveElement = null;
    }
  }
}

function getDynamicCommands() {
  let dynamicCommands = [...getBaseCommands()];
  if (db) {
    try {
      const res = db.exec("SELECT id, name FROM templates ORDER BY id DESC");
      if (res.length > 0) {
        res[0].values.forEach((row) => {
          // 挿入コマンド
          dynamicCommands.push({
            id: `tpl_insert_${row[0]}`,
            icon: '<svg class="w-5 h-5 text-amber-500"><use href="#icon-sparkles"></use></svg>',
            title: `[挿入] ${escapeHtml(row[1])}`,
            action: () => insertTemplate(row[0]),
          });
          // 削除コマンドを追加
          dynamicCommands.push({
            id: `tpl_delete_${row[0]}`,
            icon: '<svg class="w-5 h-5 text-red-400"><use href="#icon-trash"></use></svg>',
            title: `<span class="text-slate-400">[削除] ${escapeHtml(row[1])}</span>`,
            keepOpen: true, // パレットを閉じない設定
            action: async () => {
              if (
                await window.requestCustomPrompt(
                  "テンプレートの削除",
                  `テンプレート「${row[1]}」を削除しますか？`,
                  "",
                  "confirm",
                )
              ) {
                db.run("DELETE FROM templates WHERE id = ?", [row[0]]);
                setDirty(true);
                // インデックスのオーバーフローを防止
                selectedCommandIndex = Math.max(0, selectedCommandIndex - 1);
                // パレットを閉じずにリストだけを再描画して更新を反映
                renderCommandList(document.getElementById("cmd-input").value);
              }
            },
          });
        });
      }
    } catch (e) {}
  }
  return dynamicCommands;
}

function getFilteredCommands(query) {
  const normalize = (text) => (text || "").normalize("NFKC").toLowerCase();
  const terms = normalize(query)
    .split(/[\s　]+/)
    .filter(Boolean);

  const dynamicCommands = getDynamicCommands();
  let filtered = dynamicCommands.filter((c) => {
    const targetText = normalize(c.title) + " " + normalize(c.id);
    return terms.every((term) => targetText.includes(term));
  });

  if (terms.length > 0 && db) {
    let stmt;
    try {
      // WHERE条件を外し、親を持つレコードを全取得
      stmt = db.prepare(
        `SELECT c.id, c.memo, p.memo, p.id, c.contact_info FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL`,
      );
      while (stmt.step()) {
        const [id, name, org, parentId, contact] = stmt.get();
        const targetText =
          normalize(name) + " " + normalize(contact) + " " + normalize(org);

        // JS側で完全な正規化テキストに対してマッチング
        if (terms.every((term) => targetText.includes(term))) {
          filtered.unshift({
            id: `search_${id}`,
            icon: '<svg class="w-5 h-5 text-primary"><use href="#icon-search"></use></svg>',
            title: `<span class="text-primary font-bold">${escapeHtml(name)}</span> <span class="text-xs text-slate-400 dark:text-slate-500 ml-2">(${escapeHtml(org)})</span>`,
            keepOpen: false,
            action: () => {
              let delay = 0;

              // 対象がDOMにいない可能性を防ぐため、フィルター中なら解除して再描画する
              if (currentActiveTag !== null) {
                currentActiveTag = null;
                renderData();
                delay = 150; // 再描画を待つ
              }

              // 親ブロックが折りたたまれていれば展開する
              if (collapsedBlocks.has(parentId)) {
                toggleBlock(parentId);
                delay = 310;
                delay = Math.max(delay, 310);
              }

              setTimeout(() => {
                // 対象の名前要素にジャンプしてフォーカスを当てる
                const el = document.querySelector(
                  `span[data-id="${id}"][data-field="memo"]`,
                );
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  el.focus();
                  const range = document.createRange();
                  const sel = window.getSelection();
                  range.selectNodeContents(el);
                  range.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }, delay);
            },
          });
          if (filtered.length > 20) break; // 多すぎる場合は20件で打ち切り
        }
      }
    } catch (e) {
      console.error("Search command failed:", e);
    } finally {
      if (stmt) stmt.free();
    }
  }
  return filtered;
}

function renderCommandList(query = "") {
  const list = document.getElementById("cmd-list");
  list.innerHTML = "";

  const filtered = getFilteredCommands(query);

  if (filtered.length === 0) {
    list.innerHTML = `<div class="px-4 py-8 text-center text-slate-400 text-sm">「${escapeHtml(query)}」に一致するコマンドや連絡先は見つかりませんでした</div>`;
    return;
  }

  if (selectedCommandIndex >= filtered.length) selectedCommandIndex = 0;

  filtered.forEach((cmd, i) => {
    const div = document.createElement("div");
    const isSelected = i === selectedCommandIndex;
    div.className = `px-4 py-3 my-1 flex justify-between items-center rounded-md cursor-pointer transition-colors ${isSelected ? "bg-primary-50 dark:bg-primary/10 text-primary" : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-surface-hover hover:text-slate-900 dark:hover:text-white"}`;

    let innerHtml = `<div class="flex items-center gap-3"><span class="text-xl">${cmd.icon}</span><span class="font-medium tracking-wide">${cmd.title}</span></div>`;
    if (cmd.shortcut) {
      // コマンドが選択されている時はバッジの色も少し強調する
      innerHtml += `<kbd class="font-mono text-[10px] bg-white border border-slate-200 px-1.5 py-0.5 rounded shadow-sm ${isSelected ? "text-primary border-primary/20" : "text-slate-400"}">${cmd.shortcut}</kbd>`;
    }
    div.innerHTML = innerHtml;

    div.onclick = () => {
      if (!cmd.keepOpen) {
        toggleCommandPalette();
      }
      cmd.action();
    };
    list.appendChild(div);

    if (isSelected) {
      setTimeout(() => div.scrollIntoView({ block: "nearest" }), 0);
    }
  });
}

document.addEventListener("keydown", (e) => {
  const key = e.key?.toLowerCase();
  if (!key) return; // キー情報が取得できない特殊なイベントは無視

  if ((e.metaKey || e.ctrlKey) && key === "k") {
    e.preventDefault();
    const isAnyModalOpen = !document.getElementById("csv-mapping-modal").classList.contains("hidden") ||
                           !document.getElementById("export-modal").classList.contains("hidden") ||
                           !document.getElementById("contact-detail-modal").classList.contains("hidden") ||
                           !document.getElementById("password-prompt-modal").classList.contains("hidden") ||
                           !document.getElementById("role-dict-editor-modal").classList.contains("hidden") ||
                           !document.getElementById("generic-dialog-modal").classList.contains("hidden");
    if (isAnyModalOpen) return;

    toggleCommandPalette();
    return;
  }

  // 新規ブロック作成 (Option+N / Alt+N)
  if (
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    (key === "n" || key === "ｎ" || e.code === "KeyN")
  ) {
    e.preventDefault();
    document.getElementById("new-block-memo").focus();
    return;
  }

  // 上書き保存 (Cmd+S / Ctrl+S) & 複製保存 (Cmd+Shift+S / Ctrl+Shift+S)
  if (
    (e.metaKey || e.ctrlKey) &&
    (key === "s" || key === "ｓ" || e.code === "KeyS")
  ) {
    e.preventDefault();
    if (e.shiftKey) {
      savePeopleFile(true); // Save As
    } else {
      savePeopleFile(); // Save
    }
    return;
  }

  // ファイルを開く (Cmd+O / Ctrl+O)
  if (
    (e.metaKey || e.ctrlKey) &&
    (key === "o" || key === "ｏ" || e.code === "KeyO")
  ) {
    e.preventDefault();
    loadPeopleFile();
    return;
  }

  if (e.key === "Escape") {
    if (e.isComposing) return;

    const dropOverlay = document.getElementById("drop-overlay");
    if (dropOverlay && !dropOverlay.classList.contains("hidden")) {
      dropOverlay.classList.add("hidden");
      dropOverlay.classList.remove("flex");
      dragCounter = 0;
      return;
    }

    // 設定メニューを閉じる
    window.closeSettingsMenu();

    // モーダルやパレットが開いていれば閉じる
    if (isCommandPaletteOpen) {
      const input = document.getElementById("cmd-input");
      if (input && input.value !== "") {
        input.value = "";
        renderCommandList("");
        return;
      }
      toggleCommandPalette();
      return;
    }
    if (
      !document.getElementById("csv-mapping-modal").classList.contains("hidden")
    ) {
      closeCSVModal();
      return;
    }
    if (!document.getElementById("export-modal").classList.contains("hidden")) {
      closeExportModal();
      return;
    }
    if (
      !document
        .getElementById("role-dict-editor-modal")
        .classList.contains("hidden")
    ) {
      closeRoleDictEditor();
      return;
    }
    if (
      !document
        .getElementById("contact-detail-modal")
        .classList.contains("hidden")
    ) {
      closeContactDetail();
      return;
    }
  }

  if (isCommandPaletteOpen) {
    const input = document.getElementById("cmd-input");

    const filtered = getFilteredCommands(input.value);

    // ✅ 結果が0件の時の NaN クラッシュを防止
    if (
      filtered.length === 0 &&
      (e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === "Tab")
    ) {
      if (e.key === "Tab") e.preventDefault();
      return;
    }

    // Tabキーの挙動をオーバーライドして上下移動に割り当てる
    if (e.key === "Tab") {
      e.preventDefault(); // フォーカス移動を阻止
      if (e.shiftKey) {
        selectedCommandIndex =
          (selectedCommandIndex - 1 + filtered.length) % filtered.length;
      } else {
        selectedCommandIndex = (selectedCommandIndex + 1) % filtered.length;
      }
      renderCommandList(input.value);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCommandIndex =
        (selectedCommandIndex - 1 + filtered.length) % filtered.length;
      renderCommandList(input.value);
    } else if (
      e.key === "Enter" &&
      !e.isComposing &&
      filtered[selectedCommandIndex]
    ) {
      e.preventDefault();
      const cmd = filtered[selectedCommandIndex];
      if (!cmd.keepOpen) {
        toggleCommandPalette();
      }
      cmd.action();
    }
  }
});

// --- TOC（目次）の絞り込み機能 ---
function applyTocFilter(query) {
  const q = query.toLowerCase();
  const tocItems = document.querySelectorAll("#toc-list a.toc-item");
  const tagElements = document.querySelectorAll(
    "#toc-list div.group, #toc-list div.mt-8",
  ); // タグ一覧と区切り線

  tocItems.forEach((item) => {
    const text = item.textContent.toLowerCase();
    const isVisible = text.includes(q);
    item.style.display = isVisible ? "block" : "none";
  });

  // 検索入力中はタグ一覧のエリアを非表示にしてノイズを消す
  tagElements.forEach((el) => {
    el.style.display = q === "" ? "" : "none";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const tocFilter = document.getElementById("toc-filter");
  if (tocFilter) {
    tocFilter.addEventListener("input", (e) => {
      applyTocFilter(e.target.value);
    });
  }
});

// --- マルチタブ起動によるデータ競合の防止 ---
let hasAlerted = false;

if (typeof BroadcastChannel !== "undefined") {
  const bc = new BroadcastChannel("grindpeople_app_channel");

  bc.onmessage = async (e) => {
    if (e.data === "ping") {
      bc.postMessage("pong"); // すでに開いているタブが応答する
    } else if (e.data === "pong") {
      // 自分が後から開いたタブだった場合
      if (!hasAlerted) {
        hasAlerted = true;
        await window.requestCustomPrompt(
          window._t("error.warning_title"),
          window._t("alert.multi_tab"),
          "",
          "alert",
        );
        document.body.style.opacity = "0.5";
        document.body.style.pointerEvents = "none";
      }
    }
  };
  bc.postMessage("ping");
}

let cmdSearchTimeout = null;
document.getElementById("cmd-input")?.addEventListener("input", (e) => {
  clearTimeout(cmdSearchTimeout);
  cmdSearchTimeout = setTimeout(() => {
    selectedCommandIndex = 0;
    renderCommandList(e.target.value);
  }, 100);
});

// --- パスワード表示トグル ---
function togglePasswordVisibility() {
  const pwInput = document.getElementById("file-password");
  const iconOpen = document.getElementById("icon-eye-open");
  const iconClosed = document.getElementById("icon-eye-closed");
  if (pwInput.type === "password") {
    pwInput.type = "text";
    iconOpen.classList.remove("hidden");
    iconClosed.classList.add("hidden");
  } else {
    pwInput.type = "password";
    iconOpen.classList.add("hidden");
    iconClosed.classList.remove("hidden");
  }
}

// --- 役職サジェスト (オートコンプリート) 機能 ---
const roleDictionaries = {
  custom: [], // ユーザー定義の辞書
  none: [],
  get business() {
    return [
      window._t("role.biz.president"),
      window._t("role.biz.director"),
      window._t("role.biz.manager"),
      window._t("role.biz.section_chief"),
      window._t("role.biz.team_leader"),
      window._t("role.biz.sales"),
      window._t("role.biz.engineer"),
      window._t("role.biz.designer"),
    ];
  },
  get community() {
    return [
      window._t("role.com.representative"),
      window._t("role.com.organizer"),
      window._t("role.com.member"),
      window._t("role.com.advanced"),
      window._t("role.com.intermediate"),
      window._t("role.com.beginner"),
      window._t("role.com.coach"),
      window._t("role.com.visitor"),
    ];
  },
};

function changeRoleDict() {
  const select = document.getElementById("dict-select");
  const dictKey = select.value;
  setDbSetting("roleDict", dictKey);
  renderRoleSuggestions(dictKey);
}

function renderRoleSuggestions(dictKey) {
  const datalist = document.getElementById("role-suggestions");
  if (!datalist) return;
  datalist.innerHTML = "";

  const dict = roleDictionaries[dictKey] || [];
  const fragment = document.createDocumentFragment();
  dict.forEach((account) => {
    const option = document.createElement("option");
    option.value = account;
    fragment.appendChild(option);
  });
  datalist.appendChild(fragment);
}

function loadCustomDict() {
  const savedDict = getDbSetting("customRoleDict");

  // businessが消されていても、communityや代替テキストで安全にフォールバックする
  const defaultDict = roleDictionaries.business ||
      roleDictionaries.community || [window._t("label.no_role")];

  if (savedDict) {
    try {
      const parsed = JSON.parse(savedDict);
      if (Array.isArray(parsed)) {
        // 古い形式(文字列の配列)から新しい形式(オブジェクトの配列)へマイグレーション
        if (parsed.length > 0 && typeof parsed[0] === "string") {
          customRoleDict = parsed.map((name) => ({ name, hidden: false }));
        } else {
          customRoleDict = parsed;
        }
      } else {
        throw new Error("Invalid format"); // catchブロックに飛ばしてデフォルト値をセットさせる
      }
    } catch (e) {
      // パースに失敗したらデフォルトで上書き
      customRoleDict = defaultDict.map((name) => ({
        name,
        hidden: false,
      }));
    }
  } else {
    // 初回起動時はビジネスリストをデフォルトとしてセット
    customRoleDict = defaultDict.map((name) => ({
      name,
      hidden: false,
    }));
  }

  // customRoleDict が万が一 undefined になってもエラーを出さない
  roleDictionaries.custom = (customRoleDict || [])
    .filter((i) => i && !i.hidden)
    .map((i) => i.name);
}

function saveCustomDict() {
  setDbSetting("customRoleDict", JSON.stringify(customRoleDict));
  roleDictionaries.custom = customRoleDict
    .filter((i) => !i.hidden)
    .map((i) => i.name);
  // 現在の選択がカスタムなら、datalistを即時更新
  if (document.getElementById("dict-select").value === "custom") {
    renderRoleSuggestions("custom");
  }
  return true;
}

// --- カスタム役職辞書エディタ ---
let draggedItemIndex = null;

function showRoleDictEditor() {
  const modal = document.getElementById("role-dict-editor-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  toggleMainUI(true);
  renderCustomDictEditor();

  document.getElementById("add-custom-dict-form").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("new-custom-role");
    const newRoleName = input.value.trim();
    if (newRoleName) {
      const existing = customRoleDict.find((item) => item.name === newRoleName);
      if (existing) {
        existing.hidden = false; // 存在していれば再表示
      } else {
        customRoleDict.push({ name: newRoleName, hidden: false });
      }
      renderCustomDictEditor();
    }
    input.value = "";
    input.focus();
  };
}

function closeRoleDictEditor() {
  const modal = document.getElementById("role-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  toggleMainUI(false);
  // 変更を保存せずに閉じた場合は、元の状態に戻す
  loadCustomDict();
}

function saveCustomDictAndClose() {
  if (!saveCustomDict()) return; // 失敗時は閉じない

  const modal = document.getElementById("role-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  toggleMainUI(false);
}

function renderCustomDictEditor() {
  const list = document.getElementById("custom-dict-list");
  list.innerHTML = "";
  customRoleDict.forEach((item, index) => {
    const li = document.createElement("li");
    li.dataset.index = index;
    li.draggable = true;
    li.className = `flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-md cursor-grab active:cursor-grabbing active:bg-slate-100 transition-opacity ${item.hidden ? "opacity-50" : "opacity-100"}`;

    const icon = item.hidden ? "icon-eye-slash" : "icon-eye";
    const title = item.hidden ? window._t("dict.show") : window._t("dict.hide");
    const textClass = item.hidden
      ? "text-slate-400 line-through"
      : "text-slate-700";

    li.innerHTML = `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <!-- PC用のドラッグハンドル -->
        <svg class="hidden sm:block w-5 h-5 text-slate-400 shrink-0"><use href="#icon-drag"></use></svg>
        <span class="font-medium ${textClass} truncate">${escapeHtml(item.name)}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <!-- スマホ用の上下移動ボタン -->
        <div class="flex flex-col sm:hidden mr-2">
          <button type="button" onclick="event.stopPropagation(); moveCustomDictItem(${index}, -1)" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === 0 ? "opacity-30 cursor-not-allowed" : ""}" ${index === 0 ? "disabled" : ""}>▲</button>
          <button type="button" onclick="event.stopPropagation(); moveCustomDictItem(${index}, 1)" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === customRoleDict.length - 1 ? "opacity-30 cursor-not-allowed" : ""}" ${index === customRoleDict.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <!-- 表示/非表示トグル -->
        <button onclick="toggleCustomRoleHidden(${index})" class="text-slate-400 hover:text-slate-600 transition-colors shrink-0" title="${title}">
          <svg class="w-5 h-5"><use href="#${icon}"></use></svg>
        </button>
        <!-- 削除ボタン -->
        <button onclick="deleteCustomDictItem(${index})" class="text-slate-300 hover:text-red-500 transition-colors shrink-0 ml-1" title="${window._t("btn.delete_completely")}">
          <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    `;
    // Drag and Drop イベント
    li.addEventListener("dragstart", (e) => {
      draggedItemIndex = index;
      // Firefoxでドラッグ＆ドロップを有効化するための必須コード
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", index);
      }
      setTimeout(() => e.target.classList.add("opacity-30"), 0);
    });
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (typeof draggedItemIndex !== "number" || draggedItemIndex === null)
        return;

      let droppedOnIndex = index;
      if (draggedItemIndex === droppedOnIndex) return;

      const [reorderedItem] = customRoleDict.splice(draggedItemIndex, 1);
      customRoleDict.splice(droppedOnIndex, 0, reorderedItem);
      draggedItemIndex = null;
      renderCustomDictEditor();
    });
    li.addEventListener("dragend", (e) => {
      e.target.classList.remove("opacity-30");
      draggedItemIndex = null;
    });
    list.appendChild(li);
  });
}

// スマホタップ用のカスタム役職並び替え関数
function moveCustomDictItem(index, direction) {
  if (index + direction < 0 || index + direction >= customRoleDict.length)
    return;
  const item = customRoleDict.splice(index, 1)[0];
  customRoleDict.splice(index + direction, 0, item);
  renderCustomDictEditor();
}

async function deleteCustomDictItem(index) {
  const isConfirmed = await window.requestCustomPrompt(
    window._t("confirm.delete_dict_title"),
    window._t("confirm.delete_dict_desc", customRoleDict[index].name),
    "",
    "confirm",
  );
  if (isConfirmed) {
    customRoleDict.splice(index, 1);
    renderCustomDictEditor();
  }
}

function toggleCustomRoleHidden(index) {
  if (customRoleDict[index]) {
    customRoleDict[index].hidden = !customRoleDict[index].hidden;
    renderCustomDictEditor();
  }
}

function setAllCustomRolesHidden(isHidden) {
  customRoleDict.forEach((item) => {
    item.hidden = isHidden;
  });
  renderCustomDictEditor();
}

if (!window.isSecureContext) {
  document.addEventListener("DOMContentLoaded", async () => {
    await window.requestCustomPrompt(
      window._t("alert.http_title"),
      window._t("alert.http_desc"),
      "",
      "alert",
    );
    showToast(
      window._t("error.http_required"),
      '<span class="text-red-400">⚠️</span>',
      "warning",
    );
    hideStatus();
  });
} else {
  // DOMとすべてのCDNスクリプトの読み込みが完了してから言語を初期化し、その後SQLiteを起動する
  document.addEventListener("DOMContentLoaded", async () => {
    // 保存された言語、またはブラウザの言語を取得
    const savedLang = localStorage.getItem('app_lang') || navigator.language.split('-')[0];

    // UIの言語選択プルダウンを同期
    const langSelect = document.getElementById("lang-select");
    if (langSelect) {
      langSelect.value = savedLang === 'ja' ? 'ja' : 'en';
    }

    // 言語ファイルを非同期でロード（完了するまで待つ）
    await window.I18n.init(savedLang);

    initSQLite();
  });
}

// ユーザーが設定画面などで言語を切り替えたときの処理
async function changeLanguage(langCode) {
  localStorage.setItem('app_lang', langCode);
  document.documentElement.lang = langCode;
  await window.I18n.init(langCode); // 新しい言語ファイルを読み込んでHTMLを自動翻訳
  renderData(); // メインのリストなどを再描画
}

// --- ファイル固有の設定を読み込んでUIに反映する ---
function loadSettingsFromDb() {
  loadCustomDict();
  const savedDict = getDbSetting("roleDict", "custom");
  const dictSelect = document.getElementById("dict-select");
  if (dictSelect) dictSelect.value = savedDict;
  renderRoleSuggestions(savedDict);
}

// ページ離脱時の警告（データ未保存防止）
window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = window._t("alert.unsaved_changes");
    return window._t("alert.unsaved_changes");
  }
});

// --- ドラッグ＆ドロップによるファイル読み込み ---
const dropOverlay = document.getElementById("drop-overlay");
let dragCounter = 0;

// 安全にファイルドラッグかどうかを判定する関数（Safariのエラー回避用）
function hasFiles(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  for (let i = 0; i < e.dataTransfer.types.length; i++) {
    if (e.dataTransfer.types[i] === "Files") return true;
  }
  return false;
}

// 1. デフォルト挙動をキャンセル (documentに対して行うことでSafariでの誤発火を防ぐ)
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("drop", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
  }
});

// 2. ファイルがウィンドウに入ってきたときの処理 (カウンタ方式)
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragCounter === 0) {
    dropOverlay.classList.remove("hidden");
    dropOverlay.classList.add("flex");
  }
  dragCounter++;
});

// 3. ファイルがウィンドウから出ていったときの処理 (カウンタ方式)
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0; // 念のためリセット
    dropOverlay.classList.add("hidden");
    dropOverlay.classList.remove("flex");
  }
});

dropOverlay.addEventListener("dragover", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
dropOverlay.addEventListener("dragenter", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
dropOverlay.addEventListener("dragleave", (e) => {
  if (hasFiles(e)) e.preventDefault();
});

// 4. ドロップされたときの処理
document.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;

  // カウンタとオーバーレイをリセット
  dragCounter = 0;
  dropOverlay.classList.add("hidden");
  dropOverlay.classList.remove("flex");

  let file = null;
  let handle = null;

  if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === "file") {
        file = item.getAsFile();
        if (item.getAsFileSystemHandle) {
          try {
            handle = await item.getAsFileSystemHandle();
          } catch (err) {
            console.warn(
              "ファイルハンドルの取得に失敗しました。フォールバックします:",
              err,
            );
          }
        }
        break;
      }
    }
  } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    file = e.dataTransfer.files[0];
  }

  if (!file) return;

  // すべてのUI状態をリセットし、安全な状態に初期化する
  if (isCommandPaletteOpen) toggleCommandPalette();
  closeCSVModal();
  closeExportModal();
  closeRoleDictEditor();

  // 拡張子に応じて処理を分岐
  const extName = file.name.toLowerCase(); // 💡 小文字に正規化して判定
  if (extName.endsWith(".people")) {
    if (isDirty) {
      const isConfirmed = await window.requestCustomPrompt(
        window._t("confirm.title"),
        window._t("confirm.discard_changes"),
        "",
        "confirm",
      );
      if (!isConfirmed) {
        return;
      }
    }
    if (handle && handle.kind === "file") {
      await processFileHandle(handle);
    } else {
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    }
  } else if (extName.endsWith(".vcf")) {
    // vCardファイルのドラッグ＆ドロップインポート
    await importVCardFile(file);
  } else if (extName.endsWith(".csv")) {
    // 隠された <input type="file"> を利用して、既存のインポートフローに流す
    const csvInput = document.getElementById("csv-input");
    if (csvInput) {
      // FileListを作成してinputにセット
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      csvInput.files = dataTransfer.files;
      // onchangeイベントを手動で発火させる
      csvInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else {
    showToast(
      window._t("error.unsupported_drop"),
      "⚠️",
      "error",
    );
  }
});

// OSを判定してショートカットキーのUI表示を最適化
const shortcutEl = document.getElementById("cmd-shortcut-key");
if (shortcutEl) {
  shortcutEl.textContent = isMac ? "⌘K" : "Ctrl+K";
}

const btnSaveTooltip = document.getElementById("btn-save");
if (btnSaveTooltip) btnSaveTooltip.title = `${window._t("btn.save")} (${isMac ? "⌘S" : "Ctrl+S"})`;

const btnOpenTooltip = document.querySelector(
  'button[onclick="loadPeopleFile()"]',
);
if (btnOpenTooltip) btnOpenTooltip.title = `${window._t("btn.open")} (${isMac ? "⌘O" : "Ctrl+O"})`;

// --- 最後の砦：タブ閉じ/バックグラウンド移行時の強制バックアップ ---
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isDirty && db) {
    try {
      // 【追加】パスワードが設定されている場合は、平文でのバックアップを絶対に禁止する
      const currentPassword = document.getElementById("file-password").value;
      if (currentPassword) {
        console.warn(
          window._t("log.emergency_backup_skip"),
        );
        return;
      }

      // 簡易的なサイズチェック（SQLiteのページ数などで推定）
      const pageSizeRes = db.exec("PRAGMA page_size");
      const pageCountRes = db.exec("PRAGMA page_count");
      if (pageSizeRes.length && pageCountRes.length) {
        const sizeBytes =
          pageSizeRes[0].values[0][0] * pageCountRes[0].values[0][0];
        if (sizeBytes > 5 * 1024 * 1024) {
          console.warn(
            "DBが大きすぎるため、終了時のバックアップをスキップします",
          );
          return;
        }
      }

      const data = db.export();

      // 【セキュリティ修正 3】: タブ終了時の Race Condition キル対策
      // 非同期の暗号化（encryptData）を待つとブラウザにプロセスを殺されてデータが消失するため、
      // 終了時の緊急退避に限っては、サンドボックスで保護されたIndexedDBへ即座に非同期書き込みリクエストを発行する（ベストエフォート）。
      const tx = indexedDB.open(DB_NAME, 1);
      tx.onsuccess = (e) => {
        const idb = e.target.result;
        const store = idb
          .transaction(STORE_NAME, "readwrite")
          .objectStore(STORE_NAME);
        store.put(data, "latest_draft");
      };
      tx.onerror = (e) => {
        console.warn(window._t("log.emergency_backup_denied"));
      };
    } catch (e) {
      console.error("Emergency save error", e);
    }
  }
});

// --- 新機能: SVGアバター生成 ---
function generateAvatarSVG(name, id = 0) {
  const colors = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#84cc16",
    "#22c55e",
    "#10b981",
    "#14b8a6",
    "#06b6d4",
    "#0ea5e9",
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#a855f7",
    "#d946ef",
    "#ec4899",
    "#f43f5e",
  ];
  let hash = id > 0 ? id * 2654435761 : 0;
  const safeName = name || "?";
  for (let i = 0; i < safeName.length; i++) {
    hash = safeName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const bgColor = colors[Math.abs(hash) % colors.length];
  // Emojiなどのサロゲートペア対応のためArray.fromを使用
  const chars = Array.from(safeName.trim());
  const initial = chars.length > 0 ? chars[0].toUpperCase() : "?";

  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="${bgColor}"/>
    <text x="50" y="54" font-family="sans-serif" font-weight="bold" font-size="44" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeHtml(initial)}</text>
  </svg>`;
}

// --- 新機能: Web Share APIを用いた連絡先の共有 ---
async function shareContact(id) {
  if (!db) return;
  const stmt = db.prepare(
    "SELECT parent_id, memo, contact_info, role, created_at, tags FROM records WHERE id = ?",
  );
  stmt.bind([id]);
  if (!stmt.step()) return;
  const row = stmt.get();
  stmt.free();

  const [parent_id, memo, contact_info, role, created_at, tags] = row;
  let orgName = "";
  if (parent_id) {
    const parentStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
    parentStmt.bind([parent_id]);
    if (parentStmt.step()) orgName = parentStmt.get()[0] || "";
    parentStmt.free();
  }

  const item = {
    id: id,
    name: memo || window._t("label.unnamed"),
    org: orgName,
    role: role,
    contact_info: contact_info,
    fields: getContactFields(id),
  };

  const vcardData = generateVCardData([item]);
  const fileName = `${(memo || "contact").replace(/[\\/:*?"<>|]/g, "_")}.vcf`;
  const file = new File([vcardData], fileName, { type: "text/vcard" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: memo || window._t("label.unnamed"),
      });
      showToast(window._t("toast.contact_shared"), "✨");
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Share failed:", err);
        triggerVCardDownload(vcardData, fileName.replace(".vcf", ""));
      }
    }
  } else {
    triggerVCardDownload(vcardData, fileName.replace(".vcf", ""));
  }
}

// 詳細モーダル内での Enter キー押下を検知し、瞬時に保存して閉じる
document.getElementById("contact-detail-modal")?.addEventListener("keydown", (e) => {
  if (!e.isComposing) {
    // Cmd (Mac) または Ctrl (Windows) + Enter の場合は、フォーカス位置に関わらず保存
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      saveContactDetail();
    }
    // 単体の Enter は、INPUT要素にいる場合のみ保存 (TEXTAREA内の改行を妨害しないため)
    else if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      saveContactDetail();
    }
  }
});

async function shareBlock(blockId) {
  if (!db) return;
  const blockStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
  blockStmt.bind([blockId]);
  if (!blockStmt.step()) return;
  const blockMemo = blockStmt.get()[0] || window._t("label.unnamed");
  blockStmt.free();

  const itemsStmt = db.prepare(
    "SELECT id, memo, contact_info, role, created_at, tags FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
  );
  itemsStmt.bind([blockId]);
  const dataItems = [];
  while (itemsStmt.step()) {
    const row = itemsStmt.get();
    dataItems.push({
      id: row[0],
      name: row[1] || window._t("label.unnamed"),
      org: blockMemo,
      role: row[3],
      contact_info: row[2],
      fields: getContactFields(row[0]),
    });
  }
  itemsStmt.free();

  if (dataItems.length === 0) {
    showToast(window._t("toast.no_share_data"), "⚠️", "warning");
    return;
  }

  const vcardData = generateVCardData(dataItems);
  const fileName = `${blockMemo.replace(/[\\/:*?"<>|]/g, "_")}.vcf`;
  const file = new File([vcardData], fileName, { type: "text/vcard" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: blockMemo,
      });
      showToast(window._t("toast.group_shared"), "✨");
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Share failed:", err);
        triggerVCardDownload(vcardData, fileName.replace(".vcf", ""));
      }
    }
  } else {
    triggerVCardDownload(vcardData, fileName.replace(".vcf", ""));
  }
}
