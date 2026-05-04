let db = null; // SQLiteデータベースのインスタンス
let SQL = null; // sql.jsのモジュール
let fileHandle = null; // File System Access APIのファイルハンドル
let isDirty = false; // 未保存の変更があるかどうか
let pendingCSVData = []; // CSVパース結果の一時保存
let lastUsedDates = {}; // ブロックごとの最終使用日付を記憶
let pendingCSVBuffer = null; // CSVのバイナリデータ
let currentDisplayedTotal = 0; // カウントアップ用
let collapsedBlocks = new Set(); // 折りたたまれたブロックのIDを記憶
let totalAnimationId = null; // アニメーションの多重起動防止用ID
let draftTimer = null; // ドラフト自動保存用タイマー
let statusTimeoutId = null; // ステータスバー通知のタイマーID

let customAccountDict = []; // カスタム科目辞書の配列
// --- 自動バックアップ (IndexedDB) ロジック ---
const DB_NAME = "GrindMoneyDB";
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
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
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
    fileHandle && fileHandle.name ? fileHandle.name : "Unsaved.grind";
  const titleBase = `${fileName} - GrindMoney`;
  document.title = state ? `* ${titleBase}` : titleBase;
  const filenameBadge = document.getElementById("current-filename");
  if (filenameBadge) {
    filenameBadge.textContent = fileName;
    filenameBadge.classList.remove("hidden");
  }

  // 自動バックアップの実行 (10秒スロットル: タイピング中のフリーズ防止と確実な保存を両立)
  if (state && db) {
    if (!draftTimer) {
      draftTimer = setTimeout(async () => {
        try {
          let data = db.export();
          const password = document.getElementById("file-password").value;
          if (password) {
            data = await encryptData(data, password);
          }
          await saveDraft(data);
        } catch (e) {
          console.error("Draft save failed", e);
        } finally {
          draftTimer = null; // 保存完了後にタイマーを解放
        }
      }, 10000);
    }
  } else if (!state) {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    clearDraft();
  }
}

// --- 共通ユーティリティ ---
function escapeHtml(unsafe) {
  return (unsafe || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- 暗号化ロジック (Web Crypto API) ---
const MAGIC_BYTES = new TextEncoder().encode("GRINDENC");

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
  const isEncrypted = new TextDecoder().decode(magic) === "GRINDENC";
  if (!isEncrypted) return encryptedData; // 暗号化されていないファイルはそのまま返す

  const salt = encryptedData.slice(8, 24);
  const iv = encryptedData.slice(24, 36);
  const data = encryptedData.slice(36);

  try {
    // まず最新仕様(60万回)で復号を試みる
    const key = await deriveKey(password, salt, 600000);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      data,
    );
    return new Uint8Array(decrypted);
  } catch (e) {
    try {
      // 失敗した場合、後方互換性を保つために過去仕様(10万回)で再試行
      const legacyKey = await deriveKey(password, salt, 100000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        legacyKey,
        data,
      );
      return new Uint8Array(decrypted);
    } catch (legacyError) {
      throw new Error("パスワードが間違っているか、ファイルが破損しています。");
    }
  }
}
// --------------------------------------

