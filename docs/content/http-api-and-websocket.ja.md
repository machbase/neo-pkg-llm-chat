---
title: HTTP APIとWebSocket
weight: 50
---

このドキュメントでは、LLM Chatパッケージサービスが提供するHTTP APIエンドポイントとWebSocketプロトコルをまとめます。

パッケージはゲートウェイ/ワーカー構成を採用しています。ブラウザーがゲートウェイへWebSocketを開くと、ゲートウェイがセッションごとにワーカープロセスを起動し、エージェンティックループを実行します。**チャットはすべてWebSocketで処理され、HTTPは使いません** — HTTPエンドポイントは設定、ユーザー環境設定、ヘルス/診断の用途にのみ使われます。

## HTTP APIエンドポイント

設定のレスポンスはすべて`{ success, reason, data }`形式のJSONを使います。CORSのプリフライトを避けるため、`PUT` / `DELETE`はクエリパラメーター`_method=PUT`または`_method=DELETE`と`text/plain`の本文を持つ`POST`としても送信できます。

### ヘルスと診断

| Method | Path | 説明 |
| :---: | :--- | :--- |
| GET | `/health` | ヘルスチェック。`{ "ok": true }`を返す |
| GET | `/api/debug` | 診断：configsディレクトリとファイル一覧、アクティブなワーカー数。APIトークンが必要 |

サービスポートは`configs/sys.json`の`server.port`で指定します（デフォルト`8884`）。ランチャーが起動時にこの値を読み込みます。

### ユーザー設定

設定はユーザーごとに保存されます（`configs/{user}.json`）。設定名はMachbaseのユーザー名です。

以下のトークン検証・設定・環境設定APIでは、**すべてのリクエストに`Authorization: Bearer {APIトークン}`ヘッダーが必要です**（Neo Webコンソールで発行した`nt_`で始まるトークン）。サーバーはMachbase Neoの`POST /db/token/validate`でトークンを検証してアカウントを確定し、本人のものではない名前を要求すると拒否します。アカウント名は小文字で扱います（例：`SYS` → `sys`）。

| 状況 | レスポンス |
| :--- | :--- |
| トークンなし / 無効 / 削除・期限切れ | `401` `{"success": false, "reason": "authentication required"}` |
| 他のユーザーの設定を要求 | `403` `{"success": false, "reason": "forbidden"}` |

### トークン検証

| Method | Path | 説明 |
| :---: | :--- | :--- |
| GET | `/api/token/validate` | ヘッダーのAPIトークンを検証してアカウント名を返す。成功時は`200` `{"success": true, "data": {"user": "sys"}}`、失敗時は`401` `{"success": false, "reason": "invalid token"}` |

Settings画面の**검증**（検証）ボタンがこのAPIを呼び出します。コンソールのログインアカウントと一致するかどうかは、ブラウザー側で別途確認します。

| Method | Path | 説明 |
| :---: | :--- | :--- |
| GET | `/api/configs` | 設定名の一覧（**本人のもののみ**）。`?name={name}`を付けるとその設定を返す |
| POST | `/api/configs` | 設定を保存。ファイル名と本文の`machbase.user`を**トークンのユーザーに固定**します（本文に別のアカウントを書いても無視）。本文の`machbase.token`・`machbase.password`は**保存せずに削除**します |
| PUT | `/api/configs?name={name}` | 設定を変更 |
| DELETE | `/api/configs?name={name}` | 設定を削除 |
| GET | `/api/configs/{name}` | 特定の設定を取得 |
| PUT | `/api/configs/{name}` | 特定の設定を変更 |
| DELETE | `/api/configs/{name}` | 特定の設定を削除 |

### ユーザー別UI環境設定

| Method | Path | 説明 |
| :---: | :--- | :--- |
| GET | `/api/prefs` | ユーザーUI環境設定（お気に入り）を取得 |
| POST | `/api/prefs` | ユーザーUI環境設定（お気に入り）を保存 |
| PUT | `/api/prefs` | ユーザーUI環境設定（お気に入り）を保存 |

対象ユーザーはトークンから決まります — 名前をパラメーターとして受け取りません。

### WebSocketパス

| Method | Path | 説明 |
| :---: | :--- | :--- |
| GET | `/ws` | ブラウザーのチャット用WebSocket。ユーザーは**メッセージごとに`auth_token`を検証して**確定します |
| GET | `/internal/ws` | 内部のゲートウェイ ↔ ワーカー間チャネル（クライアント用ではない） |

### リレールート

接続先のMachbase Neoサーバーへ直接プロキシするルートです（UIがTQLを実行し、チャート/ダッシュボードを描画するときに使用）。

| Method | Path | 説明 |
| :---: | :--- | :--- |
| POST | `/db/tql` | TQL実行のリレー。Neoの`/db/tql`へ転送します。**`Authorization: Bearer {APIトークン}`ヘッダーが必須**で、呼び出し元のトークンをそのまま渡します（トークンがなければ`401`） |
| GET | `/web/*path` | Machbase Neoの`/web/*`パスへリレー。**呼び出し元の`Authorization`ヘッダーのみ**を転送します（サービスアカウントで代わりに認証しない）。サービスポートを直接呼び出したときだけ届き、Neoのサービスプロキシ（`/web/services/...`）経由では公開されません |

