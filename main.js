let db = null; // SQLiteデータベースのインスタンス
let SQL = null; // sql.jsのモジュール
let fileHandle = null; // File System Access APIのファイルハンドル
let isDirty = false; // 未保存の変更があるかどうか
window.getIsDirty = () => isDirty;
let pendingCSVData = []; // CSVパース結果の一時保存
let lastUsedDates = {}; // ブロックごとの最終使用日付を記憶
let pendingCSVBuffer = null; // CSVのバイナリデータ
let currentActiveTag = null; // 現在選択中のカテゴリ（タグ）
let currentDisplayedTotal = 0; // カウントアップ用
let collapsedBlocks = new Set(); // 折りたたまれたブロックのIDを記憶
let totalAnimationId = null; // アニメーションの多重起動防止用ID
let draftTimer = null; // ドラフト自動保存用タイマー
let statusTimeoutId = null; // ステータスバー通知のタイマーID
let isSaving = false; // 保存処理の多重実行防止フラグ
let lastSavedPassword = ""; // パスワードの変更・解除検知用
let preDetailActiveElement = null; // 詳細モーダルを開く直前のフォーカス要素

const isMac =
  (navigator.userAgentData && navigator.userAgentData.platform === "macOS") ||
  navigator.platform.toUpperCase().indexOf("MAC") >= 0 ||
  navigator.userAgent.toUpperCase().indexOf("MAC") >= 0;

let customRoleDict = []; // カスタム役職辞書の配列

// --- スクロールロック制御 (Layout Shift対策) ---
function lockScroll() {
  const scrollbarWidth =
    window.innerWidth - document.documentElement.clientWidth;
  if (scrollbarWidth > 0) {
    document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
  document.body.style.overflow = "hidden";
}
function unlockScroll() {
  document.body.style.paddingRight = "";
  document.body.style.overflow = "";
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
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateMetaThemeColor(isDark);
  // DBが初期化済みなら設定も保存
  if (db) {
    try {
      setDbSetting("theme", isDark ? "dark" : "light");
    } catch (e) {}
  }
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
      if (db) {
        try {
          setDbSetting("theme", isDark ? "dark" : "light");
        } catch (err) {}
      }
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

function setDbSetting(key, value) {
  if (!db) return;
  try {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
      key,
      value,
    ]);
    setDirty(true);
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
        if (!isDirty) return; // 【追加】タイマー発火時点でのキャンセル確認

        let data = db.export();
        const password = document.getElementById("file-password").value;
        if (password) {
          data = await encryptData(data, password);
        }

        if (!isDirty) return; // 【追加】非同期処理中に手動保存された場合は破棄する

        await saveDraft(data);

        // 【God-Rank Polish】オートセーブ完了のマイクロインタラクション
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
    document.getElementById("app-ui")?.setAttribute("inert", "");
    lockScroll();
    setTimeout(() => input.focus(), 100);

    const cleanup = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      document.getElementById("app-ui")?.removeAttribute("inert");
      unlockScroll();
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
      if (e.key === "Enter") onSubmit();
      if (e.key === "Escape") onCancel();
    };

    btnSubmit.addEventListener("click", onSubmit);
    btnCancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeyDown);
  });
}

