var { argStr } = require('./registry');
var { withUserRoot, ensureFolders, deleteUserFile } = require('./paths');

function register(registry, mc) {
  registry.register({
    name: 'create_folder',
    description: 'Create a folder in Machbase Neo file system.',
    parameters: {
      type: 'object',
      properties: { folder_name: { type: 'string', description: 'Folder path to create (e.g., "GOLD")' } },
      required: ['folder_name'],
    },
    fn: function (args, cb) {
      var given = argStr(args, 'folder_name', '');
      if (!given) return cb(null, 'Error: folder_name is required');
      // 산출물과 같은 자리에 만든다({user}/ 아래). 파일 API 는 상위 폴더를 자동 생성하지
      // 않으므로 단계별로 만든다 — 이미 있으면 조용히 넘어간다.
      var folder = withUserRoot(mc, given);
      ensureFolders(mc, folder, function () {
        cb(null, 'Folder created: ' + folder);
      });
    },
  });

  registry.register({
    name: 'list_files',
    description: 'List files and folders in a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: "/")' } },
    },
    fn: function (args, cb) {
      var dirPath = argStr(args, 'path', '/');

      function emit(shown, items) {
        var out = '';
        for (var i = 0; i < items.length; i++) out += items[i].type + '  ' + items[i].name + '\n';
        cb(null, out.trim() || ('Empty directory: ' + shown));
      }

      // 산출물은 {user}/ 아래 있으므로 계정 폴더를 먼저 본다. 루트를 명시했거나 계정 폴더가
      // 비어 있으면 준 경로 그대로 — 공용·옛 경로도 계속 훑을 수 있게 남긴다.
      var scoped = (dirPath === '/' || dirPath === '') ? dirPath : withUserRoot(mc, dirPath);
      if (scoped === dirPath) {
        return mc.listDir(dirPath, function (err, items) {
          if (err) return cb(null, 'Error: ' + err.message);
          if (!items || items.length === 0) return cb(null, 'Empty directory: ' + dirPath);
          emit(dirPath, items);
        });
      }
      mc.listDir(scoped, function (e0, first) {
        if (!e0 && first && first.length > 0) return emit(scoped, first);
        mc.listDir(dirPath, function (err, items) {
          if (err) return cb(null, 'Error: ' + err.message);
          if (!items || items.length === 0) return cb(null, 'Empty directory: ' + dirPath);
          emit(dirPath, items);
        });
      });
    },
  });

  registry.register({
    name: 'delete_file',
    description: 'Delete a file or empty folder from Machbase Neo file system.',
    parameters: {
      type: 'object',
      properties: { filename: { type: 'string', description: 'File or folder path to delete' } },
      required: ['filename'],
    },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      // Block path traversal / absolute paths. Timer cleanup deletes
      // NAME/NAME.tql and the NAME folder — both are relative paths with no '..', so allowed.
      var norm = filename.replace(/\\/g, '/');
      if (norm.indexOf('..') >= 0 || norm.charAt(0) === '/' || /^[A-Za-z]:/.test(norm)) {
        return cb(null, '거부됨: 상위/절대 경로 파일은 삭제할 수 없습니다(보안 정책). 작업 산출물 경로만 허용됩니다.');
      }
      deleteUserFile(mc, filename, function (err) {
        if (err) return cb(null, 'Error: ' + err.message);
        cb(null, 'Deleted: ' + filename);
      });
    },
  });
}

module.exports = { register };