リレーは呼び出し元トークンのアカウントで実行されるため、権限外のテーブルはMachbaseが拒否します。

### 例：ヘルスチェック

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
```

### 例：トークン検証

```bash
TOKEN=nt_a_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/token/validate
```

```json
{"success": true, "reason": "success", "data": {"user": "sys"}}
```

### 例：保存済み設定の一覧

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/configs
```

```json
{"success": true, "reason": "success", "data": {"configs": ["sys"]}}
```

トークンなしで呼び出すと`401`が返ります。

## WebSocketプロトコル

チャットUIはWebSocketでサービスと通信します。接続URLは`ws://{host}:{port}/ws`です。ゲートウェイは各セッションをワーカープロセスへルーティングし、ワーカーのストリーミングメッセージをブラウザーへ中継します。

**すべてのクライアントメッセージに`auth_token`（Machbase Neo APIトークン）を含める必要があります**。ゲートウェイはメッセージごとにトークンを検証してユーザーを確定するため、トークンを変更したりNeoでトークンを削除したりすると、次のメッセージからすぐに反映されます。`user_id`フィールドは本人の判定には使いません。

検証したトークンは、ゲートウェイがワーカーへ送る`chat`メッセージにのみ載せて渡し、ワーカー設定ファイル（`workers/*.json`）やユーザー設定ファイルには記録しません。

検証に失敗すると、次のレスポンスが返ります。

```json
{"type": "error", "code": "auth_required", "msg": "API 토큰이 확인되지 않았습니다. 설정에서 토큰을 확인한 뒤 다시 시도하세요."}
```

別のアカウントが作成したセッションIDでメッセージを送ると、`code: "auth_required"`、`msg: "다른 계정의 세션입니다."`（別アカウントのセッションです）で拒否します。

### クライアント → サーバーメッセージ

**get_models** — 利用可能なLLMプロバイダーとモデルを要求します。

```json
{"type": "get_models", "auth_token": "nt_a_xxxx..."}
```

**chat** — チャットメッセージを送信します（`provider`と`model`は必須）。

```json
{
  "type": "chat",
  "auth_token": "nt_a_xxxx...",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "query": "Analyze the GOLD table",
  "tz": "Asia/Seoul"
}
```

`tz`は任意で、ブラウザのタイムゾーン（IANA名）です。照会結果・チャート・レポートの時刻と、モデルに伝える現在時刻の基準になり、省略するとサーバーのタイムゾーンを使います。

**stop** — 現在の生成を停止します。

```json
{"type": "stop", "session_id": "sess-1234567890"}
```

**clear** — セッションを初期化します（ワーカーを終了）。

```json
{"type": "clear", "session_id": "sess-1234567890"}
```

### サーバー → クライアントメッセージ

**models** — `get_models`に対するレスポンスです。

```json
{"type": "models", "providers": [ { "provider": "claude", "models": ["..."] } ]}
```

このアカウントの設定がまだ保存されていない場合は、`providers`の代わりに次が返ります。

```json
{"type": "models", "msg": "No providers configured. Please set API keys in Settings."}
```

**msg** — ストリーミングのエンベロープです。進行状況の説明も最終回答も、すべて`msg`イベントとして届きます。内部の`message.type`が段階を表し、テキストは`body.ofStreamBlockDelta`で届きます。

```json
{
  "type": "msg",
  "message": {
    "ver": "1.0",
    "id": 1699999999999,
    "type": "stream_block_delta",
    "body": {
      "ofStreamBlockDelta": {
        "contentType": "text/markdown",
        "text": "Querying the GOLD table..."
      }
    }
  }
}
```

内部の`message.type`の段階（発生順）は次のとおりです。

- `answer_start` — 応答の開始
- `stream_block_start` / `stream_block_delta` / `stream_block_stop` — 進行状況の説明（ツールの各ステップがここでマークダウンテキストとして説明される）
- `stream_msg_start` / `stream_msg_delta` / `stream_msg_stop` — 最終回答のテキスト
- `answer_stop` — 応答の完了

**followups** — 回答の後に続けて尋ねるとよい質問の候補（生成できない場合は送られません）：

```json
{"type": "followups", "session_id": "sess-1234567890", "items": ["..."]}
```

**error** — エラーが発生したことを通知します（例：`config_required`のような`code`を含む場合があります）。

```json
{"type": "error", "session_id": "sess-1234567890", "msg": "Agent error: ..."}
```

> 注：`tool_call` / `tool_result`という個別のメッセージはありません。ツールの動作は、`stream_block_delta`の進行イベントの中でマークダウンテキストとしてストリーミングされます。

## ページ移動

- [前へ：技術リファレンス]({{< relref "technical-reference" >}})
- [目次に戻る]({{< relref "/" >}})
- [次へ：トラブルシューティング]({{< relref "troubleshooting" >}})
