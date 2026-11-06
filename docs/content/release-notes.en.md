---
title: Release Notes
weight: 70
---

Main changes in each version and how to update.

## How to Update

| Current version | How to update | After updating |
| :--- | :--- | :--- |
| 4.0.0 – 4.0.1 | Update from the package list | Nothing |
| 2.0.0 – 3.3.1 | Update from the package list | Register an API token in Settings (see [First Setup]({{< relref "first-setup" >}})) |
| 1.0.x | Uninstall the package, then install it again | Enter all Settings again |

- Machbase Neo 8.7.3 or later required — check your Neo version before updating
- Existing settings (providers, models, connection) and favorites kept after the update
- Chat unavailable for a few seconds during the update — an answer in progress stops
- After updating from 4.0.1 or earlier, if the screen has not changed, right-click inside the LLM Chat screen → **Reload frame** — needed separately for each address you use (`127.0.0.1`, `192.168.x.x`, etc.)
- 1.0.x: reinstall instead of updating — different internal structure

## 4.0.2 (2026-11-06)

- **How to issue a token** guide with step-by-step pictures added to the Settings screen
- **Screen refreshes itself after updates**: From the next update on, an old cached screen reopens as the new version automatically
- **Documentation updates**
  - Korean and Japanese README added
  - Contents summary for each document added to the manual index

## 4.0.1 (2026-11-03)

- **More reliable dashboards**: Fixed advanced analysis dashboards stopping halfway
- **Closed networks**: Screen displays correctly without an internet connection
- **More reliable install and update**
  - Files from the previous version cleaned up after an update
  - Fixed the service running twice
- **Release notes** page added
- New package icon

## 4.0.0 (2026-10-26)

- **API token authentication**
  - Connection with a per-account API token instead of the Neo console login
  - Data queries run with the token account's permissions
- **Time zone**: Times in reports, query results, and charts shown in the browser's time zone
- **Better answers**: Query basis actually applied (unit, period, tags) shown with Ollama model answers
- **Improved security check**
  - Instructions to change or delete data blocked
  - Questions about them answered
- **Japanese documentation** added
- **Timer feature removed**
  - Creating Neo timers from chat removed
  - Questions about timers answered with the manual
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

- [Previous: Troubleshooting]({{< relref "troubleshooting" >}})
- [Back to Index]({{< relref "/" >}})
