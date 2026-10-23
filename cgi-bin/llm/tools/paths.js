// 저장 산출물(.tql·.dsh·리포트)의 계정별 상위 폴더 경로
// · Neo 파일 저장소엔 계정 구분 없음 → 같은 이름 파일 덮어쓰기 방지용
// · 권한 격리 아님(다른 계정도 읽기·쓰기 가능)

// 계정 폴더 이름 — 파일명 허용 문자로 제한(경로에 들어감)
function userRoot(mc) {
  var u = String((mc && mc.user) || 'sys').replace(/[^A-Za-z0-9_.-]/g, '_');
  return u || 'sys';
}

// 경로·파일명용 테이블 이름 — 소유자·database 접두 뺀 마지막 조각(MACHBASEDB.SYS.BITCOIN → BITCOIN)
function shortTableName(name) {
  var parts = String(name || '').split('.');
  return parts[parts.length - 1] || String(name || '');
}

// 폴더 조각의 테이블 접두 제거(모델이 전체 이름을 폴더로 주는 경우) — 마지막 조각(파일명)은 제외
function normalizeDirSegments(p) {
  var parts = String(p || '').split('/');
  for (var i = 0; i < parts.length - 1; i++) parts[i] = shortTableName(parts[i]);
  return parts.join('/');
}

// 계정 폴더로 감싼 경로 — 이미 감싸져 있으면 그대로(중복 방지)
function withUserRoot(mc, p) {
  var path = normalizeDirSegments(String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!path) return path;
  var root = userRoot(mc);
  if (path === root || path.indexOf(root + '/') === 0) return path;
  return root + '/' + path;
}

// 폴더 단계별 생성 — Neo 파일 API는 상위 폴더 자동 생성 안 함
function ensureFolders(mc, dirPath, cb) {
  var parts = String(dirPath || '').split('/');
  var wanted = [];
  for (var i = 0; i < parts.length; i++) if (parts[i]) wanted.push(parts[i]);
  var idx = 0, acc = '';
  function next() {
    if (idx >= wanted.length) return cb();
    acc = acc ? acc + '/' + wanted[idx] : wanted[idx];
    idx++;
    mc.createFolder(acc, function () { next(); });
  }
  next();
}

// 경로의 폴더 부분 생성 후 콜백(폴더 없는 경로면 바로 콜백)
function ensureParentOf(mc, filePath, cb) {
  var slash = String(filePath || '').lastIndexOf('/');
  if (slash <= 0) return cb();
  ensureFolders(mc, filePath.substring(0, slash), cb);
}

// 계정 폴더 먼저 읽고, 없으면 계정 폴더 없는 경로로 폴백 — 계정 폴더 밖 파일 열람용
// · cb(err, data, actualPath) — 되쓰기는 actualPath로(파일 제자리 유지)
function readUserFile(mc, p, cb) {
  var scoped = withUserRoot(mc, p);
  var raw = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  mc.readFile(scoped, function (err, data) {
    if (!err) return cb(null, data, scoped);
    if (raw === scoped) return cb(err);
    mc.readFile(raw, function (err2, data2) {
      if (err2) return cb(err);
      cb(null, data2, raw);
    });
  });
}

// 삭제도 readUserFile과 같은 경로 해석(계정 폴더 우선, 없으면 폴백 경로) — 공용 루트 동명 파일 오삭제 방지
function deleteUserFile(mc, p, cb) {
  readUserFile(mc, p, function (err, data, actualPath) {
    if (err) return mc.deleteFile(withUserRoot(mc, p), cb);   // 못 찾으면 계정 폴더 기준으로 시도
    mc.deleteFile(actualPath, cb);
  });
}

module.exports = { withUserRoot, ensureFolders, ensureParentOf, readUserFile, deleteUserFile, shortTableName };