// データベースの後方互換性（スキーマ移行）を担保する
function migrateDatabase() {
  if (!db) return;
  try {
    const res = db.exec("PRAGMA table_info(records)");
    if (res.length > 0) {
      const columns = res[0].values.map((col) => col[1]);
      if (!columns.includes("account")) {
        db.run("ALTER TABLE records ADD COLUMN account TEXT");
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
  } catch (e) {
    console.error("Migration error:", e);
  }
}

// 1. WebAssembly版 SQLiteエンジンの初期化
async function initSQLite() {
  try {
    const config = {
      locateFile: (filename) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm`,
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
        const isEncrypted = new TextDecoder().decode(magic) === "GRINDENC";

        if (isEncrypted) {
          let password = document.getElementById("file-password").value;
          let success = false;
          while (!success) {
            try {
              Uints = await decryptData(Uints, password);
              success = true;
              if (password)
                document.getElementById("file-password").value = password;
            } catch (err) {
              password = prompt(
                "バックアップデータは暗号化されています。解除パスワードを入力してください:",
              );
              if (password === null) {
                Uints = null;
                break; // キャンセルして処理を中断
              }
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

        const statusEl = document.getElementById("status");
        statusEl.innerHTML = `<span class="text-orange-400">↺</span> 未保存データを復元しました`;
        statusEl.style.pointerEvents = "auto";
        hideStatus();
      } catch (dbError) {
        // バックアップデータが破損している場合のセーフティーネット
        console.error(
          "ドラフトの復元に失敗しました。データが破損しています。",
          dbError,
        );
        alert("⚠️ 前回の未保存データが破損しているため、復元を中止しました。");
        await clearDraft();
        db = new SQL.Database(); // 空のDBで再スタート
        db.run(`
          CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            memo TEXT,
            amount INTEGER,
            account TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sort_order INTEGER DEFAULT 0
          );
        `);
        migrateDatabase();
      }
    } else {
      // 新規の空のデータベースを作成
      db = new SQL.Database();

      // テーブルの作成（これが .grind ファイルの骨格になります）
      db.run(`
        CREATE TABLE IF NOT EXISTS records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER,
          memo TEXT,
          amount INTEGER,
          account TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          sort_order INTEGER DEFAULT 0
        );
      `);

      migrateDatabase();

      const statusEl = document.getElementById("status");
      statusEl.innerHTML = `<span class="text-green-400">●</span> SQLite起動完了`;
      statusEl.style.pointerEvents = "auto";
    }

    document.getElementById("app-ui").classList.remove("hidden");

    // AutoAnimateの適用 (マイクロインタラクション)
    if (window.autoAnimate) {
      window.autoAnimate(document.getElementById("blocks-container"));
    }

    renderData();

    // PWAとしてOSからファイルがダブルクリックされた場合の処理
    handleLaunchFiles();
  } catch (err) {
    const statusEl = document.getElementById("status");
    statusEl.innerHTML = `<span>⚠️</span> エラー: SQLiteの起動に失敗しました`;
    statusEl.className =
      "fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-500/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-xl border border-red-600/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
    statusEl.style.pointerEvents = "auto";
    console.error(err);
  }
}

// OS上で .grind ファイルがダブルクリックされた時の処理 (File Handling API)
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
      statusEl.classList.add("opacity-0", "translate-y-4");
      statusEl.style.pointerEvents = "none";
    }
  }, 3000);
}

// 2. ブロックまたはアイテムの追加
function addBlock() {
  const memoInput = document.getElementById("new-block-memo");
  if (!memoInput.value) return;

  db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [
    memoInput.value,
    null,
  ]);
  const res = db.exec("SELECT last_insert_rowid()");
  const newId = res[0].values[0][0];

  memoInput.value = "";
  setDirty(true);
  renderData(newId);
}

// スマート入力用の数式評価 (例: "1500 / 3" -> 500)
function evaluateMath(expr) {
  if (expr === null || expr === "") return null;

  // 異常に長い入力によるフリーズを防止
  if (String(expr).length > 50) return null;

  try {
    // 全角数字・記号を半角に変換する
    let normalized = String(expr).replace(
      /[０-９＋－＊／．（）]/g,
      function (s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
      },
    );
    // 全角の「×」「÷」「ー」などを半角記号にマッピング
    normalized = normalized
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/[ー−]/g, "-");

    // 数字と四則演算記号以外を除去して安全化
    const sanitized = normalized.replace(/[^0-9+\-*/().]/g, "");
    if (!sanitized) return null;
    if (sanitized.includes("**")) return null;

    const result = new Function(`return ${sanitized}`)();
    if (!isFinite(result) || isNaN(result)) return null;
    const rounded = Math.round(result);
    if (rounded > 10000000000000 || rounded < -10000000000000) return null;
    return rounded;
  } catch (e) {
    return null;
  }
}

function addItem(parentId, memo, amount, dateStr, accountStr) {
  const safeMemo = (memo || "").trim();
  if (!safeMemo || amount === "" || amount === null) return;
  if (parentId) {
    if (dateStr) lastUsedDates[parentId] = dateStr;
  }
  insertRecord(parentId, safeMemo, amount, dateStr, accountStr);

  // フィルター外の日付を追加した場合、自動で「すべての期間」に表示を戻す
  const filterVal = document.getElementById("period-filter")?.value;
  let isOutsideFilter = false;

  if (window.currentActiveMonths) {
    // カスタム期間（1-3月、今年度など）が適用されている場合
    if (dateStr) {
      const match = window.currentActiveMonths.some((m) =>
        dateStr.startsWith(m),
      );
      if (!match) isOutsideFilter = true;
    }
  } else if (filterVal && filterVal !== "all") {
    // 単一月のドロップダウンが適用されている場合
    if (dateStr && !dateStr.startsWith(filterVal)) isOutsideFilter = true;
  }

  // フィルター外だった場合、全体表示にリセット
  if (isOutsideFilter) {
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);
    if (document.getElementById("period-filter")) {
      document.getElementById("period-filter").value = "all";
    }
    renderData(parentId);

    // ステータスバーで通知
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.innerHTML = `<span class="text-blue-400">👀</span> 追加した日付がフィルター外のため、「すべての期間」に表示を戻しました`;
      statusEl.className =
        "fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border border-slate-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
      if (typeof hideStatus === "function") hideStatus();
    }
  }
}

function insertRecord(
  parentId,
  memo,
  amountExpr,
  dateStr = null,
  accountStr = null,
) {
  const parsedAmount = evaluateMath(amountExpr);
  // 金額が入力されたのに数式のパースに失敗した場合（不正な文字列など）は弾く
  if (amountExpr !== null && amountExpr !== "" && parsedAmount === null) {
    alert("金額の入力、または数式が正しくありません。");
    return;
  }

  // もし科目が空で、かつメモが入力されていれば、DB書き込みの直前で過去履歴を自動検索して埋める
  if (!accountStr && memo) {
    let suggestStmt;
    try {
      suggestStmt = db.prepare(
        "SELECT account FROM records WHERE parent_id IS NOT NULL AND memo = ? AND account IS NOT NULL AND account != '' ORDER BY id DESC LIMIT 1",
      );
      suggestStmt.bind([memo]);
      if (suggestStmt.step()) {
        accountStr = suggestStmt.get()[0];
      }
    } catch (e) {
    } finally {
      if (suggestStmt) suggestStmt.free();
    }
  }

  let query =
    "INSERT INTO records (parent_id, memo, amount, account) VALUES (?, ?, ?, ?)";
  let params = [parentId, memo, parsedAmount, accountStr];

  if (dateStr) {
    // タイムゾーンによるバグを回避するため、入力された日付を文字列のまま保存する
    query =
      "INSERT INTO records (parent_id, memo, amount, account, created_at) VALUES (?, ?, ?, ?, ?)";
    params.push(dateStr + " 00:00:00");
  }

  let stmt;
  try {
    stmt = db.prepare(query);
    stmt.run(params);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
  renderData(parentId);
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
function autoSuggestAccount(memoInput) {
  if (!db) return;
  const memo = memoInput.value.trim();
  if (!memo) return;

  const form = memoInput.closest("form");
  const accountInput = form.querySelector(".item-account");

  // すでにユーザーが科目を手入力している場合は、上書きせずに尊重する
  if (accountInput.value.trim() !== "") return;

  let stmt;
  try {
    // 過去の明細から「同じメモ」で使われた最新の「科目」を1件だけ検索
    stmt = db.prepare(
      "SELECT account FROM records WHERE parent_id IS NOT NULL AND memo = ? AND account IS NOT NULL AND account != '' ORDER BY id DESC LIMIT 1",
    );
    stmt.bind([memo]);

    if (stmt.step()) {
      const account = stmt.get()[0];
      if (account) {
        accountInput.value = account; // 科目を自動入力

        // （おまけ）自動入力されたことがユーザーに伝わるよう、一瞬だけ色を変えるマイクロインタラクション
        accountInput.classList.add(
          "bg-purple-100",
          "text-purple-700",
          "rounded",
          "transition-colors",
        );
        setTimeout(
          () =>
            accountInput.classList.remove(
              "bg-purple-100",
              "text-purple-700",
              "rounded",
            ),
          1000,
        );
      }
    }
  } catch (e) {
    console.error("Auto suggest account failed:", e);
  } finally {
    if (stmt) stmt.free();
  }
}

// --- インプレース編集機能 ---
function updateRecord(id, field, newValue, element) {
  if (!db) return;

  // ホワイトリストによるSQLインジェクション対策
  const allowedFields = ["amount", "memo", "account", "created_at"];
  if (!allowedFields.includes(field)) {
    console.error("Invalid field name");
    return;
  }

  let val = newValue.trim();
  if (field === "amount") {
    if (val === "") {
      val = null; // 空文字の場合は未入力(null)として扱う
    } else {
      // 表示時のカンマを除去してから数式評価
      val = evaluateMath(val.replace(/,/g, ""));
      if (val === null) {
        alert("金額の入力、または数式が正しくありません。");
        renderData(); // 元の値に戻すために再レンダリング
        return;
      }
    }
  } else if (field === "created_at") {
    // 全角数字・記号を半角に変換（スマホフリック入力対応）
    val = val.replace(/[０-９／－]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xfee0),
    );
    val = val.replace(/[ー−]/g, "-");

    // "12/31" などの簡易形式をパース
    let match = val.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {
      let year = new Date().getFullYear();
      if (element && element.hasAttribute("data-year")) {
        year = element.getAttribute("data-year");
      }
      val = `${year}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")} 00:00:00`;
    } else {
      let dateObj = new Date(val);
      if (isNaN(dateObj.getTime())) {
        alert("日付の形式が正しくありません。(例: 12/31 または 2024-12-31)");
        renderData();
        return;
      }
      val = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")} 00:00:00`;
    }
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
        // カンマが除去された表示を元に戻す
        if (element && field === "amount") {
          element.innerText = val.toLocaleString("ja-JP");
        }
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

  setDirty(true);

  // Tabキー等によるフォーカス移動を追跡して復元するマジック
  const activeEl = document.activeElement;
  let focusSelector = null;

  if (activeEl) {
    if (
      activeEl.hasAttribute("data-field") &&
      activeEl.hasAttribute("data-id")
    ) {
      const field = activeEl.getAttribute("data-field");
      const id = activeEl.getAttribute("data-id");
      focusSelector = `[data-id="${id}"][data-field="${field}"]`;
    } else if (activeEl.classList.contains("item-memo")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains("item-amount")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-amount`;
    } else if (activeEl.classList.contains("item-account")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-account`;
    } else if (activeEl.classList.contains("item-date")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-date`;
    }
  }

  // 変更が確定したので全体を再描画（合計値・タグ集計などを正しく反映）
  setTimeout(() => {
    renderData();

    // 再描画で失われたフォーカスを即座に復元
    if (focusSelector) {
      requestAnimationFrame(() => {
        const target = document.querySelector(focusSelector);
        if (target) target.focus();
      });
    }
  }, 100);
}

// 日付の「+1日」「-1日」ボタンの処理
function adjustDate(btn, days) {
  const form = btn.closest("form");
  const dateInput = form.querySelector(".item-date");

  let d;
  const parts = dateInput.value.split("-");
  if (parts.length === 3) {
    d = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
    );
  } else {
    d = new Date(dateInput.value);
  }

  // Invalid Date の場合は今日を基準にする
  if (isNaN(d.getTime())) {
    d = new Date();
  }

  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  dateInput.value = `${yyyy}-${mm}-${dd}`;
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

// --- 期間フィルターの選択肢を自動生成する ---
function updatePeriodDropdown() {
  if (!db) return;
  const select = document.getElementById("period-filter");
  if (!select) return;

  const currentVal = select.value;
  // DB内のすべての日付から「YYYY-MM」を重複なしで抽出
  const res = db.exec(
    "SELECT DISTINCT substr(created_at, 1, 7) FROM records WHERE parent_id IS NOT NULL AND created_at IS NOT NULL ORDER BY substr(created_at, 1, 7) DESC",
  );

  let years = new Set();
  let months = [];
  if (res.length > 0) {
    res[0].values.forEach((row) => {
      if (row[0]) {
        months.push(row[0]);
        years.add(row[0].split("-")[0]);
      }
    });
  }

  let html = `<option value="all">すべての期間</option>`;
  if (years.size > 0) {
    html += `<optgroup label="--- 年度で絞り込み ---">`;
    [...years].forEach((y) => (html += `<option value="${y}">${y}年</option>`));
    html += `</optgroup><optgroup label="--- 月別で絞り込み ---">`;
    months.forEach((ym) => {
      const [y, m] = ym.split("-");
      html += `<option value="${ym}">${y}年${parseInt(m, 10)}月</option>`;
    });
    html += `</optgroup>`;
  }

  // 選択肢が更新された場合のみDOMを書き換える（フォーカス消失防止）
  if (select.innerHTML !== html) {
    select.innerHTML = html;
    if (select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    } else {
      select.value = "all";
    }
  }
}

// --- 期間制御用のヘルパー関数群 ---

// ドロップダウンの手動変更ハンドラ
function handleDropdownChange() {
  window.currentActiveMonths = null;
  currentDisplayedTotal = 0; // 金額アニメーション強制リセット
  setActiveQuickPeriodButton(null);
  renderData();
}

// クイックセレクターのアクティブ状態を更新
function setActiveQuickPeriodButton(btn) {
  const container = document.getElementById("quick-period-selectors");
  if (!container) return;
  const btns = container.querySelectorAll("button");
  btns.forEach((b) => {
    b.classList.remove("ring-2", "ring-primary", "ring-offset-1"); // 古い仕様の枠線をクリア
    b.classList.remove("!bg-primary", "!text-white", "!border-primary"); // 色反転をクリア
    const activeClasses = b.getAttribute("data-active-classes");
    if (activeClasses) {
      b.classList.remove(...activeClasses.split(" "));
    }
  });
  if (btn) {
    const activeClasses = btn.getAttribute("data-active-classes");
    if (activeClasses) {
      btn.classList.add(...activeClasses.split(" "));
    }
  }
}

// 単一期間（2025-04 など）のセット
function setPeriodFilter(val, btn = null) {
  window.currentActiveMonths = null;
  currentDisplayedTotal = 0;
  setActiveQuickPeriodButton(btn);
  const select = document.getElementById("period-filter");
  if (select) {
    select.value = val;
    renderData();
  }
}

// 複数月（[4,5,6] など）のセット
function setMultiMonthFilter(monthArray, btn = null) {
  // 基準となる年を決定（現在選択されている年、または今年）
  let baseYear = new Date().getFullYear();
  const select = document.getElementById("period-filter");
  const currentFilter = select ? select.value : "all";
  if (currentFilter !== "all" && currentFilter.includes("-")) {
    baseYear = parseInt(currentFilter.split("-")[0]);
  } else if (currentFilter !== "all" && currentFilter.length === 4) {
    baseYear = parseInt(currentFilter);
  }

  window.currentActiveMonths = monthArray.map(
    (m) => `${baseYear}-${String(m).padStart(2, "0")}`,
  );
  if (select) select.value = "all";
  currentDisplayedTotal = 0;
  setActiveQuickPeriodButton(btn);
  renderData();
}

// カレンダー年フィルター (1月〜12月: 個人事業主・12月決算向け)
function setCalendarYearFilter(btn = null) {
  const today = new Date();
  const year = today.getFullYear();
  let months = [];
  for (let m = 1; m <= 12; m++)
    months.push(`${year}-${String(m).padStart(2, "0")}`);
  window.currentActiveMonths = months;
  const select = document.getElementById("period-filter");
  if (select) select.value = "all";
  currentDisplayedTotal = 0;
  setActiveQuickPeriodButton(btn);
  renderData();
}

// 年度の開始月を更新するUI
function updateFiscalYearButton() {
  const m = parseInt(localStorage.getItem("fiscalMonth") || "4", 10);
  const btn = document.getElementById("fiscal-year-btn");
  if (btn) {
    btn.textContent = `今年度 (${m}月始)`;
  }
}

function changeFiscalMonth() {
  const current = localStorage.getItem("fiscalMonth") || "4";
  const input = prompt("年度の開始月（1〜12）を入力してください:", current);
  if (input !== null) {
    const month = parseInt(input, 10);
    if (month >= 1 && month <= 12) {
      try {
        localStorage.setItem("fiscalMonth", month.toString());
      } catch (e) {
        console.warn("ローカルストレージへの保存がブロックされました");
      }
      updateFiscalYearButton();

      const isFiscalYearActive = document
        .getElementById("fiscal-year-btn")
        ?.classList.contains("!bg-purple-600");
      if (isFiscalYearActive) {
        setFiscalYearFilter();
      } else {
        // その他のフィルター時でも、ドロップダウンや画面の再描画だけは行っておく
        renderData();
      }
    } else {
      alert("1から12の数字を入力してください。");
    }
  }
}

// 年度フィルター (設定された開始月から12ヶ月)
function setFiscalYearFilter(btn = null) {
  const today = new Date();
  const startMonth = parseInt(localStorage.getItem("fiscalMonth") || "4", 10);
  let startYear = today.getFullYear();

  if (today.getMonth() + 1 < startMonth) {
    startYear--;
  }

  let months = [];
  for (let i = 0; i < 12; i++) {
    let m = startMonth + i;
    let y = startYear;
    if (m > 12) {
      m -= 12;
      y++;
    }
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }

  window.currentActiveMonths = months;
  const select = document.getElementById("period-filter");
  if (select) select.value = "all";
  currentDisplayedTotal = 0;
  setActiveQuickPeriodButton(btn || document.getElementById("fiscal-year-btn"));
  renderData();
}

// 3. ブロック構造の描画
function renderData(focusBlockId = null) {
  if (!db) return;
  const container = document.getElementById("blocks-container");

  const res = db.exec(
    "SELECT id, parent_id, memo, amount, created_at, account FROM records ORDER BY sort_order ASC, id ASC",
  );
  if (res.length === 0) return;

  const records = res[0].values.map(
    ([id, parent_id, memo, rawAmount, created_at, account]) => {
      // SQLiteの型汚染攻撃 (Type Juggling) を防ぐためのサニタイズ
      let safeAmount = null;
      if (rawAmount !== null && rawAmount !== "") {
        const num = Number(rawAmount);
        safeAmount = Number.isFinite(num) ? num : null;
      }
      return {
        id,
        parent_id,
        memo,
        amount: safeAmount,
        created_at,
        account,
        children: [],
      };
    },
  );

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

  updatePeriodDropdown();
  const periodFilter = document.getElementById("period-filter")?.value || "all";

  // 配列が指定されているかチェック
  const activeMonths =
    window.currentActiveMonths ||
    (periodFilter !== "all" ? [periodFilter] : null);

  // 期間フィルターに一致しない明細を除外する
  const filteredTree = [];
  tree.forEach((block) => {
    if (!activeMonths) {
      filteredTree.push(block);
    } else {
      const filteredChildren = block.children.filter((item) => {
        if (!item.created_at) return false;
        // activeMonths配列内のいずれかの文字列で始まっていればOK
        return activeMonths.some((m) => item.created_at.startsWith(m));
      });
      // フィルター条件に合致する明細がある、または新規作成直後の空ブロックの場合は残す
      if (filteredChildren.length > 0 || block.children.length === 0) {
        filteredTree.push({ ...block, children: filteredChildren });
      }
    }
  });

  // 親ブロックを「新しいものが一番上」になるようID降順でソート
  filteredTree.sort((a, b) => b.id - a.id);

  // AutoAnimateフリーズ防止のためのアイテム総数カウント
  let totalItemsCount = 0;
  filteredTree.forEach((block) => {
    totalItemsCount += block.children.length;
  });
  const disableAnimation = totalItemsCount > 500;

  // 合計金額ラベルの表記更新
  const filterEl = document.getElementById("period-filter");
  const totalLabelEl = document.getElementById("grand-total-label");
  if (totalLabelEl && filterEl) {
    if (window.currentActiveMonths) {
      totalLabelEl.textContent = "Custom Period / Fiscal Period";
    } else {
      totalLabelEl.textContent =
        filterEl.value !== "all"
          ? filterEl.options[filterEl.selectedIndex].text
          : "Total Amount";
    }
  }

  // 左側 TOC (目次) の構築
  const tocContainer = document.getElementById("toc-container");
  if (tocContainer) {
    const prevScrollTop = tocContainer.scrollTop; // スクロール位置を記憶

    // 検索ボックスを追加
    tocContainer.innerHTML = `
      <div class="sticky top-0 bg-slate-50 pt-2 pb-4 z-10">
        <div class="font-bold text-slate-600 mb-2 px-2 uppercase text-[10px] tracking-widest">Index</div>
        <div class="relative px-2">
          <svg class="w-3 h-3 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"><use href="#icon-search"></use></svg>
          <input type="text" id="toc-filter" placeholder="目次を絞り込み..." class="w-full bg-slate-100 border border-slate-200 text-slate-700 text-xs rounded-md pl-7 pr-2 py-1.5 outline-none focus:bg-white focus:border-primary transition-colors" autocomplete="off">
        </div>
      </div>
      <div id="toc-list" class="space-y-0.5 mt-1 pb-4"></div>
    `;

    const tocList = document.getElementById("toc-list");

    filteredTree.forEach((block) => {
      const a = document.createElement("a");
      a.href = `#block-${block.id}`;
      a.className =
        "toc-item block px-2 py-1 hover:text-slate-900 hover:bg-slate-100 rounded truncate transition-colors text-slate-500 cursor-pointer text-sm font-medium";
      a.textContent = block.memo;
      a.title = block.memo;
      a.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(`block-${block.id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      tocList.appendChild(a);
    });

    // 検索ボックスのリアルタイム・フィルタリング処理
    const tocFilter = document.getElementById("toc-filter");
    if (tocFilter) {
      // 既存の入力状態（検索ワード）を復元する処理
      if (window.currentTocFilterValue) {
        tocFilter.value = window.currentTocFilterValue;
        applyTocFilter(window.currentTocFilterValue);
      }

      tocFilter.addEventListener("input", (e) => {
        window.currentTocFilterValue = e.target.value; // 状態をグローバルに保持
        applyTocFilter(e.target.value);
      });
    }

    function applyTocFilter(keyword) {
      const q = keyword.toLowerCase();
      const items = tocList.querySelectorAll(".toc-item");
      items.forEach((item) => {
        if (item.textContent.toLowerCase().includes(q)) {
          item.style.display = "block";
        } else {
          item.style.display = "none";
        }
      });
    }

    // レンダリング後にスクロール位置を復元
    requestAnimationFrame(() => {
      tocContainer.scrollTop = prevScrollTop;
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

  if (filteredTree.length === 0) {
    const isFilterActive = periodFilter !== "all" || window.currentActiveMonths;
    container.innerHTML = `
      <div id="empty-state" class="flex flex-col items-center justify-center py-20 text-slate-400">
        <svg class="w-16 h-16 mb-4 opacity-20"><use href="#icon-search"></use></svg>
        <p class="text-lg font-medium">${isFilterActive ? "該当する記録が見つかりません" : "まだ記録がありません"}</p>
        <p class="text-sm mt-1">${isFilterActive ? "フィルター条件を変更してみてください" : "上の入力欄から最初のブロックを作成しましょう"}</p>
      </div>
    `;
    existingBlockMap.forEach((el) => el.remove());

    let mobileTagContainer = document.getElementById("mobile-tag-container");
    if (mobileTagContainer) mobileTagContainer.remove();

    animateTotal(0);
    renderMemoSuggestions();
    return;
  }

  let currentDomIndex = 0;
  let grandTotal = 0;
  let tagTotals = {}; // タグ集計用

  filteredTree.forEach((block) => {
    block.children.forEach((item) => {
      grandTotal += item.amount || 0;

      // メモ欄から「#タグ」を正規表現で抽出して集計（全角ハッシュタグも吸収）
      const tags = (item.memo || "").match(/[#＃][^\s　]+/g) || [];
      const blockTags = (block.memo || "").match(/[#＃][^\s　]+/g) || [];
      const rawTags = [...tags, ...blockTags].map((t) => t.replace("＃", "#"));
      const allTags = [...new Set(rawTags)]; // 重複排除と正規化

      allTags.forEach((tag) => {
        if (!tagTotals[tag]) tagTotals[tag] = { amount: 0, items: [] };
        tagTotals[tag].amount += item.amount || 0;
        tagTotals[tag].items.push({
          date: item.created_at,
          memo: item.memo,
          amount: item.amount || 0,
        });
      });
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
    tocContainer.appendChild(tagDivider);

    // タグを金額が大きい順にソートして表示
    Object.entries(tagTotals)
      .sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([tag, data]) => {
        const a = document.createElement("a");
        a.className =
          "group block px-2 py-1.5 hover:bg-slate-100 rounded transition-colors cursor-pointer flex justify-between items-center";
        a.innerHTML = `
          <span class="text-sm font-medium text-slate-600 group-hover:text-primary transition-colors truncate">${escapeHtml(tag)}</span>
          <span class="text-[10px] font-mono font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded group-hover:bg-white transition-colors">¥${data.amount.toLocaleString("ja-JP")}</span>
        `;
        a.onclick = (e) => {
          e.preventDefault();
          showTagModal(tag, data);
        };
        tocContainer.appendChild(a);
      });
  }

  // スマホ用のタグ表示エリアを（既存のものがあれば削除して）再生成
  const mainContainer = document.getElementById("blocks-container");
  let mobileTagContainer = document.getElementById("mobile-tag-container");
  if (mobileTagContainer) mobileTagContainer.remove();

  if (Object.keys(tagTotals).length > 0) {
    mobileTagContainer = document.createElement("div");
    mobileTagContainer.id = "mobile-tag-container";
    mobileTagContainer.className =
      "xl:hidden mt-12 mb-8 bg-white p-6 rounded-xl border border-slate-200 shadow-sm";
    mobileTagContainer.innerHTML = `<h3 class="text-xs font-bold text-slate-400 mb-4 tracking-widest flex items-center gap-1"><svg class="w-4 h-4"><use href="#icon-folder"></use></svg> PROJECTS (TAGS)</h3>`;

    const grid = document.createElement("div");
    grid.className = "grid grid-cols-2 gap-3";

    Object.entries(tagTotals)
      .sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([tag, data]) => {
        const btn = document.createElement("button");
        btn.className =
          "text-left p-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-100 transition-colors cursor-pointer flex flex-col gap-1";
        btn.innerHTML = `<span class="text-sm font-bold text-slate-700 truncate">${escapeHtml(tag)}</span><span class="text-xs font-mono text-slate-500">¥${data.amount.toLocaleString("ja-JP")}</span>`;
        btn.onclick = () => showTagModal(tag, data);
        grid.appendChild(btn);
      });

    mobileTagContainer.appendChild(grid);
    mainContainer.appendChild(mobileTagContainer);
  }

  // 数字のアニメーション更新
  animateTotal(grandTotal);

  renderMemoSuggestions();

  if (focusBlockId) {
    const targetInput = document.querySelector(
      `#block-form-${focusBlockId} .item-memo`,
    );
    if (targetInput) {
      targetInput.focus({ preventScroll: false });
    }
  }

  // 明細コンテナに対するAutoAnimateの適用 (追加・削除時のアニメーション)
  if (!disableAnimation) {
    document.querySelectorAll('[id^="block-body-"]').forEach((bodyEl) => {
      const listContainer = bodyEl.firstElementChild;
      if (listContainer && !listContainer.hasAttribute("data-animated")) {
        if (window.autoAnimate) {
          window.autoAnimate(listContainer);
          listContainer.setAttribute("data-animated", "true");
        }
      }
    });
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
            activeToc.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  }

  const blockTotal = block.children.reduce(
    (sum, item) => sum + (item.amount || 0),
    0,
  );

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const defaultDate = lastUsedDates[block.id] || todayStr;

  let itemsHtml = "";
  block.children.forEach((item) => {
    let dateDisp = "";
    let yyyy = today.getFullYear();
    if (item.created_at) {
      // 文字列から直接日付をパースして表示（タイムゾーン安全）
      const dStr = item.created_at.split(" ")[0]; // "YYYY-MM-DD"
      const parts = dStr.split("-");
      if (parts.length === 3) {
        yyyy = escapeHtml(parts[0]);
        const imm = escapeHtml(parts[1]);
        const idd = escapeHtml(parts[2]);
        dateDisp = `<span data-id="${item.id}" data-field="created_at" data-year="${yyyy}" contenteditable="true" onpaste="event.preventDefault(); const text = (event.clipboardData || window.clipboardData).getData('text/plain'); const cleanText = text.replace(/[\\r\\n\\t]+/g, ' ').trim(); document.execCommand('insertText', false, cleanText);" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'created_at', this.innerText, this)" class="text-xs text-slate-500 font-mono mr-2 sm:mr-3 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded outline-none focus:ring-2 focus:ring-blue-200 cursor-text hover:bg-slate-200 transition-colors" title="クリックして日付を編集">${imm}/${idd}</span>`;
      }
    }

    const accStr = item.account || "";
    let accountDisp = `<input type="text" data-id="${item.id}" data-field="account" list="account-suggestions" value="${escapeHtml(accStr)}" placeholder="科目" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'account', this.value, this)" class="text-xs text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded mr-2 outline-none focus:ring-2 focus:ring-blue-400 focus:bg-blue-100 cursor-text transition-colors hover:bg-blue-100 w-[60px] sm:w-[72px] shrink-0 text-center placeholder-blue-300">`;

    itemsHtml += `
      <div class="flex justify-between items-center px-4 sm:px-8 py-3.5 border-b border-slate-50 group/item hover:bg-slate-50/80 transition-colors">
        <div class="flex items-center flex-1 min-w-0">
          ${dateDisp}
          ${accountDisp}
          <span data-id="${item.id}" data-field="memo" contenteditable="true" onpaste="event.preventDefault(); const text = (event.clipboardData || window.clipboardData).getData('text/plain'); const cleanText = text.replace(/[\\r\\n\\t]+/g, ' ').trim(); document.execCommand('insertText', false, cleanText);" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'memo', this.innerText, this)" class="text-slate-700 font-medium truncate outline-none focus:bg-blue-50 focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-12 empty:bg-slate-100 empty:after:content-['✎_未入力'] empty:after:text-slate-400 empty:after:text-xs empty:after:font-normal">${escapeHtml(item.memo)}</span>
        </div>
        <div class="flex items-center space-x-2 sm:space-x-4 ml-2 sm:ml-auto shrink-0">
          <span data-id="${item.id}" data-field="amount" contenteditable="true" onpaste="event.preventDefault(); const text = (event.clipboardData || window.clipboardData).getData('text/plain'); const cleanText = text.replace(/[\\r\\n\\t]+/g, ' ').trim(); document.execCommand('insertText', false, cleanText);" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'amount', this.innerText, this)" class="font-medium font-mono text-slate-900 outline-none focus:bg-blue-50 focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-8 empty:bg-slate-100 empty:after:content-['0'] empty:after:text-slate-400 empty:after:text-xs empty:after:font-sans">${item.amount !== null && item.amount !== "" && item.amount !== undefined ? item.amount.toLocaleString("ja-JP") : ""}</span><span class="text-slate-400 text-xs font-sans">円</span>
          <button onclick="deleteRecord(${item.id})" class="text-slate-300 hover:text-red-500 md:opacity-0 md:group-hover/item:opacity-100 transition-opacity text-xl leading-none -mt-0.5" title="削除">&times;</button>
        </div>
      </div>
    `;
  });

  const isCollapsed = collapsedBlocks.has(block.id);
  const maxH = isCollapsed ? "0px" : "99999px";
  const op = isCollapsed ? "0" : "1";
  const iconRotation = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";

  blockEl.innerHTML = `
    <button onclick="event.stopPropagation(); saveTemplate(${block.id})" class="absolute -top-3 -left-3 opacity-100 md:opacity-0 group-hover/block:opacity-100 bg-white border border-slate-200 text-slate-400 hover:text-primary hover:border-primary/50 hover:shadow-[0_0_15px_rgba(15,98,254,0.3)] hover:scale-110 p-2 rounded-xl transition-all duration-300 cursor-pointer flex items-center justify-center z-10" title="このブロックをテンプレートとして保存">
      <svg class="w-5 h-5"><use href="#icon-squares-plus"></use></svg>
    </button>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:border-slate-300">
    <div onclick="toggleBlock(${block.id})" class="bg-slate-50/50 px-8 py-5 border-b border-slate-100 flex justify-between items-center transition-colors cursor-pointer select-none group/header hover:bg-slate-100">
      <div class="flex items-center gap-3 overflow-hidden">
        <svg id="block-icon-${block.id}" class="w-5 h-5 text-slate-400 transition-transform duration-200" style="transform: ${iconRotation};"><use href="#icon-chevron-down"></use></svg>
        <h2 data-id="${block.id}" data-field="memo" contenteditable="true" onpaste="event.preventDefault(); const text = (event.clipboardData || window.clipboardData).getData('text/plain'); const cleanText = text.replace(/[\\r\\n\\t]+/g, ' ').trim(); document.execCommand('insertText', false, cleanText);" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${block.id}, 'memo', this.innerText, this)" class="text-xl font-extrabold text-slate-900 tracking-tight outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 px-1 rounded cursor-text truncate transition-colors empty:inline-block empty:min-w-20 empty:bg-slate-100 empty:after:content-['✎_タイトル未入力'] empty:after:text-slate-400 empty:after:text-sm empty:after:font-normal">${escapeHtml(block.memo)}</h2>
      </div>
      <div class="flex items-center shrink-0">
        <div class="font-bold font-mono text-slate-900 text-lg"><span id="block-total-${block.id}">${blockTotal.toLocaleString("ja-JP")}</span> <span class="text-slate-400 text-sm font-sans">円</span></div>
        <div class="flex items-center pl-4 border-l border-slate-200/50 ml-4 shrink-0 h-8">
          <button onclick="event.stopPropagation(); deleteRecord(${block.id})" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-red-50 hover:text-red-500 md:opacity-0 md:group-hover/block:opacity-100 transition-all cursor-pointer" title="ブロックを丸ごと削除">
            <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
    </div>
    <div id="block-body-${block.id}" class="transition-all duration-300 ease-in-out overflow-hidden" style="max-height: ${maxH}; opacity: ${op};">
      <div class="">${itemsHtml}</div>
      <div class="px-8 py-4 bg-white transition-colors">
      <form id="block-form-${block.id}" class="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 py-2 -mx-3 rounded-md transition-all focus-within:bg-slate-50 focus-within:ring-1 focus-within:ring-slate-200" onsubmit="event.preventDefault(); addItem(
        ${block.id},
        this.querySelector('.item-memo').value,
        this.querySelector('.item-amount').value,
        this.querySelector('.item-date').value,
        this.querySelector('.item-account').value
      );">
        <span class="text-primary text-xl leading-none font-light hidden sm:inline">+</span>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <span class="text-primary text-xl leading-none font-light sm:hidden">+</span>
          <div class="flex items-center bg-slate-50 rounded-md px-1 py-1 border border-slate-200 transition-colors">
            <button type="button" onclick="adjustDate(this, -1)" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors" title="-1日">-</button>
            <input type="date" class="item-date bg-transparent border-0 focus:ring-0 p-0 text-slate-600 text-xs w-[110px] text-center outline-none cursor-pointer" value="${defaultDate}">
            <button type="button" onclick="adjustDate(this, 1)" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors" title="+1日">+</button>
          </div>
          <input type="text" placeholder="科目(任意)" value="" list="account-suggestions" onfocus="this.select()" onkeydown="if(event.key==='Enter'){event.preventDefault();this.closest('form').querySelector('.item-memo').focus();}" class="item-account bg-transparent border-0 focus:ring-0 p-0 text-slate-600 placeholder-slate-400 w-16 sm:w-20 text-sm outline-none text-center">
        </div>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 pl-6 sm:pl-0 mt-2 sm:mt-0">
          <input type="text" placeholder="明細を追加..." list="memo-suggestions" onblur="autoSuggestAccount(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.closest('form').querySelector('.item-amount').focus();}" class="item-memo bg-transparent border-0 focus:ring-0 p-0 text-slate-900 placeholder-slate-400 flex-1 text-sm font-medium outline-none min-w-[100px]">
          <input type="text" inputmode="decimal" placeholder="金額 (数式OK)" class="item-amount bg-transparent border-0 focus:ring-0 p-0 text-right font-mono text-slate-900 placeholder-slate-400 w-24 sm:w-32 text-sm outline-none">
        </div>
        <button type="submit" class="hidden">追加</button>
      </form>
      </div>
    </div>
  `;
  return blockEl;
}

// --- テンプレート（1Shot生成）機能 ---
function saveTemplate(blockId) {
  if (!db) return;

  // ブロックのタイトルを取得
  const blockRes = db.exec("SELECT memo FROM records WHERE id = ?", [blockId]);
  if (blockRes.length === 0) return;
  const blockMemo = blockRes[0].values[0][0] || "名称未設定";

  // 子要素（明細）の構成を取得
  const res = db.exec(
    "SELECT memo, account, amount FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
    [blockId],
  );
  let items = [];
  if (res.length > 0) {
    items = res[0].values.map((row) => ({
      memo: row[0],
      account: row[1],
      amount: row[2],
    }));
  }

  let tplName = prompt(
    "このブロックをテンプレートとして保存します。\n呼び出し用の名前を入力してください:",
    blockMemo + " (雛形)",
  );
  if (!tplName) return;

  const stmt = db.prepare("INSERT INTO templates (name, data) VALUES (?, ?)");
  stmt.run([tplName, JSON.stringify(items)]);
  stmt.free();
  setDirty(true);
  alert(
    `✅ テンプレート「${tplName}」を保存しました。\nコマンドパレット(Cmd+K)からいつでも一発で呼び出せます。`,
  );
}

function insertTemplate(templateId) {
  if (!db) return;
  const res = db.exec("SELECT name, data FROM templates WHERE id = ?", [
    templateId,
  ]);
  if (res.length === 0) return;
  const tplName = res[0].values[0][0];
  const tplData = JSON.parse(res[0].values[0][1] || "[]");

  // 新しい親ブロックを作成
  db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [tplName, null]);
  const parentRes = db.exec("SELECT last_insert_rowid()");
  const parentId = parentRes[0].values[0][0];

  // 今日の日付を取得
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;

  // 子要素を展開して一気にINSERT
  for (let item of tplData) {
    const stmt = db.prepare(
      "INSERT INTO records (parent_id, memo, amount, account, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    // テンプレート保存時の金額をそのまま展開する（固定費などで便利にするため）
    stmt.run([parentId, item.memo, item.amount, item.account, dateStr]);
    stmt.free();
  }

  setDirty(true);
  renderData(parentId);
}

// 3.5 データの削除（DELETE文の実行）
function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  const stmt = db.prepare("DELETE FROM records WHERE id = ? OR parent_id = ?");
  stmt.run([id, id]);
  stmt.free();

  // ゾンビステートのクリーンアップ
  collapsedBlocks.delete(id);
  delete lastUsedDates[id];

  setDirty(true);
  renderData();
}

// 4. 【核心部】 File System Access API を使った保存
async function saveGrindFile(isSaveAs = false) {
  if (!db) return;

  // 保存前に、現在入力中の要素のフォーカスを外してデータ(DB)を確定させる
  if (
    document.activeElement &&
    typeof document.activeElement.blur === "function"
  ) {
    document.activeElement.blur();
  }

  let data = db.export();
  const password = document.getElementById("file-password").value;
  if (password) {
    data = await encryptData(data, password);
  }

  // 保存成功時の視覚的なタクタイル・フィードバックを共通化
  const showSaveSuccessFeedback = () => {
    const saveBtn = document.getElementById("btn-save");
    if (saveBtn) {
      const iconSvg = saveBtn.querySelector("svg");
      if (iconSvg) {
        const originalUse = iconSvg.innerHTML;
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
        }, 1500);
      }
    }
  };

  if (isSaveAs || !fileHandle || fileHandle.isDummy) {
    if ("showSaveFilePicker" in window) {
      try {
        fileHandle = await window.showSaveFilePicker({
          types: [
            {
              description: "GrindMoney Database",
              accept: { "application/x-sqlite3": [".grind"] },
            },
          ],
        });
      } catch (err) {
        console.log("Save cancelled.", err);
        return;
      }
    } else {
      // API非対応ブラウザ向けのフォールバック保存
      const blob = new Blob([data], { type: "application/x-sqlite3" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        fileHandle && fileHandle.name ? fileHandle.name : "database.grind";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDirty(false);
      const statusEl = document.getElementById("status");
      statusEl.innerHTML = `<span class="text-green-400">💾</span> データを "${escapeHtml(a.download)}" としてダウンロードしました`;
      statusEl.className =
        "fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border border-slate-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
      statusEl.style.pointerEvents = "auto";
      showSaveSuccessFeedback();
      hideStatus();
      return;
    }
  }

  // --- File System権限の「サイレント没収」からのリカバリ ---
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
      return; // 権限がなければクラッシュを防ぐため中断
    }
  }

  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
  setDirty(false);

  const statusEl = document.getElementById("status");
  statusEl.innerHTML = `<span class="text-green-400">💾</span> データを "${escapeHtml(fileHandle.name)}" に保存しました`;
  statusEl.className =
    "fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border border-slate-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
  statusEl.style.pointerEvents = "auto";
  showSaveSuccessFeedback();
  hideStatus();
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
    const isEncrypted = new TextDecoder().decode(magic) === "GRINDENC";

    if (isEncrypted) {
      let password = document.getElementById("file-password").value;
      let success = false;
      while (!success) {
        try {
          Uints = await decryptData(Uints, password);
          success = true;
          if (password)
            document.getElementById("file-password").value = password;
        } catch (err) {
          password = prompt(
            "ファイルは暗号化されています。解除パスワードを入力してください:",
          );
          if (password === null) return; // キャンセルして処理を中断
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

    // UI更新の前にハンドルをセットして正しいファイル名を反映させる
    fileHandle = handle;
    setDirty(false);

    const statusEl = document.getElementById("status");
    statusEl.innerHTML = `<span class="text-blue-400">📂</span> ファイル "${escapeHtml(file.name)}" を読み込みました`;
    statusEl.className =
      "fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border border-slate-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
    statusEl.style.pointerEvents = "auto";
    renderData();
    hideStatus();
  } catch (err) {
    console.log("Open cancelled or failed.", err);
    alert("ファイルの読み込みに失敗しました。");
  }
}

// 5.1 「開く」ボタンから File System Access API を使った読み込み
async function loadGrindFile() {
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
            description: "GrindMoney Database",
            accept: { "application/x-sqlite3": [".grind", ".sqlite"] },
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
    input.accept = ".grind,.sqlite";
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
    const filterEl = document.getElementById("period-filter");
    let periodText = "すべての期間";

    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      const sorted = [...window.currentActiveMonths].sort();
      const formatMonth = (ym) => {
        const [y, m] = ym.split("-");
        return `${y}年${parseInt(m, 10)}月`;
      };
      periodText = `${formatMonth(sorted[0])} 〜 ${formatMonth(sorted[sorted.length - 1])}`;
    } else if (filterEl && filterEl.value !== "all") {
      periodText = filterEl.options[filterEl.selectedIndex].text;
    }
    infoEl.innerHTML = `💡 現在表示中の <b>「${periodText}」</b> が出力されます。`;
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
}

