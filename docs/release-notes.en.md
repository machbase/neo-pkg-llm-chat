---
title: Release Notes
weight: 70
---

# Release Notes

<p align="center" style="margin-top:1.25rem"><a href="./release-notes.kr.md">한국어</a> | <strong>English</strong> | <a href="./release-notes.ja.md">日本語</a></p>

Main changes in each version and how to update.

## How to Update

| Current version | How to update | After updating |
| :--- | :--- | :--- |
| 4.0.0 | Update from the package list | Nothing |
| 2.0.0 – 3.3.1 | Update from the package list | Register an API token in Settings (see [First Setup](./first-setup.en.md)) |
| 1.0.x | Uninstall the package, then install it again | Enter all Settings again |

- Machbase Neo 8.7.3 or later is required. Check your Neo version before updating.
- Your existing settings (providers, models, connection) and favorites are kept.
- Chat is unavailable for a few seconds during the update, and an answer in progress stops.
- After the update, reload any open LLM Chat screen.
- 1.0.x has a different internal structure, so reinstall it instead of updating.

## 4.0.1 (2026-11-03)

- **More reliable dashboards**: Advanced analysis dashboards no longer stop halfway.
- **Closed networks**: The screen displays correctly without an internet connection.
- **More reliable install and update**: Files from the previous version are cleaned up after an update, and the service no longer runs twice.
- **Release notes** page added
- New package icon

## 4.0.0 (2026-10-26)

- **API token authentication**: Connects with a per-account API token instead of the Neo console login. Data queries run with the token account's permissions.
- **Time zone**: Times in reports, query results, and charts are shown in the browser's time zone.
- **Better answers**: Answers from Ollama models also show the query basis actually applied (unit, period, tags).
- **Improved security check**: Instructions to change or delete data are blocked, while questions about them are answered.
- **Japanese documentation** added
- **Timer feature removed**: Creating Neo timers from chat has been removed. Questions about timers are answered with the manual.
- Minimum required Neo version changed to 8.7.3

## 3.3.1 (2026-09-10)

- Fixed a chat session error

## 3.3.0 (2026-09-10)

- Added technical reference and troubleshooting documents
- Fixed images in the documents

## 3.2.3 (2026-08-27)

- Added light mode
- Bug fixes

## 3.2.2 (2026-07-28)

- Improved Ollama response performance
- Fixed link handling

## 3.2.1 (2026-07-21)

- Improved forecast report format

## 3.2.0 (2026-07-20)

- Improved Ollama response performance
- Improved forecasting
- Updated Neo documentation and manual
- Improved design of the settings and report screens

## 3.1.0 (2026-07-10)

- Improved Ollama response performance
- Improved manual search

## 3.0.0 (2026-06-29)

- Declared the minimum required Neo version

## 2.5.0 (2026-06-02)

- Improved question editing and example question suggestions

## 2.0.1 (2026-05-28)

- Added editing of sent questions
- Added an example question suggestion panel
- Fixed scrolling when opened inside Neo

## 2.0.0 (2026-05-27)

- Runs inside Neo without a separate executable
- Dark theme for charts
- New package icon

## 1.0.2 (2026-05-12)

- Run TQL and SQL code blocks directly in chat
- Service start and stop support

## 1.0.1 (2026-04-28)

- First release: natural-language chat for querying and analyzing data, support for Claude, ChatGPT, Gemini, and Ollama, dashboard and report generation, web settings screen

## Navigation

- [Previous: Troubleshooting](./troubleshooting.en.md)
- [Back to Index](./index.en.md)
