'use strict';

// 업데이트 후 고아 파일 정리 — 수동 관리 목록 scripts/obsolete.json "remove" 기준
// · 레포에서 파일·폴더 삭제 시 패키지 루트 기준 경로를 목록에 추가, 누적 유지(삭제는 멱등 → 버전 건너뛴 업데이트도 정리)
// · install.js에서 호출(설치·업데이트), 단독 실행: machbase-neo jsh scripts/cleanup.js
// · 절대 경로·".." 탈출·루트 밖·보호 폴더 거부, 호출자에 예외 전파 없음

var path = require('path');
var fs = require('fs');

// 목록에 있어도 삭제 금지 — 런타임·사용자 데이터
var PROTECTED = [
  'scripts',
  'configs',
  'cgi-bin/llm/configs',
  'cgi-bin/llm/prefs',
  'cgi-bin/llm/workers',
  'cgi-bin/llm/logs',
  'logs',
];

function normalizeRel(p) {
  // 슬래시 통일·앞 "./"·뒤 슬래시 제거
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

// 단독 실행 판정 — jsh의 require.main 지원 불확실 → argv[1] 파일명도 확인(install.js에서 require 시 false)
var _proc = require('process');
var _entry = (_proc.argv && _proc.argv[1]) ? String(_proc.argv[1]).replace(/\\/g, '/') : '';
var _isMain = (typeof require !== 'undefined' && require.main === module) || /\/cleanup\.js$/.test(_entry);
if (_isMain) {
  runCleanup(path.resolve(path.dirname(_proc.argv[1]), '..'));
}
