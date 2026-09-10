// 저장 산출물(.tql·.dsh·리포트)을 계정별 상위 폴더 아래에 둔다.
//
// Neo 파일 저장소에는 계정 구분이 없어서, 두 사용자가 같은 테이블로 같은 이름의 차트를
// 만들면 서로의 파일을 덮어쓴다. 대시보드가 tql_path 로 그 파일을 참조하므로 덮어쓰기는
// 남의 차트 내용까지 바꾼다.
//
// 권한 격리는 아니다 — 다른 계정도 이 폴더를 읽고 쓸 수 있다. 충돌과 뒤섞임을 막는 정리 규칙이다.

// 파일명에 쓸 수 있는 문자로 좁힌다 — 계정명은 검증된 로그인 이름이지만 경로로 들어가므로.
function userRoot(mc) {
  var u = String((mc && mc.user) || 'sys').replace(/[^A-Za-z0-9_.-]/g, '_');
  return u || 'sys';
}

// 경로·파일명에 쓸 테이블 이름 — 소유자·database 접두를 뺀 마지막 조각만.
// 이름이 MACHBASEDB.SYS.BITCOIN 형태라 그대로 쓰면 폴더가 그 이름으로 생긴다.
function shortTableName(name) {
  var parts = String(name || '').split('.');
  return parts[parts.length - 1] || String(name || '');
}

// 폴더 조각에 섞여 들어온 접두를 걷어낸다(모델이 전체 이름을 폴더로 주는 경우).
// 마지막 조각(파일명)은 확장자가 붙어 있으므로 건드리지 않는다.
function normalizeDirSegments(p) {
  var parts = String(p || '').split('/');
  for (var i = 0; i < parts.length - 1; i++) parts[i] = shortTableName(parts[i]);
  return parts.join('/');
}

// 계정 폴더로 감싼 경로. 이미 감싸져 있으면 그대로 둔다(중복 방지).
function withUserRoot(mc, p) {
  var path = normalizeDirSegments(String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!path) return path;
  var root = userRoot(mc);
  if (path === root || path.indexOf(root + '/') === 0) return path;
  return root + '/' + path;
}

// Neo 파일 API 는 상위 폴더를 자동으로 만들지 않는다(없으면 mkdir 실패) — 단계별로 만든다.
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

// 경로의 폴더 부분을 만들어 두고 콜백. 폴더가 없는 경로면 바로 콜백.
function ensureParentOf(mc, filePath, cb) {
  var slash = String(filePath || '').lastIndexOf('/');
  if (slash <= 0) return cb();
  ensureFolders(mc, filePath.substring(0, slash), cb);
}

// 읽기는 계정 폴더를 먼저 보고, 없으면 원래 경로로 폴백한다 — 계정 폴더 도입 전에 저장된
// 파일이 계속 열려야 하기 때문이다.
// cb(err, data, actualPath): 되쓰기는 actualPath 로 해야 옛 파일이 제자리에 남는다.
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

// 삭제도 읽기와 같은 해석을 거친다 — 계정 폴더에 있으면 그것을, 없으면 옛 경로를 지운다.
// 해석 없이 지우면 계정 폴더 아래 파일을 못 찾아 '없다'고 하거나, 공용 루트의 동명 파일을 지운다.
function deleteUserFile(mc, p, cb) {
  readUserFile(mc, p, function (err, data, actualPath) {
    if (err) return mc.deleteFile(withUserRoot(mc, p), cb);   // 못 찾으면 계정 폴더 기준으로 시도
    mc.deleteFile(actualPath, cb);
  });
}

module.exports = { userRoot, withUserRoot, ensureFolders, ensureParentOf, readUserFile, deleteUserFile, shortTableName };
