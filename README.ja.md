# neo-pkg-llm-chat v4.0.2

[English](README.md) | [한국어](README.kr.md) | [日本語](README.ja.md)

Machbase Neo の時系列データを自然言語で照会・分析する LLM チャットパッケージです。

## 概要

neo-pkg-llm-chat は、Machbase Neo の時系列データを自然言語で照会・分析できる LLM ベースのチャットインターフェースです。

Web ブラウザで質問すると、LLM エージェントが Machbase Neo に保存されたデータを直接照会して分析します。  
SQL を書かなくても、テーブルの探索、タグ一覧の確認、データ分析、ダッシュボードやレポートの作成まで、ひとつの会話で行えます。

## 対象ユーザー

- **データ初心者** — SQL なしで、自然言語でデータを探索して理解できます
- **データエンジニア** — 複雑なクエリを書かずに、データをすばやく検証・分析・可視化できます

## 主な機能

- **複数の LLM プロバイダー** — Claude、ChatGPT、Gemini、Ollama（ローカル）から自由に選択・切り替え
- **Machbase との直接連携** — LLM がテーブル・タグ・時系列データを直接照会して分析
- **チャットでダッシュボード・レポートを作成** — 会話で分析ダッシュボードとレポートを作成
- **Web ベースの設定** — API キー、モデル、データベース接続をブラウザで簡単に設定

## 質問の例

- "Show me the table list"
- "What is Rollup?"
- "Create an analysis dashboard for the Example table"
- "Write a financial analysis report for the Example table"
- "Write a vibration analysis report for the Example table"

## ドキュメント

- [ユーザーマニュアル](https://machbase.github.io/neo-pkg-llm-chat/ja/) (English · 한국어 · 日本語)
- [リリースノート](https://machbase.github.io/neo-pkg-llm-chat/ja/release-notes/)