// セキュアな汎用プロンプト・確認ダイアログ (ネイティブ prompt/confirm の代替)
function requestCustomPrompt(
  title,
  message,
  defaultValue = "",
  isConfirm = false,
) {
  return new Promise((resolve) => {
    const modal = document.getElementById("generic-dialog-modal");
    const titleEl = document.getElementById("generic-dialog-title");
    const msgEl = document.getElementById("generic-dialog-message");
    const input = document.getElementById("generic-dialog-input");
    const btnSubmit = document.getElementById("generic-dialog-submit");
    const btnCancel = document.getElementById("generic-dialog-cancel");

    titleEl.textContent = title;
    msgEl.textContent = message;

    if (isConfirm) {
      input.classList.add("hidden");
    } else {
      input.classList.remove("hidden");
      input.value = defaultValue;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("app-ui")?.setAttribute("inert", "");
    lockScroll();

    if (!isConfirm) {
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
      document.getElementById("app-ui")?.removeAttribute("inert");
      unlockScroll();
    };

    btnSubmit.onclick = () => {
      cleanup();
      resolve(isConfirm ? true : input.value);
    };
    btnCancel.onclick = () => {
      cleanup();
      resolve(isConfirm ? false : null);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        btnSubmit.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        btnCancel.click();
      }
    };
  });
}

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
    selection.getRangeAt(0).insertNode(document.createTextNode(cleanText));
    selection.collapseToEnd();

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
    /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/,
  );
  // 電話番号の正規表現: 090-1234-5678, +81 90 1234 5678, 等に対応
  const phoneMatch = text.match(
    /(?:TEL|Phone|電話|Mobile|携帯)?[\s:：]*(\+?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4})/i,
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
      showToast("署名を解析して自動入力しました", "✨");

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
    throw new Error("パスワードが間違っているか、ファイルが破損しています。");
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
        let migrateStmt;
        try {
          migrateStmt = db.prepare(
            "SELECT id, memo, contact_info, role FROM records WHERE parent_id IS NOT NULL",
          );
          const insertField = db.prepare(
            "INSERT OR IGNORE INTO contact_fields (record_id, field_key, field_value, field_type, sort_order) VALUES (?, ?, ?, ?, ?)",
          );
          while (migrateStmt.step()) {
            const [id, memo, contactInfo, role] = migrateStmt.get();
            if (contactInfo && contactInfo.trim()) {
              const ci = contactInfo.trim();
              if (ci.includes("@")) {
                insertField.run([id, "email", ci, "work", 0]);
              } else {
                insertField.run([id, "phone", ci, "mobile", 0]);
              }
            }
            if (role && role.trim()) {
              insertField.run([id, "job_title", role.trim(), "other", 0]);
            }
          }
          insertField.free();
          db.run("COMMIT;");
        } catch (e) {
          db.run("ROLLBACK;");
          throw e;
        } finally {
          if (migrateStmt) migrateStmt.free();
        }
        setDbSetting("contact_fields_migrated", "true");
      }
    } catch (e) {
      console.warn("contact_fields migration skipped", e);
    }

    // 🎯 God-Rank: 既存のlocalStorageからSQLiteへのシームレスな移行
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
      "SELECT field_key, field_value, field_type, sort_order FROM contact_fields WHERE record_id = ? ORDER BY sort_order ASC, id ASC",
    );
    stmt.bind([recordId]);
    while (stmt.step()) {
      const [k, v, t, o] = stmt.get();
      fields.push({
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

function getFieldValue(recordId, fieldKey, fieldType) {
  if (!db) return null;
  let stmt;
  try {
    if (fieldType) {
      stmt = db.prepare(
        "SELECT field_value FROM contact_fields WHERE record_id = ? AND field_key = ? AND field_type = ? LIMIT 1",
      );
      stmt.bind([recordId, fieldKey, fieldType]);
    } else {
      stmt = db.prepare(
        "SELECT field_value FROM contact_fields WHERE record_id = ? AND field_key = ? LIMIT 1",
      );
      stmt.bind([recordId, fieldKey]);
    }
    if (stmt.step()) return stmt.get()[0];
  } catch (e) {
  } finally {
    if (stmt) stmt.free();
  }
  return null;
}

function getFieldValues(recordId, fieldKey) {
  if (!db) return [];
  const values = [];
  let stmt;
  try {
    stmt = db.prepare(
      "SELECT field_value, field_type, sort_order FROM contact_fields WHERE record_id = ? AND field_key = ? ORDER BY sort_order ASC",
    );
    stmt.bind([recordId, fieldKey]);
    while (stmt.step()) {
      const [v, t, o] = stmt.get();
      values.push({ value: v, type: t, sort_order: o });
    }
  } catch (e) {
  } finally {
    if (stmt) stmt.free();
  }
  return values;
}

// vCardパーサー: vCardテキスト → レコード配列
function parseVCardText(text) {
  const contacts = [];
  const cards = text.split(/(?=BEGIN:VCARD)/i).filter((c) => c.trim());
  for (const card of cards) {
    if (!card.match(/BEGIN:VCARD/i)) continue;
    const contact = { fields: [], displayName: "", org: "" };
    // Unfold (RFC 6350: 行継続)
    const unfolded = card.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
    const lines = unfolded.split(/\r\n|\r|\n/);
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
        case "BDAY":
          contact.fields.push({ key: "birthday", value, type: "other" });
          break;
        case "NOTE":
          const unescapedNote = value
            .replace(/\\n/gi, "\n")
            .replace(/\\,/g, ",");
          contact.fields.push({
            key: "note",
            value: unescapedNote,
            type: "other",
          });
          break;
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
    if (contact.displayName || contact.fields.length > 0)
      contacts.push(contact);
  }
  return contacts;
}

// vCardインポート実行
async function importVCardFile(file) {
  if (!file) return;
  // 5MB (5 * 1024 * 1024 bytes) の安全装置を追加
  if (file.size > 5242880) {
    alert(
      "ファイルサイズが大きすぎます（5MB上限）。ブラウザのクラッシュを防ぐため読み込みを中止しました。",
    );
    return;
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
    alert("vCardファイルから連絡先を読み取れませんでした。");
    return;
  }
  if (!confirm(`${contacts.length} 件の連絡先をインポートしますか？`)) return;

  db.run("BEGIN TRANSACTION;");
  let checkStmt = null;
  try {
    checkStmt = db.prepare(
      "SELECT 1 FROM records WHERE memo = ? AND contact_info = ? LIMIT 1",
    );
    // 組織ごとにグループ化
    const orgMap = new Map();
    contacts.forEach((c) => {
      const org = c.org || "vCardインポート";
      if (!orgMap.has(org)) orgMap.set(org, []);
      orgMap.get(org).push(c);
    });

    for (const [orgName, members] of orgMap) {
      db.run("INSERT INTO records (memo, contact_info) VALUES (?, ?)", [
        orgName,
        null,
      ]);
      const pRes = db.exec("SELECT last_insert_rowid()");
      const parentId = pRes[0].values[0][0];

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
        const childId = cRes[0].values[0][0];

        // contact_fields に全フィールドを保存
        const counters = {};
        for (const f of contact.fields) {
          const counterKey = `${f.key}_${f.type}`;
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
      `${contacts.length} 件の連絡先をインポートしました`,
      '<span class="text-green-400">✨</span>',
    );
  } catch (err) {
    db.run("ROLLBACK;");
    alert("vCardインポート中にエラーが発生しました。");
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
        "sql.js が読み込まれていません。通信環境またはCDNの障害が疑われます。",
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
      if (
        confirm(
          "⚠️ 前回終了時の未保存データ（バックアップ）が見つかりました。\n\n復元しますか？\n（「キャンセル」を押すとバックアップは破棄されます）",
        )
      ) {
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
                lastSavedPassword = password;
              }
            } catch (err) {
              const msg =
                attempt > 0
                  ? "❌ パスワードが間違っています。もう一度入力してください:"
                  : "バックアップデータは暗号化されています。解除パスワードを入力してください:";
              password = await requestPasswordPrompt(msg);
              if (password === null) {
                alert(
                  "起動をキャンセルしました。リロードしてやり直してください。",
                );
                document.getElementById("app-ui")?.classList.add("hidden");
                const errorScreen =
                  document.getElementById("fatal-error-screen");
                if (errorScreen) {
                  errorScreen.querySelector("h2").textContent =
                    "保護のため停止しました";
                  errorScreen.querySelector("p").innerHTML =
                    "セキュリティ保護のためアプリの起動を中断しました。<br>リロードしてもう一度やり直してください。";
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
          "未保存データを復元しました",
          '<span class="text-orange-400">↺</span>',
        );
      } catch (dbError) {
        console.error("ドラフトの復元に失敗しました。", dbError);
        alert("⚠️ 前回の未保存データが破損しているため、復元を中止しました。");
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
      showToast("SQLite起動完了", '<span class="text-green-400">●</span>');
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
    showToast("エラー: SQLiteの起動に失敗しました", "<span>⚠️</span>", "error");
    console.error(err);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.style.display = "none";
    const errorScreen = document.getElementById("fatal-error-screen");
    if (errorScreen) {
      const errorMsgEl = errorScreen.querySelector("p");
      if (errorMsgEl)
        errorMsgEl.innerHTML = `必須ファイルが読み込めませんでした。<br><br><span class="text-xs text-red-500 font-mono bg-red-50 dark:bg-red-900/30 p-2 rounded inline-block text-left overflow-auto max-h-32 my-2 border border-red-200 dark:border-red-800">${escapeHtml(err.message || err.toString())}</span><br>通信環境を確認し、ページを再読み込みしてください。`;
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
        if (
          !confirm(
            "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
          )
        )
          return;
      }
      await processFileHandle(launchParams.files[0]);
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
      "fixed top-4 sm:top-8 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none w-full px-4 max-w-md";
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
  const newId = res[0].values[0][0];

  memoInput.value = "";
  setDirty(true);
  renderData(newId);
}

function addItem(parentId, memo, contactInfo, dateStr, roleStr) {
  const safeMemo = (memo || "").trim();
  if (!safeMemo && !contactInfo) return;
  if (parentId) {
    if (dateStr) lastUsedDates[parentId] = dateStr;
  }

  if (dateStr) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (dateStr > todayStr) {
      showToast(
        "未来の日付で登録しました",
        '<span class="text-orange-400">⚠️</span>',
        "warning",
      );
    }
  }

  insertRecord(parentId, safeMemo, contactInfo, dateStr, roleStr);

  renderData(parentId);
}

function insertRecord(
  parentId,
  memo,
  contactInfo,
  dateStr = null,
  roleStr = null,
) {
  let query =
    "INSERT INTO records (parent_id, memo, contact_info, role) VALUES (?, ?, ?, ?)";
  let params = [parentId, memo, contactInfo, roleStr];

  if (dateStr) {
    // タイムゾーンによるバグを回避するため、入力された日付を文字列のまま保存する
    query =
      "INSERT INTO records (parent_id, memo, contact_info, role, created_at) VALUES (?, ?, ?, ?, ?)";
    params.push(dateStr + " 00:00:00");
  } else {
    // SQLiteのCURRENT_TIMESTAMP(UTC)による9時間ズレを防ぐため、JS側でローカル時間を記録
    query =
      "INSERT INTO records (parent_id, memo, contact_info, role, created_at) VALUES (?, ?, ?, ?, ?)";
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

  // ★ 改行をスペースに置換してサニタイズ (Shift+Enter等によるレイアウト崩れ対策)
  let val = newValue.replace(/[\r\n]+/g, " ").trim();
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
    clearContactFieldsByKey(id, "family_name_yomi");
    clearContactFieldsByKey(id, "given_name_yomi");
  }

  // 変更があるかチェック (内容が変わっていない場合は何もしない)
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
    clearContactFieldsByKey(id, "phone");
    clearContactFieldsByKey(id, "email");
    if (val) {
      const type = val.includes("@") ? "email" : "phone";
      const subType = val.includes("@") ? "work" : "mobile";
      setContactField(id, type, val, subType, 0);
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
        deleteRecord(id, true); // forceフラグ付きで確認ダイアログなしでサイレント削除
        return; // UIの再描画等は deleteRecord 側に委ねるためここで終了
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
      }
    }, 100);
  } else {
    // メモや役割の変更は、すでに画面上の文字（innerText / value）が書き換わっているため、
    // DBへの保存(UPDATE)と setDirty(true) だけで十分。DOMの再構築はスキップし、超速タイピングを邪魔しない。
    if (field === "memo" && element && element.tagName === "H2") {
      const tocItem = document.querySelector(`.toc-item[href="#block-${id}"]`);
      if (tocItem) {
        tocItem.textContent = val || "(名称未設定)";
        tocItem.title = val || "(名称未設定)";
      }
    }
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
  allBtn.textContent = "すべて表示";
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

      btn.innerHTML = `${escapeHtml(tag)} <span class="${isSelected ? "text-white/80" : "text-slate-400 dark:text-slate-500"} font-normal text-[10px]">${data.count}</span>`;
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
      ? `FILTERED BY ${currentActiveTag}`
      : "TOTAL CONTACTS";
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
        "toc-item block px-2 py-1 hover:text-slate-900 hover:bg-slate-100 rounded truncate transition-colors text-slate-500 cursor-pointer text-sm font-medium";
      a.textContent = block.memo || "(名称未設定)";
      a.title = block.memo || "(名称未設定)";
      a.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(`block-${block.id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
             <svg class="w-3.5 h-3.5"><use href="#icon-sparkles"></use></svg> 推奨ブラウザ環境 (Chrome / Edge)
           </p>
           <p class="opacity-80">ファイルの直接上書き保存（File System API）が有効です</p>
         </div>`
      : `<div class="mt-8 flex flex-col items-center gap-1.5 text-[11px] text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-4 py-2.5 rounded-xl border border-orange-200 dark:border-orange-800/50">
           <p class="font-bold flex items-center gap-1 text-xs">
             ⚠️ 推奨ブラウザ: Chrome または Edge
           </p>
           <p class="opacity-90 max-w-[260px] leading-relaxed">現在のブラウザは直接上書き保存に非対応のため、保存時に毎回ダウンロードが発生します。</p>
         </div>`;

    container.innerHTML = `
      <div id="empty-state" class="flex flex-col items-center justify-center py-24 sm:py-32 text-center relative overflow-hidden rounded-3xl border border-slate-200/50 dark:border-dark-border/50 bg-slate-50/50 dark:bg-dark-surface/30 backdrop-blur-xl shadow-inner transition-all animate-fade-in group">
        <div class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9IjAiLz4KPHBhdGggZD0iTTAgMEw4IDhaTTAgOEw4IDBaIiBzdHJva2U9IiMzMzMiIHN0cm9rZS1vcGFjaXR5PSIwLjA1IiBzdHJva2Utd2lkdGg9IjEiLz4KPC9zdmc+')] opacity-50 dark:invert"></div>
        <div class="relative z-10 flex flex-col items-center px-4">
          <div class="w-24 h-24 mb-6 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center ring-8 ring-primary/5 dark:ring-primary/10 animate-float group-hover:scale-110 transition-transform duration-500">
            <svg class="w-10 h-10 text-primary drop-shadow-md"><use href="${isFilterActive ? "#icon-search" : "#icon-users"}"></use></svg>
          </div>
          <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${isFilterActive ? "該当する記録が見つかりません" : "Welcome to People"}</h2>
          <p class="text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed mb-8">${isFilterActive ? "タグや検索条件を変更して再度お試しください。" : "連絡先ファイルをドラッグ＆ドロップするか、<br>上の入力欄から最初のブロックを作成しましょう。"}</p>
          ${
            !isFilterActive
              ? `
          <button onclick="document.getElementById('new-block-memo').focus()" class="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-2.5 rounded-full text-sm font-bold shadow-xl shadow-slate-900/20 dark:shadow-white/10 hover:shadow-2xl hover:-translate-y-0.5 transition-all active:scale-95 flex items-center gap-2">
            <span class="text-xl leading-none font-light">+</span> 新しいブロックを作る
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

  // データがある時はコントロールを表示
  if (blockControls) {
    blockControls.classList.remove("hidden");
    blockControls.classList.add("flex");
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
            <span class="text-sm font-medium text-slate-600 dark:text-slate-300 group-hover:text-primary transition-colors truncate" title="クリックでリスト表示">${escapeHtml(tag)}</span>
            <span class="text-[10px] tabular-nums tracking-tight font-bold text-slate-400 bg-slate-100 dark:bg-dark-bg px-1.5 py-0.5 rounded group-hover:bg-white dark:group-hover:bg-dark-surface-hover transition-colors">${data.count}人</span>
          </div>
          <button class="export-btn opacity-0 group-hover:opacity-100 text-slate-400 hover:text-primary transition-opacity ml-2 shrink-0 p-1" title="vCardエクスポート">
            <svg class="w-4 h-4"><use href="#icon-download"></use></svg>
          </button>
        `;
        a.querySelector("div").onclick = (e) => {
          e.preventDefault();
          showTagModal(tag, data);
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
          <span class="text-sm font-bold text-slate-700 truncate">${escapeHtml(tag)}</span>
          <span class="text-xs tabular-nums tracking-tight text-slate-500">${data.count}人</span>
          <button class="export-btn absolute top-2 right-2 text-slate-300 hover:text-primary transition-colors p-1" title="vCardエクスポート">
            <svg class="w-4 h-4"><use href="#icon-download"></use></svg>
          </button>
        `;
        btn.onclick = () => showTagModal(tag, data);
        btn.querySelector(".export-btn").onclick = (e) => {
          e.stopPropagation();
          exportTagVCard(tag, data.items);
        };
        grid.appendChild(btn);
      });

    mobileTagContainer.appendChild(grid);
    // スマホではスクロールせずにアクセスできるよう、一番「上」に挿入する
    mainContainer.insertBefore(mobileTagContainer, mainContainer.firstChild);
  }

  // 数字のアニメーション更新
  animateTotal(Math.round(grandTotal));

  renderMemoSuggestions();

  if (focusBlockId) {
    const targetInput = document.querySelector(
      `#block-form-${focusBlockId} .item-role`,
    );
    if (targetInput) {
      targetInput.focus({ preventScroll: false });
    }
  }

  // --- TOC（目次）の自動ハイライト (Scrollspy) ---
  if (window.tocObserver) window.tocObserver.disconnect();

  window.tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          document.querySelectorAll(".toc-item").forEach((el) => {
            el.classList.remove("text-primary", "bg-primary-50", "font-bold");
            el.classList.add("text-slate-500", "font-medium");
          });
          const activeToc = document.querySelector(
            `.toc-item[href="#${entry.target.id}"]`,
          );
          if (activeToc) {
            activeToc.classList.remove("text-slate-500", "font-medium");
            activeToc.classList.add(
              "text-primary",
              "bg-primary-50",
              "font-bold",
            );
            const tocContainer = document.getElementById("toc-container");
            if (tocContainer && !tocContainer.matches(":hover")) {
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
    let roleDisp = `<input type="text" data-id="${item.id}" data-field="role" list="role-suggestions" value="${escapeHtml(roleStr)}" placeholder="役割/役職" spellcheck="false" autocomplete="off" onfocus="this.select()" oninput="setDirty(true)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.closest('.group/item').querySelector('[data-field=\\'memo\\']').focus();}" onblur="updateRecord(${item.id}, 'role', this.value, this)" class="text-xs text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded mr-2 outline-none focus:ring-2 focus:ring-blue-400 focus:bg-blue-100 cursor-text transition-colors hover:bg-blue-100 w-[60px] sm:w-20 shrink-0 text-center placeholder-blue-300">`;

    itemsHtml += `
      <div class="flex justify-between items-center px-4 sm:px-8 py-3.5 border-b border-slate-50 dark:border-dark-border/30 group/item hover:bg-slate-50/80 dark:hover:bg-dark-surface-hover transition-colors">
        <div class="flex items-center flex-1 min-w-0">
          ${avatarHtml}
          ${roleDisp}
            <span data-id="${item.id}" data-field="memo" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '') this.innerHTML = ''; setDirty(true);" onpaste="handlePlainTextPaste(event)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'memo', this.innerText, this)" class="text-slate-700 dark:text-slate-200 font-medium block min-w-0 flex-1 truncate outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-16 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:content-['✎_名前を入力'] empty:before:text-slate-400 empty:before:text-xs empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(item.memo)}</span>
        </div>
        <div class="flex items-center space-x-2 sm:space-x-4 ml-2 sm:ml-auto shrink-0 min-w-0">
          <span data-id="${item.id}" data-field="contact_info" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '') this.innerHTML = ''; setDirty(true);" onfocus="window.getSelection().selectAllChildren(this)" onpaste="handlePlainTextPaste(event)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'contact_info', this.innerText, this)" class="font-mono text-sm tracking-tight text-slate-600 dark:text-slate-400 outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors block truncate max-w-[120px] sm:max-w-[220px] empty:inline-block empty:min-w-20 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:content-['✎_電話/Email'] empty:before:text-slate-300 empty:before:text-xs empty:before:font-sans empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(item.contact_info || "")}</span>
          <div class="flex items-center space-x-1 md:opacity-0 md:group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity">
            <button onclick="shareContact(${item.id})" aria-label="共有" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-1 transition-colors" title="vCardを共有">
              <svg class="w-4 h-4"><use href="#icon-share"></use></svg>
            </button>
            <button onclick="showContactDetail(${item.id})" aria-label="詳細" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-1 transition-colors" title="詳細編集">
              <svg class="w-4 h-4"><use href="#icon-pencil"></use></svg>
            </button>
            <button onclick="duplicateRecord(${item.id})" aria-label="複製" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-1 transition-colors" title="複製">
              <svg class="w-4 h-4"><use href="#icon-copy"></use></svg>
            </button>
            <button onclick="deleteRecord(${item.id})" aria-label="削除" class="text-slate-300 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-200 rounded transition-colors text-xl leading-none px-1 py-0.5 -mt-0.5" title="削除">&times;</button>
          </div>
        </div>
      </div>
    `;
  });

  const isCollapsed = collapsedBlocks.has(block.id);
  const maxH = isCollapsed ? "0px" : "99999px";
  const op = isCollapsed ? "0" : "1";
  const iconRotation = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";

  blockEl.innerHTML = `
    <button onclick="event.stopPropagation(); saveTemplate(${block.id})" class="absolute -top-3 -left-3 opacity-100 md:opacity-0 group-hover/block:opacity-100 bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-400 hover:text-primary hover:border-primary/50 hover:shadow-[0_0_15px_rgba(15,98,254,0.3)] hover:scale-110 p-2 rounded-xl transition-all duration-300 cursor-pointer flex items-center justify-center z-10" title="このブロックをテンプレートとして保存">
      <svg class="w-5 h-5"><use href="#icon-squares-plus"></use></svg>
    </button>
    <div class="bg-white dark:bg-dark-surface rounded-xl shadow-sm border border-slate-200 dark:border-dark-border overflow-hidden transition-all hover:border-slate-300 dark:hover:border-dark-border-hover hover:shadow-md">
    <div onclick="toggleBlock(${block.id})" class="bg-slate-50/50 dark:bg-dark-surface px-4 sm:px-8 py-5 border-b border-slate-100 dark:border-dark-border flex justify-between items-start transition-colors cursor-pointer select-none group/header hover:bg-slate-100 dark:hover:bg-dark-surface-hover">

      <div class="flex flex-col overflow-hidden w-full">
        <div class="flex items-center gap-3">
          <svg id="block-icon-${block.id}" class="w-5 h-5 text-slate-400 transition-transform duration-200 shrink-0" style="transform: ${iconRotation};"><use href="#icon-chevron-down"></use></svg>
          <h2 data-id="${block.id}" data-field="memo" contenteditable="true" spellcheck="false" oninput="if(this.innerText.trim() === '') this.innerHTML = ''; setDirty(true);" onpaste="handlePlainTextPaste(event)" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault(); const form = document.getElementById('block-form-${block.id}'); if(form){ form.querySelector('.item-role').focus(); } else { this.blur(); } }" onblur="updateRecord(${block.id}, 'memo', this.innerText, this)" class="text-xl font-extrabold text-slate-900 dark:text-white tracking-tight outline-none focus:bg-white dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-primary/30 px-1 rounded cursor-text truncate transition-colors empty:inline-block empty:min-w-24 empty:bg-slate-200 dark:empty:bg-dark-bg empty:before:content-['✎_グループ名'] empty:before:text-slate-400 empty:before:text-sm empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(block.memo)}</h2>
        </div>

        <!-- ★ 専用タグ入力欄 -->
        <div class="flex items-center gap-1.5 mt-1.5 ml-8 opacity-60 hover:opacity-100 focus-within:opacity-100 transition-opacity" onclick="event.stopPropagation()">
          <svg class="w-3.5 h-3.5 text-slate-400 shrink-0"><use href="#icon-tag"></use></svg>
          <input type="text" data-id="${block.id}" data-field="tags" list="tag-suggestions" spellcheck="false" autocomplete="off" value="${escapeHtml(block.tags || "")}" placeholder="カテゴリ・タグを追加 (例: ビジネス)" oninput="setDirty(true)" onblur="updateRecord(${block.id}, 'tags', this.value, this)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" class="bg-transparent border-0 focus:ring-0 p-0 text-xs text-slate-500 dark:text-slate-400 placeholder-slate-300 w-full outline-none font-medium">
        </div>
      </div>
      <div class="flex items-center shrink-0">
        <div class="font-bold tabular-nums tracking-tight text-slate-900 dark:text-white text-lg"><span id="block-total-${block.id}">${blockTotal}</span> <span class="text-slate-400 text-sm font-sans">人</span></div>
        <div class="flex items-center pl-2 border-l border-slate-200/50 dark:border-dark-border/50 ml-4 shrink-0 h-8 gap-1">
          <button onclick="event.stopPropagation(); sortBlockByDate(${block.id})" aria-label="並べ替え" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-dark-surface-hover hover:text-slate-600 dark:hover:text-slate-300 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-300 transition-all cursor-pointer" title="古い順に並べ替える">
            <svg class="w-4 h-4"><use href="#icon-sort"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); shareBlock(${block.id})" aria-label="ブロックを共有" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-primary/10 hover:text-primary md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all cursor-pointer" title="グループ全員を共有">
            <svg class="w-5 h-5"><use href="#icon-share"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); deleteRecord(${block.id})" aria-label="ブロックを削除" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 transition-all cursor-pointer" title="ブロックを丸ごと削除">
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
          <button type="submit" aria-label="明細を追加" class="text-primary bg-primary/10 hover:bg-primary/20 rounded-full w-8 h-8 flex items-center justify-center text-xl leading-none font-light sm:hidden transition-colors outline-none focus:ring-2 focus:ring-primary/50 shrink-0">+</button>

          <!-- ★ カレンダーインプットを完全撤廃し、役職入力を左端に配置 -->
          <input type="text" placeholder="役割/役職" value="" list="role-suggestions" spellcheck="false" autocomplete="off" oninput="setDirty(true)" onfocus="this.select()" onkeydown="if(event.key==='Enter'){ if(event.isComposing) return; event.preventDefault();this.closest('form').querySelector('.item-memo').focus();}" class="item-role bg-transparent border-0 focus:ring-0 p-0 text-slate-600 dark:text-slate-300 placeholder-slate-400 w-16 sm:w-24 shrink-0 text-sm outline-none text-center min-w-0">
        </div>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 pl-6 mt-2 sm:mt-0 min-w-0 border-l border-slate-200/50 dark:border-dark-border/50 sm:pl-3 relative group/paste">
          <input type="text" placeholder="氏名を追加... (署名をペースト可)" list="memo-suggestions" spellcheck="false" autocomplete="off" onpaste="handleSmartPaste(event)" oninput="setDirty(true)" onblur="autoSuggestRole(this)" onfocus="setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);" onkeydown="if(event.key==='Enter'){ if(event.isComposing) return; event.preventDefault();this.closest('form').querySelector('.item-contact').focus();}" class="item-memo bg-transparent border-0 focus:ring-0 p-0 text-slate-900 dark:text-white placeholder-slate-400 flex-1 text-sm font-medium outline-none min-w-0">
          <svg class="w-4 h-4 text-primary absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/paste:opacity-30 pointer-events-none transition-opacity" title="署名テキストをペーストすると自動解析します"><use href="#icon-sparkles"></use></svg>
          <input type="text" inputmode="email" placeholder="Tel/Email..." spellcheck="false" autocomplete="off" class="item-contact bg-transparent border-0 focus:ring-0 p-0 text-right font-mono text-slate-600 dark:text-slate-400 placeholder-slate-400 w-28 sm:w-48 shrink-0 text-sm outline-none min-w-0" oninput="setDirty(true)" onfocus="setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);" onkeydown="if(event.isComposing){ return; } if((event.key==='Enter') || (event.key==='Tab' && !event.shiftKey)){ const form = this.closest('form'); if(form.querySelector('.item-memo').value.trim() || this.value.trim()){ event.preventDefault(); form.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true})); } }">
        </div>
        <button type="submit" class="hidden">追加</button>
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
  let blockMemo = "名称未設定";
  let blockStmt;
  try {
    blockStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
    blockStmt.bind([blockId]);
    if (blockStmt.step()) {
      blockMemo = blockStmt.get()[0] || "名称未設定";
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
      "SELECT memo, role, contact_info, tags FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
    );
    itemsStmt.bind([blockId]);
    while (itemsStmt.step()) {
      const row = itemsStmt.get();
      items.push({
        memo: row[0],
        role: row[1],
        contact_info: row[2],
        tags: row[3],
      });
    }
  } finally {
    if (itemsStmt) itemsStmt.free();
  }

  let tplName = await requestCustomPrompt(
    "テンプレートの保存",
    "このブロックをテンプレートとして保存します。\n呼び出し用の名前を入力してください:",
    blockMemo + " (雛形)",
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
  alert(
    `✅ テンプレート「${tplName}」を保存しました。\nコマンドパレット(Cmd+K)からいつでも一発で呼び出せます。`,
  );
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
    alert(
      "テンプレートデータの読み込みに失敗しました。データが破損している可能性があります。",
    );
    return;
  }

  // 万が一パース結果がオブジェクト等で配列でない場合のクラッシュ(TypeError)を防止
  if (!Array.isArray(tplData)) {
    alert("テンプレートデータが破損しています（配列ではありません）。");
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
  const parentId = parentRes[0].values[0][0];

  // 今日の日付を取得 (子要素の created_at 用)
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;

  // 子要素を展開して一気にINSERT
  let insertStmt = null;
  try {
    insertStmt = db.prepare(
      "INSERT INTO records (parent_id, memo, contact_info, role, created_at, tags) VALUES (?, ?, ?, ?, ?, ?)",
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
    }
  } finally {
    if (insertStmt) insertStmt.free();
  }

  setDirty(true);
  renderData(parentId);
}

// 3.5 データの削除（DELETE文の実行）
function deleteRecord(id, force = false) {
  if (!db) return;

  // ブロックかメンバーかを判定し、子供の数を数える
  let isParent = false;
  let childCount = 0;
  try {
    const pStmt = db.prepare("SELECT parent_id FROM records WHERE id = ?");
    pStmt.bind([id]);
    if (pStmt.step() && pStmt.get()[0] === null) {
      isParent = true;
      const cStmt = db.prepare(
        "SELECT COUNT(*) FROM records WHERE parent_id = ?",
      );
      cStmt.bind([id]);
      if (cStmt.step()) childCount = cStmt.get()[0];
      cStmt.free();
    }
    pStmt.free();
  } catch (e) {}

  if (!force) {
    const msg =
      isParent && childCount > 0
        ? `⚠️ 警告\n含まれるメンバー ${childCount} 人をすべて削除しますか？\nこの操作は元に戻せません。`
        : "この記録を削除しますか？";

    if (!confirm(msg)) return;
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
  delete lastUsedDates[id];

  setDirty(true);
  renderData();
}

// 手動でブロック内の明細を日付順に並べ替える
function sortBlockByDate(blockId) {
  if (!db) return;
  if (
    !confirm(
      "このブロック内の明細を「日付が古い順」に並べ替えますか？\n（同じ日付の場合は入力した順になります）",
    )
  )
    return;

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
    updateStmt = db.prepare("UPDATE records SET sort_order = ? WHERE id = ?");
    items.forEach((item, index) => {
      updateStmt.run([index, item.id]);
    });
    setDirty(true);
    renderData();
    showToast("日付順に並べ替えました", "🧹");
  } catch (e) {
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
      const newId = res[0].values[0][0];

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

      showToast("明細を複製しました", '<span class="text-green-400">📋</span>');

      // 画面の再描画が終わった直後に、新しい行の名前にフォーカスを当てて全選択する
      requestAnimationFrame(() => {
        const newMemoEl = document.querySelector(
          `span[data-id="${newId}"][data-field="memo"]`,
        );
        if (newMemoEl) {
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

    if (lastSavedPassword !== "" && currentPassword === "") {
      if (
        !confirm(
          "⚠️ 警告 ⚠️\nパスワードが空になっています。\nこのまま保存すると、ファイルの暗号化が解除され「平文」で保存されます。\n\n本当に暗号化を解除して保存しますか？",
        )
      ) {
        document.getElementById("file-password").value = lastSavedPassword;
        isSaving = false;
        return;
      }
    }

    if (currentPassword !== "" && currentPassword !== lastSavedPassword) {
      const confirmPw = await requestPasswordPrompt(
        "🔒 新しいパスワードを設定（または変更）します。\n確認のため、同じパスワードをもう一度入力してください:",
      );
      if (confirmPw === null) {
        isSaving = false;
        return;
      }
      if (confirmPw !== currentPassword) {
        alert("❌ パスワードが一致しません。保存を中止しました。");
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
          `データを "${escapeHtml(a.download)}" としてダウンロードしました`,
          '<span class="text-green-400">💾</span>',
        );
        showSaveSuccessFeedback();
        lastSavedPassword = currentPassword;
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
            throw new Error("書き込み権限が拒否されました");
          }
        }
      } catch (e) {
        alert(
          "ファイルの書き込み権限が取得できませんでした。時間経過によりブラウザが権限を取り消した可能性があります。\n\n「複製して保存する (Save As)」をお試しください。",
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
      `データを "${escapeHtml(fileHandle.name)}" に保存しました`,
      '<span class="text-green-400">💾</span>',
    );
    showSaveSuccessFeedback();
    lastSavedPassword = currentPassword;
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
  try {
    const file = await handle.getFile();

    // 巨大ファイルによるOOMクラッシュを防止
    if (file.size > 50 * 1024 * 1024) {
      alert(
        "ファイルサイズが大きすぎます（50MB上限）。不正なファイルの可能性があります。",
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
            lastSavedPassword = password;
          }
        } catch (err) {
          const msg =
            attempt > 0
              ? "❌ パスワードが間違っています。もう一度入力してください:"
              : "ファイルは暗号化されています。解除パスワードを入力してください:";
          password = await requestPasswordPrompt(msg);
          if (password === null) return; // キャンセルして処理を中断
          attempt++;
        }
      }
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
    lastUsedDates = {};
    collapsedBlocks.clear();
    currentActiveTag = null;
    currentDisplayedTotal = 0;

    // UI更新の前にハンドルをセットして正しいファイル名を反映させる
    fileHandle = handle;
    setDirty(false);
    await clearDraft();

    showToast(
      `ファイル "${escapeHtml(file.name)}" を読み込みました`,
      '<span class="text-blue-400">📂</span>',
    );

    renderData();
  } catch (err) {
    console.log("Open cancelled or failed.", err);
    alert("ファイルの読み込みに失敗しました。");
  }
}

// 5.1 「開く」ボタンから File System Access API を使った読み込み
async function loadPeopleFile() {
  if (isDirty) {
    if (
      !confirm(
        "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
      )
    )
      return;
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
    input.accept = ".people";
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // ダミーハンドルを作って共通処理へ流す
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    };
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
      ? `カテゴリ「${currentActiveTag}」`
      : "すべての連絡先";
    infoEl.innerHTML = `💡 現在表示中の <b>「${periodText}」</b> が出力されます。`;
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  document.getElementById("app-ui")?.setAttribute("inert", "");
}

function closeExportModal() {
  const modal = document.getElementById("export-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  document.getElementById("app-ui")?.removeAttribute("inert");
}

function executeExport() {
  const format = document.getElementById("export-format").value;
  closeExportModal();
  exportCSV(format);
}

// 6. CSVエクスポート
function exportCSV(format = "vcard") {
  if (!db) return;

  if (format === "vcard") {
    exportVCard();
  } else if (format === "google_csv") {
    exportGoogleCSV();
  } else if (format === "outlook_csv") {
    exportOutlookCSV();
  } else {
    alert("選択されたフォーマットはサポートされていません。");
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
    cleanName = cleanName.replace(/[\r\n]+/g, " ");
    cleanOrg = cleanOrg.replace(/[\r\n]+/g, " ");
    cleanRole = cleanRole.replace(/[\r\n]+/g, " ");
    cleanContact = cleanContact.replace(/[\r\n]+/g, " ");

    if (!cleanName) {
      if (cleanOrg) {
        cleanName = cleanOrg + "のメンバー";
      } else {
        cleanName = "名称未設定";
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
    vcardData += `N:${cleanName};;;;\r\n`;
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
        const v = f.field_value;
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
            vcardData += `NOTE:${v.replace(/\n/g, "\\n")}\r\n`;
            break;
          case "birthday":
            vcardData += `BDAY:${v}\r\n`;
            break;
          case "social_x":
          case "social_facebook":
          case "social_instagram":
          case "social_line":
            vcardData += `X-SOCIALPROFILE;type=${f.field_key.replace("social_", "")}:${v}\r\n`;
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
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, vcardData], {
    type: "text/vcard;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const dateSuffix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
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
    alert("エクスポートする連絡先がありません。");
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
        item.name.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
      ).map((t) => t.replace(/[#＃]/, ""));
      const orgMemoTags = (
        item.org.match(/[#＃][^\s　,、。\.・()（）「」]+/g) || []
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
    alert("エクスポートする連絡先がありません。");
    return;
  }

  const vcardData = generateVCardData(filteredItems);
  triggerVCardDownload(vcardData, "contacts_all");
}

// 特定のタグだけのメンバーをエクスポート
function exportTagVCard(tag, dataItems) {
  if (!dataItems || dataItems.length === 0) return;
  if (
    !confirm(
      `タグ「${tag}」に所属する ${dataItems.length} 人をvCardとして抽出・出力しますか？`,
    )
  )
    return;

  // 各アイテムに詳細フィールドを付与
  const enrichedItems = dataItems.map((item) => ({
    ...item,
    fields: getContactFields(item.id),
  }));

  const vcardData = generateVCardData(enrichedItems);
  const safeTag = tag.replace(/[\\/:*?"<>|]/g, "_"); // OSでファイル名に使えない禁則文字のみを除去
  triggerVCardDownload(vcardData, `contacts_${safeTag}`);
}

// 7. CSVインポート
function importCSV(event) {
  const file = event.target.files[0];
  const inputElement = event.target; // 同期的に退避させておく
  if (!file) return;

  // 5MB (5 * 1024 * 1024 bytes) を超える場合は警告してクラッシュを防ぐ
  if (file.size > 5242880) {
    alert(
      "ファイルサイズが大きすぎます（5MB上限）。ブラウザがクラッシュするのを防ぐため読み込みを中止しました。",
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
    alert(
      "ファイルの読み込みに失敗しました。ファイルが破損しているか、メモリが不足しています。",
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
  document.getElementById("app-ui")?.setAttribute("inert", "");
  updateCSVPreview(); // プレビューとマッピングを初期描画
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
    let currentCellChars = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      // BOMのスキップ
      if (i === 0 && char.charCodeAt(0) === 0xfeff) continue;

      if (char === '"' && nextChar === '"') {
        currentCellChars.push('"');
        i++; // エスケープされたクオートをスキップ
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        currentLine.push(currentCellChars.join(""));
        currentCellChars = [];
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") i++; // \r\n の対応
        currentLine.push(currentCellChars.join(""));
        pendingCSVData.push(currentLine);
        currentLine = [];
        currentCellChars = [];
      } else {
        currentCellChars.push(char);
      }
    }
    // 最後の行をプッシュ
    if (currentLine.length > 0 || currentCellChars.length > 0) {
      currentLine.push(currentCellChars.join(""));
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
    document.getElementById("map-date").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    if (document.getElementById("map-role"))
      document.getElementById("map-role").innerHTML =
        `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-memo").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-contact").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    const previewHead = document.getElementById("csv-preview-head");
    if (previewHead) previewHead.innerHTML = "";
    previewBody.innerHTML = `<tr><td colspan="99" class="p-4 text-center text-red-500">文字コード「${encoding}」でのデコードに失敗しました。ファイルが破損しているか、文字コードの指定が間違っています。</td></tr>`;
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

  let optionsHtml = `<option value="-1">-- 選択しない --</option>`;
  for (let i = 0; i < maxCols; i++) {
    const sample =
      firstRow[i] !== undefined ? firstRow[i].substring(0, 15) : "";
    optionsHtml += `<option value="${i}">列 ${i + 1} (${sample})</option>`;
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

  if (mapDate.selectedIndex < 1 && maxCols >= 1) mapDate.value = "0";
  if (mapRole && mapRole.selectedIndex < 1 && maxCols >= 4) mapRole.value = "3"; // 4列以上あれば適当に
  if (mapMemo.selectedIndex < 1 && maxCols >= 2) mapMemo.value = "1";
  if (mapContact.selectedIndex < 1 && maxCols >= 3) mapContact.value = "2";

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
  let thHtml = `<th class="px-3 py-2 w-8 text-center border-r border-gray-200">行</th>`;
  for (let i = 0; i < maxCols; i++) {
    let label = "";
    let badgeClass = "bg-slate-200 text-slate-500";
    if (i === mapDate) {
      label = "日付";
      badgeClass = "bg-blue-100 text-blue-700";
    } else if (i === mapRole) {
      label = "役割/役職";
      badgeClass = "bg-purple-100 text-purple-700";
    } else if (i === mapMemo) {
      label = "メモ";
      badgeClass = "bg-green-100 text-green-700";
    } else if (i === mapContact) {
      label = "連絡先";
      badgeClass = "bg-orange-100 text-orange-700";
    }

    if (label) {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">${label}</span></th>`;
    } else {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-medium ${badgeClass}">列 ${i + 1}</span></th>`;
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
  document.getElementById("app-ui")?.removeAttribute("inert");
  pendingCSVData = [];
  pendingCSVBuffer = null;
}

function executeCSVImport() {
  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapRoleEl = document.getElementById("map-role");
  const mapRole = mapRoleEl ? parseInt(mapRoleEl.value, 10) : -1;
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapContact = parseInt(document.getElementById("map-contact").value, 10);
  const skipRows =
    parseInt(document.getElementById("csv-skip-rows").value, 10) || 0;

  if (mapMemo === -1 && mapContact === -1) {
    alert("「メモ(氏名)」または「連絡先」のいずれかの列を選択してください。");
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

  db.run("BEGIN TRANSACTION;");
  try {
    db.run("INSERT INTO records (memo, contact_info) VALUES (?, ?)", [
      "CSVインポート",
      null,
    ]);
    const parentRes = db.exec("SELECT last_insert_rowid()");
    const parentId = parentRes[0].values[0][0];

    const startIndex = Math.max(0, skipRows);

    const MAX_IMPORT_ROWS = 3000;
    const rowsToProcess = dataToImport.length - startIndex;
    if (rowsToProcess > MAX_IMPORT_ROWS) {
      alert(
        `⚠️ データが多すぎます（${rowsToProcess}行）。\nブラウザのフリーズを防ぐため、最初の${MAX_IMPORT_ROWS}行のみをインポートします。\n残りのデータはCSVを分割してインポートしてください。`,
      );
    }
    const endIndex = Math.min(
      dataToImport.length,
      startIndex + MAX_IMPORT_ROWS,
    );

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
        "SELECT 1 FROM records WHERE memo = ? AND contact_info = ? LIMIT 1",
      );
    } catch (e) {
      console.warn("インポート用SQLの準備に失敗しました", e);
    }

    for (let i = startIndex; i < endIndex; i++) {
      const cols = dataToImport[i];
      if (cols.length === 0 || cols.every((c) => !c.trim())) continue;

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
        // YYYY-MM-DD形式等のタイムゾーン問題を回避する
        if (dateStr && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr.trim())) {
          const parts = dateStr.trim().split(/[-/]/);
          parsedDate = new Date(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10) - 1,
            parseInt(parts[2], 10),
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
      `${successCount} 件のデータをインポートしました` +
      (skipCount > 0 ? `（${skipCount}件の重複をスキップ）` : "");
    showToast(msg, '<span class="text-green-400">✨</span>');
  } catch (err) {
    db.run("ROLLBACK;");
    alert("インポート中にエラーが発生しました。");
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
  const promptText = `あなたは優秀なデータ整理アシスタントです。
私がこれから提示する『乱雑な連絡先データ（または名刺情報のテキスト）』を解析し、People（連絡先管理アプリ）にインポートしやすいように、以下のヘッダーを持つ綺麗なCSVフォーマットに変換して出力してください。

【出力必須ヘッダー】
日付, 役割/役職, 氏名, 連絡先

【ルール】
1. 「日付」はわかる場合のみ YYYY-MM-DD 形式で。不明なら空欄。
2. 「連絡先」には電話番号かメールアドレスを統合して記載。
3. コードブロックを使ってCSVのみを出力してください。

それでは、以下の枠内にデータを貼り付けるので変換をお願いします。

[ここに乱雑なデータを貼り付けてください]`;

  navigator.clipboard
    .writeText(promptText)
    .then(() => {
      showToast("AI用プロンプトをコピーしました", "📋");
    })
    .catch((err) => {
      console.error("コピーに失敗しました", err);
    });
}

// 8.5 データ一覧を Markdown 形式でコピーする機能
function copyAsMarkdown() {
  if (!db) return;
  const res = db.exec(
    "SELECT c.memo, p.memo, c.role, c.contact_info FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC",
  );
  if (res.length === 0) {
    alert("コピーするデータがありません。");
    return;
  }

  let md = "## 連絡先一覧\n\n";
  res[0].values.forEach(([name, org, role, contact]) => {
    md += `- **${name}** (${org} / ${role || "役割なし"}) - ${contact || "連絡先なし"}\n`;
  });

  navigator.clipboard
    .writeText(md)
    .then(() => {
      showToast("Markdownでコピーしました", "📋");
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
    name || "連絡先の詳細";

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
    companyInput.placeholder = orgName ? `(自動: ${orgName})` : "株式会社〇〇";
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
    addDetailPhoneRow(); // 最低1行
  else phones.forEach((p) => addDetailPhoneRow(p.field_value, p.field_type));

  // メールの複数行を構築
  const emailsContainer = document.getElementById("detail-emails");
  emailsContainer.innerHTML = "";
  if (emails.length === 0) addDetailEmailRow();
  else emails.forEach((e) => addDetailEmailRow(e.field_value, e.field_type));

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  document.getElementById("app-ui")?.setAttribute("inert", "");
}

function closeContactDetail() {
  const modal = document.getElementById("contact-detail-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  document.getElementById("app-ui")?.removeAttribute("inert");
  if (preDetailActiveElement) {
    preDetailActiveElement.focus();
    preDetailActiveElement = null;
  }
}

function addDetailPhoneRow(value = "", type = "mobile") {
  const container = document.getElementById("detail-phones");
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <select class="detail-phone-type bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-700 dark:text-slate-300 rounded px-2 py-1.5 text-xs outline-none w-20 shrink-0">
      <option value="mobile" ${type === "mobile" ? "selected" : ""}>携帯</option>
      <option value="work" ${type === "work" ? "selected" : ""}>会社</option>
      <option value="home" ${type === "home" ? "selected" : ""}>自宅</option>
      <option value="other" ${type === "other" ? "selected" : ""}>その他</option>
    </select>
    <input type="tel" value="${escapeHtml(value)}" placeholder="090-xxxx-xxxx" class="detail-phone-value flex-1 bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-900 dark:text-white rounded px-2.5 py-1.5 text-sm outline-none focus:border-primary">
    <button type="button" onclick="this.parentElement.remove()" class="text-slate-300 hover:text-red-500 text-lg leading-none cursor-pointer">&times;</button>
  `;
  container.appendChild(row);
}

function addDetailEmailRow(value = "", type = "work") {
  const container = document.getElementById("detail-emails");
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <select class="detail-email-type bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-700 dark:text-slate-300 rounded px-2 py-1.5 text-xs outline-none w-20 shrink-0">
      <option value="work" ${type === "work" ? "selected" : ""}>仕事</option>
      <option value="home" ${type === "home" ? "selected" : ""}>個人</option>
      <option value="other" ${type === "other" ? "selected" : ""}>その他</option>
    </select>
    <input type="email" value="${escapeHtml(value)}" placeholder="name@example.com" class="detail-email-value flex-1 bg-slate-50 dark:bg-dark-surface-hover border border-slate-200 dark:border-dark-border text-slate-900 dark:text-white rounded px-2.5 py-1.5 text-sm outline-none focus:border-primary">
    <button type="button" onclick="this.parentElement.remove()" class="text-slate-300 hover:text-red-500 text-lg leading-none cursor-pointer">&times;</button>
  `;
  container.appendChild(row);
}

function saveContactDetail() {
  const recordId = parseInt(
    document.getElementById("detail-record-id").value,
    10,
  );
  if (!recordId || !db) return;

  // 既存のフィールドを全削除して再挿入
  deleteContactFieldsForRecord(recordId);

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
  closeContactDetail();
  renderData();
  showToast("詳細を保存しました", '<span class="text-green-400">✔</span>');
}

// --- vcfファイル入力ハンドラー ---
function handleVCFInput(event) {
  const file = event.target.files[0];
  if (!file) return;
  importVCardFile(file);
  event.target.value = "";
}

// --- Google連絡先CSVエクスポート ---
function exportGoogleCSV() {
  if (!db) return;
  const map = PLATFORM_MAPS.google_csv;
  const headers = Object.keys(map);
  const rows = [headers];

  let stmt;
  try {
    stmt = db.prepare(
      "SELECT c.id, c.memo, p.memo, c.role, c.contact_info FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC",
    );
    while (stmt.step()) {
      const [id, memo, org, role, contact] = stmt.get();
      const fields = getContactFields(id);
      const row = headers.map((h) => {
        const m = map[h];
        const match = fields.find(
          (f) =>
            f.field_key === m.key &&
            (m.type ? f.field_type === m.type : true) &&
            (m.order !== undefined ? f.sort_order === m.order : true),
        );
        if (match) return match.field_value;

        if (match && match.field_value) return match.field_value;

        if (m.key === "given_name") return memo || "";
        if (m.key === "company") return org || "";
        if (m.key === "job_title") return role || "";
        if (m.key === "email" && contact && contact.includes("@"))
          return contact;
        if (m.key === "phone" && contact && !contact.includes("@"))
          return contact;

        return "";
      });
      if (row.some((v) => v)) rows.push(row);
    }
  } finally {
    if (stmt) stmt.free();
  }

  if (rows.length <= 1) {
    alert("エクスポートする連絡先がありません。");
    return;
  }
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          let cell = v || "";
          if (/^[=+\-@\t\r]/.test(cell)) {
            cell = "'" + cell;
          }
          return `"${cell.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
  downloadCSVFile(csv, "google_contacts");
  showToast(
    `${rows.length - 1}件をGoogle連絡先CSVで出力しました`,
    '<span class="text-green-400">✔</span>',
  );
}

// --- Outlook CSVエクスポート ---
function exportOutlookCSV() {
  if (!db) return;
  const map = PLATFORM_MAPS.outlook_csv;
  const headers = Object.keys(map);
  const rows = [headers];

  let stmt;
  try {
    stmt = db.prepare(
      "SELECT c.id, c.memo, p.memo, c.role, c.contact_info FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL ORDER BY c.id ASC",
    );
    while (stmt.step()) {
      const [id, memo, org, role, contact] = stmt.get();
      const fields = getContactFields(id);
      const row = headers.map((h) => {
        const m = map[h];
        const match = fields.find(
          (f) =>
            f.field_key === m.key &&
            (m.type ? f.field_type === m.type : true) &&
            (m.order !== undefined ? f.sort_order === m.order : true),
        );
        if (match) return match.field_value;

        if (match && match.field_value) return match.field_value;

        if (m.key === "given_name") return memo || "";
        if (m.key === "company") return org || "";
        if (m.key === "job_title") return role || "";
        if (m.key === "email" && contact && contact.includes("@"))
          return contact;
        if (m.key === "phone" && contact && !contact.includes("@"))
          return contact;

        return "";
      });
      if (row.some((v) => v)) rows.push(row);
    }
  } finally {
    if (stmt) stmt.free();
  }

  if (rows.length <= 1) {
    alert("エクスポートする連絡先がありません。");
    return;
  }
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          let cell = v || "";
          if (/^[=+\-@\t\r]/.test(cell)) {
            cell = "'" + cell;
          }
          return `"${cell.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
  downloadCSVFile(csv, "outlook_contacts");
  showToast(
    `${rows.length - 1}件をOutlook CSVで出力しました`,
    '<span class="text-green-400">✔</span>',
  );
}

// CSVダウンロード共通関数
function downloadCSVFile(csvText, filenameBase) {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const ds = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
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
      console.log(`インストール結果: ${outcome}`);
      deferredPrompt = null;
    };
  }
});

window.addEventListener("appinstalled", () => {
  const installBtn = document.getElementById("install-button");
  if (installBtn) installBtn.classList.add("hidden");
  console.log("Peopleがインストールされました");
});

// --- コマンドパレット制御 ---
let isCommandPaletteOpen = false;
let selectedCommandIndex = 0;
let prePaletteActiveElement = null; // 🎯 God-Rank用: パレットを開く直前のフォーカス要素
const commandsList = [
  {
    id: "save",
    icon: '<svg class="w-5 h-5"><use href="#icon-save"></use></svg>',
    title: "データを保存する (Save)",
    shortcut: isMac ? "⌘S" : "Ctrl+S",
    action: () => savePeopleFile(),
  },
  {
    id: "open",
    icon: '<svg class="w-5 h-5"><use href="#icon-folder"></use></svg>',
    title: "ファイルを開く (Open)",
    shortcut: isMac ? "⌘O" : "Ctrl+O",
    action: () => loadPeopleFile(),
  },
  {
    id: "saveas",
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: "複製して保存する (Save As)",
    shortcut: isMac ? "⇧⌘S" : "Ctrl+Shift+S",
    action: () => savePeopleFile(true),
  },
  {
    id: "new",
    icon: '<svg class="w-5 h-5"><use href="#icon-sparkles"></use></svg>',
    title: "新しいグループを作成する (New)",
    shortcut: isMac ? "⌥N" : "Alt+N",
    action: () => document.getElementById("new-block-memo").focus(),
  },
  {
    id: "export",
    icon: '<svg class="w-5 h-5"><use href="#icon-download"></use></svg>',
    title: "全件をvCardエクスポート",
    action: () => exportVCard(),
  },
  {
    id: "markdown",
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: "Markdownとして一覧をコピー",
    action: copyAsMarkdown,
  },
  {
    id: "expandall",
    icon: '<svg class="w-5 h-5"><use href="#icon-chevron-down"></use></svg>',
    title: "すべてのグループを展開する",
    action: () => toggleAllBlocks(false),
  },
  {
    id: "collapseall",
    icon: '<svg class="w-5 h-5" style="transform: rotate(-90deg)"><use href="#icon-chevron-down"></use></svg>',
    title: "すべてのグループを折りたたむ",
    action: () => toggleAllBlocks(true),
  },
  {
    id: "import_vcf",
    icon: '<svg class="w-5 h-5 text-green-500"><use href="#icon-import"></use></svg>',
    title: "vCard (.vcf) をインポート (Apple/Android)",
    action: () => document.getElementById("vcf-input").click(),
  },
  {
    id: "import_csv",
    icon: '<svg class="w-5 h-5 text-blue-500"><use href="#icon-import"></use></svg>',
    title: "CSV をインポート (Google/Outlook/汎用)",
    action: () => document.getElementById("csv-input").click(),
  },
  {
    id: "export_google",
    icon: '<svg class="w-5 h-5 text-red-500"><use href="#icon-export"></use></svg>',
    title: "Google連絡先 CSV としてエクスポート",
    action: () => exportGoogleCSV(),
  },
  {
    id: "export_outlook",
    icon: '<svg class="w-5 h-5 text-blue-600"><use href="#icon-export"></use></svg>',
    title: "Outlook CSV としてエクスポート",
    action: () => exportOutlookCSV(),
  },
  {
    id: "export_vcard",
    icon: '<svg class="w-5 h-5 text-purple-500"><use href="#icon-export"></use></svg>',
    title: "Apple/Android用 vCard (.vcf) としてエクスポート",
    action: () => exportVCard(),
  },
];

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
    document.getElementById("app-ui")?.setAttribute("inert", "");
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
    document.getElementById("app-ui")?.removeAttribute("inert");
    if (prePaletteActiveElement) {
      prePaletteActiveElement.focus();
      prePaletteActiveElement = null;
    }
  }
}

function getDynamicCommands() {
  let dynamicCommands = [...commandsList];
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
                await requestCustomPrompt(
                  "テンプレートの削除",
                  `テンプレート「${row[1]}」を削除しますか？`,
                  "",
                  true,
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
      const conditions = terms
        .map(() => "(LOWER(c.memo) LIKE ? OR LOWER(c.contact_info) LIKE ?)")
        .join(" AND ");
      const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);

      const pCond = terms.map(() => "(LOWER(memo) LIKE ?)").join(" AND ");
      const pParams = terms.flatMap((t) => [`%${t}%`]);

      stmt = db.prepare(
        `SELECT id, memo, '', id FROM records WHERE parent_id IS NULL AND ${pCond} UNION SELECT c.id, c.memo, p.memo, p.id FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL AND ${conditions} LIMIT 8`,
      );
      stmt.bind([...pParams, ...params]);
      while (stmt.step()) {
        const [id, name, org, parentId] = stmt.get();
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
    const dropOverlay = document.getElementById("drop-overlay");
    if (dropOverlay && !dropOverlay.classList.contains("hidden")) {
      dropOverlay.classList.add("hidden");
      dropOverlay.classList.remove("flex");
      dragCounter = 0;
      return;
    }

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
    if (!document.getElementById("tag-modal").classList.contains("hidden")) {
      closeTagModal();
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
      (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")
    ) {
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
    item.style.display = text.includes(q) ? "block" : "none";
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
const bc = new BroadcastChannel("grindpeople_app_channel");
let hasAlerted = false;

bc.onmessage = (e) => {
  if (e.data === "ping") {
    bc.postMessage("pong"); // すでに開いているタブが応答する
  } else if (e.data === "pong") {
    // 自分が後から開いたタブだった場合
    if (!hasAlerted) {
      hasAlerted = true;
      alert(
        "⚠️ Peopleは既に別のタブまたはウィンドウで開かれています。\n\nデータ競合（バックアップの巻き戻り）を防ぐため、このタブでの編集は行わないでください。",
      );
      document.body.style.opacity = "0.5";
      document.body.style.pointerEvents = "none";
    }
  }
};
bc.postMessage("ping");

document.getElementById("cmd-input")?.addEventListener("input", (e) => {
  selectedCommandIndex = 0;
  renderCommandList(e.target.value);
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
  business: [
    "代表取締役",
    "取締役",
    "部長",
    "課長",
    "マネージャー",
    "営業",
    "エンジニア",
    "デザイナー",
  ],
  community: [
    "代表",
    "幹事",
    "メンバー",
    "上級",
    "中級",
    "初級",
    "コーチ",
    "ビジター",
  ],
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
    roleDictionaries.community || ["役割なし"];

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
  document.getElementById("app-ui")?.setAttribute("inert", "");
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
  document.getElementById("app-ui")?.removeAttribute("inert");
  // 変更を保存せずに閉じた場合は、元の状態に戻す
  loadCustomDict();
}

function saveCustomDictAndClose() {
  if (!saveCustomDict()) return; // 失敗時は閉じない

  const modal = document.getElementById("role-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  document.getElementById("app-ui")?.removeAttribute("inert");
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
    const title = item.hidden ? "表示する" : "非表示にする";
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
        <button onclick="deleteCustomDictItem(${index})" class="text-slate-300 hover:text-red-500 transition-colors shrink-0 ml-1" title="完全に削除する">
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

function deleteCustomDictItem(index) {
  if (
    confirm(`「${customRoleDict[index].name}」を辞書から完全に削除しますか？`)
  ) {
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

// --- ハッシュタグモーダル制御 ---
function showTagModal(tag, data) {
  const modal = document.getElementById("tag-modal");
  document.getElementById("tag-modal-title").textContent = tag;
  document.getElementById("tag-modal-total").textContent = data.count + "人";

  const exportBtn = document.getElementById("tag-modal-export-btn");
  if (exportBtn) {
    exportBtn.onclick = () => exportTagVCard(tag, data.items);
  }

  const tbody = document.getElementById("tag-modal-body");
  tbody.innerHTML = "";

  // 日付の降順にソートして明細を表示
  const sortedItems = data.items.sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""),
  );

  sortedItems.forEach((item) => {
    let dateDisp = "日付なし";
    if (item.date) {
      const parts = item.date.split(" ")[0].split("-");
      if (parts.length === 3)
        dateDisp = `${escapeHtml(parts[1])}/${escapeHtml(parts[2])}`;
    }

    tbody.innerHTML += `
      <tr class="hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0">
        <td class="py-4 px-6 w-20 text-xs text-slate-400 font-mono">${dateDisp}</td>
        <td class="py-4 px-4 text-slate-700 font-medium">${escapeHtml(item.memo)}</td>
        <td class="py-4 px-6 text-right tabular-nums tracking-tight font-bold text-slate-600">${escapeHtml(item.contact_info)}</td>
      </tr>
    `;
  });

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  lockScroll();
  document.getElementById("app-ui")?.setAttribute("inert", "");
}

function closeTagModal() {
  const modal = document.getElementById("tag-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  unlockScroll();
  document.getElementById("app-ui")?.removeAttribute("inert");
}

if (!window.isSecureContext) {
  alert(
    "⚠️ セキュリティ警告 ⚠️\n\n現在のアクセス環境 (HTTP) では、ブラウザのセキュリティ制限によりファイルの読み書きや暗号化機能がブロックされます。\n\nGrindPeopleを正常に動作させるには、必ず「HTTPS」環境にアップロードするか、「localhost」で実行してください。",
  );
  showToast(
    "エラー: HTTPS環境またはlocalhostでの実行が必要です",
    '<span class="text-red-400">⚠️</span>',
    "warning",
  );
} else {
  // DOMとすべてのCDNスクリプトの読み込みが完了してからSQLiteを起動する (ReferenceError防止)
  document.addEventListener("DOMContentLoaded", initSQLite);
}

// --- ファイル固有の設定を読み込んでUIに反映する ---
function loadSettingsFromDb() {
  loadCustomDict();
  const savedDict = getDbSetting("roleDict", "custom");
  const dictSelect = document.getElementById("dict-select");
  if (dictSelect) dictSelect.value = savedDict;
  renderRoleSuggestions(savedDict);

  // 💡 ダークモード状態の復元
  const dbTheme = getDbSetting("theme");
  if (dbTheme) {
    if (dbTheme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }
}

// ページ離脱時の警告（データ未保存防止）
window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "未保存の変更があります";
    return "未保存の変更があります";
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
  closeTagModal();
  closeRoleDictEditor();

  // 拡張子に応じて処理を分岐
  if (file.name.endsWith(".people")) {
    if (isDirty) {
      if (
        !confirm(
          "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
        )
      )
        return;
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
  } else if (file.name.endsWith(".vcf")) {
    // vCardファイルのドラッグ＆ドロップインポート
    await importVCardFile(file);
  } else if (file.name.endsWith(".csv")) {
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
    alert(
      "サポートされていないファイルです。.people または .csv 形式のファイルをドロップしてください。",
    );
  }
});

// OSを判定してショートカットキーのUI表示を最適化
const shortcutEl = document.getElementById("cmd-shortcut-key");
if (shortcutEl) {
  shortcutEl.textContent = isMac ? "⌘K" : "Ctrl+K";
}

const btnSaveTooltip = document.getElementById("btn-save");
if (btnSaveTooltip) btnSaveTooltip.title = `保存 (${isMac ? "⌘S" : "Ctrl+S"})`;

const btnOpenTooltip = document.querySelector(
  'button[onclick="loadPeopleFile()"]',
);
if (btnOpenTooltip) btnOpenTooltip.title = `開く (${isMac ? "⌘O" : "Ctrl+O"})`;

// --- 最後の砦：タブ閉じ/バックグラウンド移行時の強制バックアップ ---
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isDirty && db) {
    try {
      // 【追加】パスワードが設定されている場合は、平文でのバックアップを絶対に禁止する
      const currentPassword = document.getElementById("file-password").value;
      if (currentPassword) {
        console.warn(
          "暗号化が有効なため、情報漏洩を防ぐ目的で平文の緊急バックアップを破棄しました。",
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
        console.warn("終了時の緊急バックアップがブラウザに拒否されました");
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
    name: memo || "Unknown",
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
        title: memo || "Contact",
      });
      showToast("連絡先を共有しました", "✨");
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

async function shareBlock(blockId) {
  if (!db) return;
  const blockStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
  blockStmt.bind([blockId]);
  if (!blockStmt.step()) return;
  const blockMemo = blockStmt.get()[0] || "group";
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
      name: row[1] || "Unknown",
      org: blockMemo,
      role: row[3],
      contact_info: row[2],
      fields: getContactFields(row[0]),
    });
  }
  itemsStmt.free();

  if (dataItems.length === 0) {
    showToast("共有する連絡先がありません", "⚠️", "warning");
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
      showToast("グループを共有しました", "✨");
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
