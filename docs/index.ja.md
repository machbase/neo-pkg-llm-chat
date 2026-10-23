---
title: LLM Chat 技術ドキュメント
weight: 10
---

# LLM Chat 技術ドキュメント

<p align="center" style="margin-top:1.25rem"><a href="./index.kr.md">한국어</a> | <a href="./index.en.md">English</a> | <strong>日本語</strong></p>

Machbase Neo LLM Chatパッケージは、Machbase Neo時系列データベースと自然言語でやり取りできるLLMチャットインターフェースです。
会話を通じて、データの照会、ダッシュボードの作成、分析レポートの作成、マニュアル文書の探索ができます。

パッケージは内部でエージェンティックループを実行し、ユーザーの質問をLLMに渡し、ツール呼び出しをMachbase Neoで実行したうえで、その結果を再びLLMにフィードバックする処理を、最終応答が生成されるまで繰り返します。

## インストール

Machbase Neo左側のサイドパネルには、利用可能なパッケージの一覧が表示されます。  
ここでLLM Chatパッケージを選択し、`Install`ボタンを押すとインストールできます。

インストールには少し時間がかかる場合があるため、完了するまでしばらく待ちます。

![パッケージのインストール画面](./images/package-install.png)

### 要件

- Machbase Neo 8.7.3以上
- LLM Chatを使用するアカウントのMachbase Neo APIトークン（Neo Webコンソールで発行、[初期設定](./first-setup.ja.md)を参照）

### アンインストール

左側のパネルで`neo-pkg-llm-chat`を選択し、**Uninstall**を押すと、パッケージと関連サービスが削除されます。

## LLMプロバイダー

4種類のLLMプロバイダーをサポートしています。プロバイダーの呼び出し自体は単発（non-streaming）のリクエスト・レスポンスとして処理され、ツール実行のステップごとの進行状況はWebSocketを通じてブラウザにストリーミング表示されます。

| プロバイダー | API | ローカル |
| :--- | :--- | :---: |
| Claude | Anthropic API | いいえ |
| ChatGPT | OpenAI API | いいえ |
| Gemini | Google Gemini API | いいえ |
| Ollama | Ollama REST API | はい |

プロバイダーと接続の設定は、WebベースのSettings画面で行います。API Key、モデル一覧、Machbase Neoの接続情報はアカウントごとにサーバーに保存されますが、Machbase Neo APIトークンはサーバーには保存されず、ブラウザにのみ保存されます。

## エージェンティックループ

エージェンティックループは、このパッケージの中核となる実行エンジンです。質問のタイプを判定して実行フローを選んだ後、LLMがそのフローのツールを実行し、結果を見て次の手順を決める処理を、回答が得られるまで繰り返します（ツール呼び出しは実行前に自動で補正・検査されます）。

## このドキュメントで扱う内容

- パッケージのインストール
- 初期設定とモデルの登録
- Chat画面の使い方と質問パターン
- 組み込みツールと自動化機能
- HTTP APIとWebSocketプロトコル
- 接続の問題とよくあるエラーの確認

## 基本的な作業手順

1. NeoでLLM Chatパッケージをインストールします。
2. Neo Webコンソールで、使用するアカウントのAPIトークンを発行します。
3. 初めて開いたら、Settings画面でHost、Port、APIトークンを入力し、**검증**（検証）を押します。
4. 使用するプロバイダーのAPI KeyまたはEndpointを入力します。
5. 使用するモデルを1つ以上登録します。
6. Saveしてから、Chat画面に移動します。
7. Chat画面でモデルを選択し、質問を送信します。

## 画面構成

- Settings画面
  - Machbase Connection
  - API Keys & Endpoints
  - Models
- Chat画面
  - 会話エリア
  - モデル選択ボタン
  - 接続状態の表示
  - メッセージ入力欄

![LLM Chatのメイン画面](./images/llm-chat-main.png)

## ドキュメント一覧

- [初期設定](./first-setup.ja.md)
- [Chatの使い方](./chat-usage.ja.md)
- [技術リファレンス](./technical-reference.ja.md)
- [HTTP APIとWebSocket](./http-api-and-websocket.ja.md)
- [トラブルシューティング](./troubleshooting.ja.md)

## ページ移動

- [次へ：初期設定](./first-setup.ja.md)
