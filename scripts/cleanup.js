'use strict';

// Post-update cleanup of orphaned files.
//
// Why: package updates overwrite the repo in place, so a file that existed in an
// older version but was removed in the new one stays behind as an orphan. This
// script deletes those leftovers using a MANUALLY-maintained list.
//
// MERGER: when you remove a file/folder from the repo, add its package-root-relative
// path to scripts/obsolete.json -> "remove". Keep the list cumulative (never prune):
// deletion is idempotent, so stale entries are harmless and version-jump updates
// (e.g. 1.0 -> 2.1) still get cleaned.
//
// Invoked from scripts/install.js (runs on install + update). Also runnable standalone:
//   machbase-neo jsh scripts/cleanup.js
//
// Safe by design: refuses absolute paths, ".." traversal, anything escaping the
// package root, and a hardcoded set of runtime/user-data dirs. Best-effort — it
// never throws into the caller, so a bad entry can't break install.

var path = require('path');
var fs = require('fs');

// Runtime / user data that must NEVER be deleted, even if listed by mistake.
var PROTECTED = [
  'scripts',
  'configs',
  'cgi-bin/llm/configs',
  'cgi-bin/llm/workers',
  'cgi-bin/llm/logs',
  'logs',
];

function normalizeRel(p) {
  // forward slashes, drop leading "./", drop trailing slashes, trim.
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}

function isProtected(rel) {
  for (var i = 0; i < PROTECTED.length; i++) {
    if (rel === PROTECTED[i] || rel.indexOf(PROTECTED[i] + '/') === 0) return true;
  }
  return false;
}

function runCleanup(pkgRoot) {
  var rootResolved = path.resolve(pkgRoot);
  var manifestPath = path.join(rootResolved, 'scripts', 'obsolete.json');
  var stats = { removed: 0, absent: 0, refused: 0, failed: 0 };

  var list;
  try {
    var parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    list = (parsed && parsed.remove) || [];
  } catch (e) {
    console.println('[cleanup] no/invalid manifest (' + manifestPath + '): ' + (e.message || e));
    return stats;
  }
  if (!list.length) {
    console.println('[cleanup] manifest empty — nothing to do');
    return stats;
  }

  for (var i = 0; i < list.length; i++) {
    var orig = list[i];
    var rel = normalizeRel(orig);

    // 1) reject empty / absolute / traversal
    if (!rel || rel === '.' || path.isAbsolute(orig) || rel.indexOf('..') >= 0) {
      console.println('[cleanup] REFUSED (unsafe): ' + orig);
      stats.refused++;
      continue;
    }
    // 2) reject runtime/user-data dirs
    if (isProtected(rel)) {
      console.println('[cleanup] REFUSED (protected): ' + rel);
      stats.refused++;
      continue;
    }

    var target = path.resolve(rootResolved, rel);
    // 3) final guard: target must stay strictly inside the package root
    var back = path.relative(rootResolved, target);
    if (back === '' || back.indexOf('..') === 0 || path.isAbsolute(back)) {
      console.println('[cleanup] REFUSED (escapes root): ' + rel);
      stats.refused++;
      continue;
    }

    if (!fs.existsSync(target)) {
      stats.absent++;
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      console.println('[cleanup] removed: ' + rel);
      stats.removed++;
    } catch (e) {
      console.println('[cleanup] FAILED: ' + rel + ' — ' + (e.message || e));
      stats.failed++;
    }
  }

  console.println('[cleanup] done — removed=' + stats.removed +
    ' absent=' + stats.absent + ' refused=' + stats.refused + ' failed=' + stats.failed);
  return stats;
}

module.exports = { runCleanup: runCleanup };

// Standalone execution: machbase-neo shell jsh scripts/cleanup.js
// Detect "run directly" without relying on require.main (jsh support is unclear):
// when required by install.js, argv[1] is install.js, so the regex stays false.
var _proc = require('process');
var _entry = (_proc.argv && _proc.argv[1]) ? String(_proc.argv[1]).replace(/\\/g, '/') : '';
var _isMain = (typeof require !== 'undefined' && require.main === module) || /\/cleanup\.js$/.test(_entry);
if (_isMain) {
  runCleanup(path.resolve(path.dirname(_proc.argv[1]), '..'));
}
