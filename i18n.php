<?php
session_start();

// セッションに言語が設定されていなければ、デフォルトを'ja'にする
if (!isset($_SESSION['lang'])) {
    $_SESSION['lang'] = 'ja';
}

function get_translation($key)
{
    $lang = $_SESSION['lang'];
    $file = __DIR__ . "/../locales/{$lang}.json";

    // ファイルが存在しない場合は英語にフォールバック
    if (!file_exists($file)) {
        $file = __DIR__ . "/../locales/en.json";
    }

    $json = file_get_contents($file);
    $translations = json_decode($json, true);

    // キーが見つかればその値を、なければキーそのものを返す
    return $translations[$key] ?? $key;
}