function closeExportModal() {
  const modal = document.getElementById("export-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

function executeExport() {
  const format = document.getElementById("export-format").value;
  closeExportModal();
  exportCSV(format);
}

// 6. CSVエクスポート
function exportCSV(format = "yayoi") {
  if (!db) return;

  const filterVal = document.getElementById("period-filter")?.value || "all";
  let whereClause = "";

  if (window.currentActiveMonths) {
    const orConditions = window.currentActiveMonths
      .map((m) => `c.created_at LIKE '${m}%'`)
      .join(" OR ");
    whereClause = ` AND (${orConditions})`;
  } else if (filterVal !== "all") {
    const safeFilter = filterVal.replace(/[^0-9-]/g, ""); // 安全のためのサニタイズ
    whereClause = ` AND c.created_at LIKE '${safeFilter}%'`;
  }

  let query = `SELECT c.id, COALESCE(p.memo, '') || ' - ' || COALESCE(c.memo, '') AS memo, c.amount, c.created_at, c.account FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL${whereClause} ORDER BY c.id ASC`;

  const res = db.exec(query);

  if (res.length === 0) {
    alert("エクスポートするデータがありません。");
    return;
  }

  // サニタイズ用のヘルパー関数 (CSV Injection / DDE 対策)
  function sanitizeCsvCell(value) {
    let str = value ? value.toString() : "";
    // 先頭が危険な文字で始まる場合はシングルクォートを付与して数式解釈を無効化
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  }

  let csvContent = "";
  if (format === "freee") {
    // freeeはヘッダー行が必要
    csvContent +=
      "収支区分,管理番号,発生日,支払期日,取引先,勘定科目,税区分,金額,税計算区分,税額,備考,品目,部門,メモタグ,決済期日,決済口座,決済金額\n";
  } else if (format === "mf") {
    csvContent +=
      '"取引No","取引日","借方勘定科目","借方補助科目","借方部門","借方税区分","借方金額","借方税額","貸方勘定科目","貸方補助科目","貸方部門","貸方税区分","貸方金額","貸方税額","摘要","仕訳メモ","タグ"\n';
  } else if (format === "generic") {
    csvContent += '"ID","日付","勘定科目","摘要","金額"\n';
  }

  res[0].values.forEach((row) => {
    // row[0]: id, row[1]: memo, row[2]: amount, row[3]: created_at
    const memo = row[1] ? row[1].toString() : "";
    const amount = row[2] || 0;
    const account = row[4] ? row[4].toString() : "雑費";
    const escapedMemo = sanitizeCsvCell(memo);
    const escapedAccount = sanitizeCsvCell(account);

    let dateFreeway = "000000";
    let dateSlash = "";
    let dateHyphen = "";

    if (row[3]) {
      // 保存時と同じく文字列から直接パースする
      const dStr = row[3].split(" ")[0];
      const parts = dStr.split("-");
      if (parts.length === 3) {
        const yyyy = parseInt(parts[0], 10);
        const mm = parts[1];
        const dd = parts[2];

        const numMonth = parseInt(mm, 10);
        const numDay = parseInt(dd, 10);
        let eraYear;

        // 2019年5月1日以降が令和
        if (yyyy > 2019 || (yyyy === 2019 && numMonth >= 5)) {
          eraYear = yyyy - 2018;
        }
        // 1989年1月8日以降が平成
        else if (
          yyyy > 1989 ||
          (yyyy === 1989 && (numMonth > 1 || numDay >= 8))
        ) {
          eraYear = yyyy - 1988;
        }
        // それ以前は簡易的に昭和とする
        else {
          eraYear = yyyy - 1925;
        }

        const yy = String(eraYear).padStart(2, "0");

        dateFreeway = yy + mm + dd;
        dateSlash = `${yyyy}/${mm}/${dd}`;
        dateHyphen = `${yyyy}-${mm}-${dd}`;
      }
    }

    let cols = [];
    if (format === "freeway") {
      cols = Array(16).fill("0");
      cols[3] = dateFreeway;
      cols[4] = ""; // フリーウェイは科目名だけでも基本取り込める場合が多い
      cols[5] = escapedAccount;
      cols[7] = "1100";
      cols[8] = '"現金"';
      cols[10] = amount.toString();
      cols[11] = escapedMemo;
      cols[12] = "21";
      cols[13] = "10";
    } else if (format === "yayoi") {
      cols = Array(25).fill("");
      cols[0] = "2000"; // 識別フラグ
      cols[2] = "0"; // 決算
      cols[3] = dateSlash;
      cols[4] = escapedAccount;
      cols[7] = '"課税対応仕入"';
      cols[8] = amount.toString();
      cols[10] = '"現金"';
      cols[13] = '"対象外"';
      cols[14] = amount.toString();
      cols[16] = escapedMemo;
      cols[19] = "0"; // タイプ (0=仕訳)
    } else if (format === "freee") {
      cols = Array(17).fill("");
      cols[0] = '"支出"';
      cols[1] = `"${row[0]}"`; // 管理番号 (GrindMoneyの内部ID)
      cols[2] = `"${dateHyphen}"`;
      cols[5] = escapedAccount;
      cols[6] = '"課税仕入"';
      cols[7] = amount.toString();
      cols[8] = '"税込"';
      cols[10] = escapedMemo;
      cols[14] = `"${dateHyphen}"`;
      cols[15] = '"現金"';
      cols[16] = amount.toString();
    } else if (format === "mf") {
      cols = Array(17).fill('""');
      cols[0] = `"${row[0]}"`; // 取引No (GrindMoneyの内部ID)
      cols[1] = `"${dateSlash}"`; // 取引日
      cols[2] = escapedAccount; // 借方勘定科目
      cols[5] = '"対象外"'; // 借方税区分
      cols[6] = `"${amount}"`; // 借方金額
      cols[8] = '"現金"'; // 貸方勘定科目
      cols[11] = '"対象外"'; // 貸方税区分
      cols[12] = `"${amount}"`; // 貸方金額
      cols[14] = escapedMemo; // 摘要
    } else if (format === "generic") {
      cols = [
        `"${row[0]}"`,
        `"${dateSlash}"`,
        escapedAccount,
        escapedMemo,
        `"${amount}"`,
      ];
    }

    csvContent += cols.join(",") + "\n";
  });

  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const today = new Date();
  const dateSuffix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}_${dateSuffix}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 7. CSVインポート
function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;

  // 5MB (5 * 1024 * 1024 bytes) を超える場合は警告してクラッシュを防ぐ
  if (file.size > 5242880) {
    alert(
      "ファイルサイズが大きすぎます（5MB上限）。ブラウザがクラッシュするのを防ぐため読み込みを中止しました。",
    );
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    pendingCSVBuffer = e.target.result; // ArrayBufferを保存
    showCSVModal();
    event.target.value = "";
  };
  reader.readAsArrayBuffer(file); // ArrayBufferとして読み込む
}

// CSVマッピングモーダルを表示
function showCSVModal() {
  const modal = document.getElementById("csv-mapping-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
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
    let currentCell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      // BOMのスキップ
      if (i === 0 && char.charCodeAt(0) === 0xfeff) continue;

      if (char === '"' && nextChar === '"') {
        currentCell += '"';
        i++; // エスケープされたクオートをスキップ
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        currentLine.push(currentCell);
        currentCell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") i++; // \r\n の対応
        currentLine.push(currentCell);
        pendingCSVData.push(currentLine);
        currentLine = [];
        currentCell = "";
      } else {
        currentCell += char;
      }
    }
    // 最後の行をプッシュ
    if (currentLine.length > 0 || currentCell !== "") {
      currentLine.push(currentCell);
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
    if (document.getElementById("map-account"))
      document.getElementById("map-account").innerHTML =
        `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-memo").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-amount").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    const previewHead = document.getElementById("csv-preview-head");
    if (previewHead) previewHead.innerHTML = "";
    previewBody.innerHTML = `<tr><td colspan="99" class="p-4 text-center text-red-500">文字コード「${encoding}」でのデコードに失敗しました。ファイルが破損しているか、文字コードの指定が間違っています。</td></tr>`;
    return;
  }

  // --- UI更新 ---
  const mapDate = document.getElementById("map-date");
  const mapAccount = document.getElementById("map-account");
  const mapMemo = document.getElementById("map-memo");
  const mapAmount = document.getElementById("map-amount");

  const maxCols = pendingCSVData.reduce(
    (max, row) => Math.max(max, row.length),
    0,
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
    account: mapAccount ? mapAccount.value : "-1",
    memo: mapMemo.value,
    amount: mapAmount.value,
  };
  mapDate.innerHTML = optionsHtml;
  if (mapAccount) mapAccount.innerHTML = optionsHtml;
  mapMemo.innerHTML = optionsHtml;
  mapAmount.innerHTML = optionsHtml;
  mapDate.value = oldVals.date;
  if (mapAccount) mapAccount.value = oldVals.account;
  mapMemo.value = oldVals.memo;
  mapAmount.value = oldVals.amount;

  if (mapDate.selectedIndex < 1 && maxCols >= 1) mapDate.value = "0";
  if (mapAccount && mapAccount.selectedIndex < 1 && maxCols >= 4)
    mapAccount.value = "3"; // 4列以上あれば適当に
  if (mapMemo.selectedIndex < 1 && maxCols >= 2) mapMemo.value = "1";
  if (mapAmount.selectedIndex < 1 && maxCols >= 3) mapAmount.value = "2";

  renderCSVPreview();
}

function renderCSVPreview() {
  const previewHead = document.getElementById("csv-preview-head");
  const previewBody = document.getElementById("csv-preview-body");
  if (!previewHead || !previewBody || pendingCSVData.length === 0) return;

  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapAccount = document.getElementById("map-account")
    ? parseInt(document.getElementById("map-account").value, 10)
    : -1;
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapAmount = parseInt(document.getElementById("map-amount").value, 10);

  const maxCols = pendingCSVData.reduce(
    (max, row) => Math.max(max, row.length),
    0,
  );

  // ヘッダーの構築
  let thHtml = `<th class="px-3 py-2 w-8 text-center border-r border-gray-200 dark:border-gray-800">行</th>`;
  for (let i = 0; i < maxCols; i++) {
    let label = "";
    let badgeClass = "bg-slate-200 text-slate-500";
    if (i === mapDate) {
      label = "日付";
      badgeClass = "bg-blue-100 text-blue-700";
    } else if (i === mapAccount) {
      label = "科目";
      badgeClass = "bg-purple-100 text-purple-700";
    } else if (i === mapMemo) {
      label = "メモ";
      badgeClass = "bg-green-100 text-green-700";
    } else if (i === mapAmount) {
      label = "金額";
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
  const previewRows = pendingCSVData.slice(0, 4); // 最初の4行をプレビュー
  previewRows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.className = rowIndex === 0 ? "bg-slate-50" : "bg-white";
    let tdHtml = `<td class="px-3 py-2 font-bold text-slate-400 border-r border-slate-200 w-8 text-center">${rowIndex + 1}</td>`;
    for (let i = 0; i < maxCols; i++) {
      const val = row[i] !== undefined ? row[i] : "";
      // 長すぎる文字列は省略して表示し、title属性で全文を確認できるようにする
      const displayVal = val.length > 20 ? val.substring(0, 20) + "..." : val;

      // マッピングされている列はハイライト
      let highlightClass = "";
      if (
        i === mapDate ||
        i === mapAccount ||
        i === mapMemo ||
        i === mapAmount
      ) {
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
  document.body.style.overflow = "";
  pendingCSVData = [];
  pendingCSVBuffer = null;
}

function executeCSVImport() {
  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapAccount = parseInt(document.getElementById("map-account").value, 10);
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapAmount = parseInt(document.getElementById("map-amount").value, 10);
  const skipRows =
    parseInt(document.getElementById("csv-skip-rows").value, 10) || 0;

  if (mapMemo === -1 || mapAmount === -1) {
    alert("「メモ」と「金額」の列は必須です。");
    return;
  }

  // モーダルを閉じると pendingCSVData がクリアされてしまうため、退避しておく
  const dataToImport = [...pendingCSVData];

  closeCSVModal();

  let successCount = 0;
  db.run("BEGIN TRANSACTION;");
  try {
    db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [
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

    for (let i = startIndex; i < endIndex; i++) {
      const cols = dataToImport[i];
      if (cols.length === 0 || cols.every((c) => !c.trim())) continue;

      const dateStr =
        mapDate !== -1 && cols[mapDate] !== undefined
          ? cols[mapDate].trim()
          : "";
      const accountStr =
        mapAccount !== -1 && cols[mapAccount] !== undefined
          ? cols[mapAccount].trim()
          : "";
      const memo =
        mapMemo !== -1 && cols[mapMemo] !== undefined
          ? cols[mapMemo].trim()
          : "";
      // "¥1,500" のようなカンマや記号付き金額もパースできるように数字とマイナス以外を除去
      // 日本の銀行CSVでよく使われる「△」をマイナスとして処理する
      const rawAmount =
        mapAmount !== -1 && cols[mapAmount] !== undefined
          ? cols[mapAmount]
          : "";

      // まず全角数字・全角マイナス等を半角に変換
      let normalizedAmount = rawAmount
        .replace(/[０-９]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[ー−△]/g, "-");

      // 会計特有の (1,500) というマイナス表記を -1500 に変換する
      if (/^\s*\([\d,.]+\)\s*$/.test(normalizedAmount)) {
        normalizedAmount = "-" + normalizedAmount.replace(/[()]/g, "");
      }

      // その後、半角数字・ピリオド・マイナス以外を除去
      const amountStr = normalizedAmount.replace(/[^\d.-]/g, "");
      let amount = parseInt(amountStr, 10);
      if (amount > 10000000000000 || amount < -10000000000000) {
        amount = NaN; // 上限超過は弾く
      }

      // 摘要(メモ)が空の行でも、金額が存在すればインポートする
      if (!isNaN(amount)) {
        let parsedDate = new Date(dateStr);
        // YYYY-MM-DD形式等のタイムゾーン問題を回避する
        if (dateStr && /^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr.trim())) {
          const parts = dateStr.trim().split("-");
          parsedDate = new Date(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10) - 1,
            parseInt(parts[2], 10),
          );
        }

        if (dateStr && !isNaN(parsedDate.getTime())) {
          // タイムゾーンによる日付のズレを防ぐため、ローカル時間のまま手動で文字列化
          const yyyy = parsedDate.getFullYear();
          const mm = String(parsedDate.getMonth() + 1).padStart(2, "0");
          const dd = String(parsedDate.getDate()).padStart(2, "0");
          const localDateStr = `${yyyy}-${mm}-${dd} 00:00:00`;

          db.run(
            "INSERT INTO records (parent_id, memo, amount, created_at, account) VALUES (?, ?, ?, ?, ?)",
            [parentId, memo, amount, localDateStr, accountStr],
          );
        } else {
          db.run(
            "INSERT INTO records (parent_id, memo, amount, account) VALUES (?, ?, ?, ?)",
            [parentId, memo, amount, accountStr],
          );
        }
        successCount++;
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
    if (document.getElementById("period-filter")) {
      document.getElementById("period-filter").value = "all";
    }
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);

    alert(`${successCount} 件のデータをインポートしました。`);
  } catch (err) {
    db.run("ROLLBACK;");
    alert("インポート中にエラーが発生しました。");
    console.error(err);
  }
  renderData();
}

// 8. AI連携用のプロンプトコピー機能 (BYO-AIアプローチ)
function copyAIPrompt() {
  const promptText = `あなたは優秀なデータ変換アシスタントです。
私がこれから提示する『未知の会計ソフトのサンプルCSV』を解析し、GrindMoney（お金管理アプリ）で出力するための『マッピング設定（JSON形式）』を作成してください。

GrindMoneyが持っているデータ仕様は以下の通りです：
{ "memo": "摘要", "amount": "金額", "created_at": "作成日時" }

それでは、以下の枠内にサンプルCSVを貼り付けるので、どの列にどのデータを割り当てるべきか、マッピング用のJSONだけを出力してください。

[ここにサンプルCSVを貼り付けてください]`;

  navigator.clipboard
    .writeText(promptText)
    .then(() => {
      alert(
        "✅ AI用のプロンプトをクリップボードにコピーしました！\n\nChatGPTやClaudeに貼り付けて、変換したい会計ソフトのサンプルCSVを渡してください。",
      );
    })
    .catch((err) => {
      console.error("コピーに失敗しました", err);
    });
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
  console.log("GrindMoneyがインストールされました");
});

// --- コマンドパレット制御 ---
let isCommandPaletteOpen = false;
let selectedCommandIndex = 0;
const commandsList = [
  {
    id: "save",
    icon: '<svg class="w-5 h-5"><use href="#icon-save"></use></svg>',
    title: "データを保存する (Save)",
    action: () => saveGrindFile(),
  },
  {
    id: "open",
    icon: '<svg class="w-5 h-5"><use href="#icon-folder"></use></svg>',
    title: "ファイルを開く (Open)",
    action: () => loadGrindFile(),
  },
  {
    id: "saveas",
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: "複製して保存する (Save As)",
    action: () => saveGrindFile(true),
  },
  {
    id: "new",
    icon: '<svg class="w-5 h-5"><use href="#icon-sparkles"></use></svg>',
    title: "新しいブロックを作成する (New)",
    action: () => document.getElementById("new-block-memo").focus(),
  },
  {
    id: "import",
    icon: '<svg class="w-5 h-5"><use href="#icon-import"></use></svg>',
    title: "CSVインポート (Import CSV)",
    action: () => document.getElementById("csv-input").click(),
  },
  {
    id: "export",
    icon: '<svg class="w-5 h-5"><use href="#icon-export"></use></svg>',
    title: "CSVエクスポート (Export CSV)",
    action: showExportModal,
  },
  {
    id: "editdict",
    icon: '<svg class="w-5 h-5"><use href="#icon-pencil"></use></svg>',
    title: "カスタム科目辞書を編集",
    action: () => showAccountDictEditor(),
  },
  {
    id: "ai",
    icon: '<svg class="w-5 h-5"><use href="#icon-bot"></use></svg>',
    title: "AI用プロンプトをコピー (AI)",
    action: copyAIPrompt,
  },
];

function toggleCommandPalette() {
  const palette = document.getElementById("cmd-palette");
  const input = document.getElementById("cmd-input");
  isCommandPaletteOpen = !isCommandPaletteOpen;
  if (isCommandPaletteOpen) {
    palette.classList.remove("hidden");
    palette.classList.add("flex");
    document.body.style.overflow = "hidden";
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
    document.body.style.overflow = "";
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
            action: () => {
              if (confirm(`テンプレート「${row[1]}」を削除しますか？`)) {
                db.run("DELETE FROM templates WHERE id = ?", [row[0]]);
                setDirty(true);
                // 削除後はもう一度パレットを開き直して更新を反映
                setTimeout(toggleCommandPalette, 10);
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
  const q = query.toLowerCase();
  const dynamicCommands = getDynamicCommands();
  let filtered = dynamicCommands.filter(
    (c) => c.title.toLowerCase().includes(q) || c.id.includes(q),
  );

  // 入力が数式として評価できる場合、一番上に「電卓コマンド」を挿入
  if (q.match(/[0-9]/) && q.match(/[+\-*/×÷ー−]/)) {
    const calcResult = evaluateMath(q);
    if (calcResult !== null) {
      filtered.unshift({
        id: "calculator",
        icon: '<svg class="w-5 h-5 text-green-500"><use href="#icon-sparkles"></use></svg>',
        title: `= ${calcResult.toLocaleString("ja-JP")} <span class="text-xs text-slate-400 ml-2">(Enterでコピー)</span>`,
        action: () => {
          navigator.clipboard.writeText(calcResult.toString());
          const statusEl = document.getElementById("status");
          statusEl.innerHTML = `<span class="text-green-400">📋</span> ${calcResult.toLocaleString("ja-JP")} をコピーしました`;
          statusEl.className =
            "fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border border-slate-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
          statusEl.style.pointerEvents = "auto";
          hideStatus();
        },
      });
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
    div.className = `px-4 py-3 my-1 flex items-center gap-3 rounded-md cursor-pointer transition-colors ${isSelected ? "bg-primary-50 text-primary" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`;
    div.innerHTML = `<span class="text-xl">${cmd.icon}</span><span class="font-medium tracking-wide">${cmd.title}</span>`;
    div.onclick = () => {
      toggleCommandPalette();
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

  // 上書き保存 (Cmd+S / Ctrl+S)
  if (
    (e.metaKey || e.ctrlKey) &&
    (key === "s" || key === "ｓ" || e.code === "KeyS")
  ) {
    e.preventDefault();
    saveGrindFile();
    return;
  }

  if (e.key === "Escape") {
    // モーダルやパレットが開いていれば閉じる
    if (isCommandPaletteOpen) {
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
        .getElementById("account-dict-editor-modal")
        .classList.contains("hidden")
    ) {
      closeAccountDictEditor();
      return;
    }
  }

  if (isCommandPaletteOpen) {
    const input = document.getElementById("cmd-input");

    const filtered = getFilteredCommands(input.value);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCommandIndex =
        (selectedCommandIndex - 1 + filtered.length) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === "Enter" && filtered[selectedCommandIndex]) {
      e.preventDefault();
      toggleCommandPalette();
      filtered[selectedCommandIndex].action();
    }
  }
});

// --- マルチタブ起動によるデータ競合の防止 ---
const bc = new BroadcastChannel("grindmoney_app_channel");

bc.onmessage = (e) => {
  if (e.data === "ping") {
    bc.postMessage("pong"); // すでに開いているタブが応答する
  } else if (e.data === "pong") {
    // 自分が後から開いたタブだった場合
    alert(
      "⚠️ GrindMoneyは既に別のタブまたはウィンドウで開かれています。\n\nデータ競合（バックアップの巻き戻り）を防ぐため、このタブでの編集は行わないでください。",
    );
    document.body.style.opacity = "0.5";
    document.body.style.pointerEvents = "none";
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

// --- 科目サジェスト (オートコンプリート) 機能 ---
const accountDictionaries = {
  custom: [], // ユーザー定義の辞書
  none: [],
  yayoi: [
    "売上高",
    "現金",
    "普通預金",
    "当座預金",
    "売掛金",
    "買掛金",
    "未払金",
    "預り金",
    "前払金",
    "前受金",
    "立替金",
    "仮払金",
    "仮受金",
    "事業主貸",
    "事業主借",
    "元入金",
    "役員借入金",
    "役員貸付金",
    "租税公課",
    "荷造運賃",
    "水道光熱費",
    "旅費交通費",
    "通信費",
    "広告宣伝費",
    "接待交際費",
    "損害保険料",
    "修繕費",
    "消耗品費",
    "減価償却費",
    "福利厚生費",
    "給料手当",
    "専従者給与",
    "外注工賃",
    "利子割引料",
    "地代家賃",
    "貸倒金",
    "雑費",
    "支払手数料",
    "会議費",
    "新聞図書費",
    "車両費",
    "諸会費",
    "リース料",
  ],
  freee: [
    "売上高",
    "現金",
    "普通預金",
    "当座預金",
    "売掛金",
    "買掛金",
    "未払金",
    "預り金",
    "前払金",
    "前受金",
    "立替金",
    "仮払金",
    "仮受金",
    "事業主貸",
    "事業主借",
    "元入金",
    "役員借入金",
    "役員貸付金",
    "租税公課",
    "荷造運賃",
    "水道光熱費",
    "旅費交通費",
    "通信費",
    "広告宣伝費",
    "接待交際費",
    "損害保険料",
    "修繕費",
    "消耗品費",
    "減価償却費",
    "福利厚生費",
    "給料手当",
    "専従者給与",
    "外注工賃",
    "利子割引料",
    "地代家賃",
    "貸倒金",
    "雑費",
    "支払手数料",
    "会議費",
    "新聞図書費",
    "車両費",
    "諸会費",
    "リース料",
  ],
  mf: [
    "売上高",
    "現金",
    "普通預金",
    "当座預金",
    "売掛金",
    "買掛金",
    "未払金",
    "預り金",
    "前払前渡金",
    "前受金",
    "立替金",
    "仮払金",
    "仮受金",
    "事業主貸",
    "事業主借",
    "元入金",
    "役員借入金",
    "役員貸付金",
    "租税公課",
    "荷造運賃",
    "水道光熱費",
    "旅費交通費",
    "通信費",
    "広告宣伝費",
    "接待交際費",
    "損害保険料",
    "修繕費",
    "消耗品費",
    "減価償却費",
    "福利厚生費",
    "給料手当",
    "専従者給与",
    "外注工賃",
    "利子割引料",
    "地代家賃",
    "貸倒金",
    "雑費",
    "支払手数料",
    "会議費",
    "新聞図書費",
    "車両費",
    "諸会費",
    "リース料",
  ],
  freeway: [
    "売上高",
    "現金",
    "普通預金",
    "当座預金",
    "売掛金",
    "買掛金",
    "未払金",
    "預り金",
    "前払金",
    "前受金",
    "立替金",
    "仮払金",
    "仮受金",
    "事業主貸",
    "事業主借",
    "元入金",
    "役員借入金",
    "役員貸付金",
    "租税公課",
    "荷造運賃",
    "水道光熱費",
    "旅費交通費",
    "通信費",
    "広告宣伝費",
    "接待交際費",
    "損害保険料",
    "修繕費",
    "消耗品費",
    "減価償却費",
    "福利厚生費",
    "給料手当",
    "専従者給与",
    "外注工賃",
    "利子割引料",
    "地代家賃",
    "貸倒金",
    "雑費",
    "支払手数料",
    "会議費",
    "新聞図書費",
    "車両費",
    "諸会費",
    "リース料",
  ],
};

function changeAccountDict() {
  const select = document.getElementById("dict-select");
  const dictKey = select.value;
  try {
    localStorage.setItem("accountDict", dictKey);
  } catch (e) {
    console.warn("ローカルストレージへの保存がブロックされました");
  }
  renderAccountSuggestions(dictKey);
}

function renderAccountSuggestions(dictKey) {
  const datalist = document.getElementById("account-suggestions");
  if (!datalist) return;
  datalist.innerHTML = "";

  const dict = accountDictionaries[dictKey] || [];
  dict.forEach((account) => {
    const option = document.createElement("option");
    option.value = account;
    datalist.appendChild(option);
  });
}

function loadCustomDict() {
  const savedDict = localStorage.getItem("customAccountDict");
  if (savedDict) {
    try {
      const parsed = JSON.parse(savedDict);
      if (Array.isArray(parsed)) {
        // 古い形式(文字列の配列)から新しい形式(オブジェクトの配列)へマイグレーション
        if (parsed.length > 0 && typeof parsed[0] === "string") {
          customAccountDict = parsed.map((name) => ({ name, hidden: false }));
        } else {
          customAccountDict = parsed;
        }
      } else {
        throw new Error("Invalid format"); // catchブロックに飛ばしてデフォルト値をセットさせる
      }
    } catch (e) {
      // パースに失敗したらデフォルトで上書き
      customAccountDict = accountDictionaries.yayoi.map((name) => ({
        name,
        hidden: false,
      }));
    }
  } else {
    // 初回起動時は弥生会計のリストをデフォルトとしてセット
    customAccountDict = accountDictionaries.yayoi.map((name) => ({
      name,
      hidden: false,
    }));
  }
  accountDictionaries.custom = customAccountDict
    .filter((i) => !i.hidden)
    .map((i) => i.name);
}

function saveCustomDict() {
  try {
    localStorage.setItem(
      "customAccountDict",
      JSON.stringify(customAccountDict),
    );
  } catch (e) {
    alert(
      "ブラウザの保存容量がいっぱいで、辞書を保存できませんでした。不要なデータを削除してください。",
    );
    return false;
  }
  accountDictionaries.custom = customAccountDict
    .filter((i) => !i.hidden)
    .map((i) => i.name);
  // 現在の選択がカスタムなら、datalistを即時更新
  if (document.getElementById("dict-select").value === "custom") {
    renderAccountSuggestions("custom");
  }
  return true;
}

// --- カスタム科目辞書エディタ ---
let draggedItemIndex = null;

function showAccountDictEditor() {
  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
  renderCustomDictEditor();

  document.getElementById("add-custom-dict-form").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("new-custom-account");
    const newAccountName = input.value.trim();
    if (newAccountName) {
      const existing = customAccountDict.find(
        (item) => item.name === newAccountName,
      );
      if (existing) {
        existing.hidden = false; // 存在していれば再表示
      } else {
        customAccountDict.push({ name: newAccountName, hidden: false });
      }
      renderCustomDictEditor();
    }
    input.value = "";
    input.focus();
  };
}

function closeAccountDictEditor() {
  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
  // 変更を保存せずに閉じた場合は、元の状態に戻す
  loadCustomDict();
}

function saveCustomDictAndClose() {
  if (!saveCustomDict()) return; // 失敗時は閉じない

  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

function renderCustomDictEditor() {
  const list = document.getElementById("custom-dict-list");
  list.innerHTML = "";
  customAccountDict.forEach((item, index) => {
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
          <button type="button" onclick="event.stopPropagation(); moveCustomDictItem(${index}, 1)" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === customAccountDict.length - 1 ? "opacity-30 cursor-not-allowed" : ""}" ${index === customAccountDict.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <!-- 表示/非表示トグル -->
        <button onclick="toggleCustomAccountHidden(${index})" class="text-slate-400 hover:text-slate-600 transition-colors shrink-0" title="${title}">
          <svg class="w-5 h-5"><use href="#${icon}"></use></svg>
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
      let droppedOnIndex = index;

      if (draggedItemIndex === droppedOnIndex) return; // 同じ場所なら何もしない

      const [reorderedItem] = customAccountDict.splice(draggedItemIndex, 1);
      customAccountDict.splice(droppedOnIndex, 0, reorderedItem);
      renderCustomDictEditor();
    });
    li.addEventListener("dragend", (e) =>
      e.target.classList.remove("opacity-30"),
    );
    list.appendChild(li);
  });
}

// スマホタップ用のカスタム科目並び替え関数
function moveCustomDictItem(index, direction) {
  if (index + direction < 0 || index + direction >= customAccountDict.length)
    return;
  const item = customAccountDict.splice(index, 1)[0];
  customAccountDict.splice(index + direction, 0, item);
  renderCustomDictEditor();
}

function toggleCustomAccountHidden(index) {
  if (customAccountDict[index]) {
    customAccountDict[index].hidden = !customAccountDict[index].hidden;
    renderCustomDictEditor();
  }
}

function setAllCustomAccountsHidden(isHidden) {
  customAccountDict.forEach((item) => {
    item.hidden = isHidden;
  });
  renderCustomDictEditor();
}

// --- ハッシュタグモーダル制御 ---
function showTagModal(tag, data) {
  const modal = document.getElementById("tag-modal");
  document.getElementById("tag-modal-title").textContent = tag;
  document.getElementById("tag-modal-total").textContent =
    "¥" + data.amount.toLocaleString("ja-JP");

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
        <td class="py-4 px-6 text-right font-mono font-bold text-slate-600">¥${item.amount.toLocaleString("ja-JP")}</td>
      </tr>
    `;
  });

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
}

function closeTagModal() {
  const modal = document.getElementById("tag-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

if (!window.isSecureContext) {
  alert(
    "⚠️ セキュリティ警告 ⚠️\n\n現在のアクセス環境 (HTTP) では、ブラウザのセキュリティ制限によりファイルの読み書きや暗号化機能がブロックされます。\n\nGrindMoneyを正常に動作させるには、必ず「HTTPS」環境にアップロードするか、「localhost」で実行してください。",
  );
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.innerHTML = `<span class="text-red-400">⚠️</span> エラー: HTTPS環境またはlocalhostでの実行が必要です`;
    statusEl.className =
      "fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-900/90 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-xl border border-red-700/50 transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100";
    statusEl.style.pointerEvents = "auto";
  }
} else {
  // アプリ起動時にSQLiteをロード
  initSQLite();
}

loadCustomDict();
const savedDict = localStorage.getItem("accountDict") || "custom";
const dictSelect = document.getElementById("dict-select");
if (dictSelect) dictSelect.value = savedDict;
renderAccountSuggestions(savedDict);
updateFiscalYearButton();

// ページ離脱時の警告（データ未保存防止）
window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "";
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
  closeAccountDictEditor();

  // 拡張子に応じて処理を分岐
  if (file.name.endsWith(".grind") || file.name.endsWith(".sqlite")) {
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
  } else if (file.name.endsWith(".csv")) {
    if (isDirty) {
      if (
        !confirm(
          "未保存のデータがあります。変更を破棄してCSVをインポートしますか？",
        )
      )
        return;
    }
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
      "サポートされていないファイルです。.grind または .csv 形式のファイルをドロップしてください。",
    );
  }
});

// OSを判定してショートカットキーのUI表示を最適化
const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
const shortcutEl = document.getElementById("cmd-shortcut-key");
if (shortcutEl) {
  shortcutEl.textContent = isMac ? "⌘K" : "Ctrl+K";
}

// --- 最後の砦：タブ閉じ/バックグラウンド移行時の強制バックアップ ---
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isDirty && db) {
    try {
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

      const password = document.getElementById("file-password").value;
      const data = db.export();
      if (password) {
        encryptData(data, password)
          .then((encData) => {
            saveDraft(encData).catch((e) =>
              console.error("Emergency save failed", e),
            );
          })
          .catch((e) => console.error("Emergency encrypt failed", e));
      } else {
        // ページが隠れる瞬間に、タイマーを待たずに同期的にIndexedDBへ叩き込む
        saveDraft(data).catch((e) => console.error("Emergency save failed", e));
      }
    } catch (e) {
      console.error("Emergency save error", e);
    }
  }
});
