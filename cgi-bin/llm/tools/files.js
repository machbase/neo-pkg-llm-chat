var { argStr } = require('./registry');

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
      var folder = argStr(args, 'folder_name', '');
      if (!folder) return cb(null, 'Error: folder_name is required');
      mc.createFolder(folder, function (err) {
        if (err) {
          var msg = err.message || '';
          if (/already exists|Cannot create/i.test(msg)) return cb(null, 'Folder already exists: ' + folder);
          return cb(null, 'Error: ' + msg);
        }
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
      mc.listDir(dirPath, function (err, items) {
        if (err) return cb(null, 'Error: ' + err.message);
        if (!items || items.length === 0) return cb(null, 'Empty directory: ' + dirPath);
        var out = '';
        for (var i = 0; i < items.length; i++) out += items[i].type + '  ' + items[i].name + '\n';
        cb(null, out.trim());
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
      mc.deleteFile(filename, function (err) {
        if (err) return cb(null, 'Error: ' + err.message);
        cb(null, 'Deleted: ' + filename);
      });
    },
  });
}

module.exports = { register };
