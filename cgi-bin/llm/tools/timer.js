var { argStr, argBool } = require('./registry');

function register(registry, mc) {
  registry.register({
    name: 'list_timers',
    description: 'List all timers (schedulers) registered in Machbase Neo.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      mc.webGet('/web/api/timers', function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var resp = JSON.parse(data);
          if (!resp.success) return cb(null, 'Error: ' + resp.reason);
          if (!resp.data || resp.data.length === 0) return cb(null, 'No timers registered.');
          cb(null, JSON.stringify(resp.data, null, 2));
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'add_timer',
    description: 'Create a new timer (scheduler) in Machbase Neo that runs a TQL script on a schedule.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Timer name (unique identifier)' },
        schedule: { type: 'string', description: 'Execution schedule. Examples: "@every 10s", "0 30 * * * *", "@daily"' },
        path: { type: 'string', description: 'TQL script path to execute' },
        auto_start: { type: 'boolean', description: 'Auto-start on server restart (default: false)', default: false },
      },
      required: ['name', 'schedule', 'path'],
    },
    fn: function (args, cb) {
      var name = argStr(args, 'name', '');
      var schedule = argStr(args, 'schedule', '');
      var tqlPath = argStr(args, 'path', '');
      var autoStart = argBool(args, 'auto_start', false);
      if (!name || !schedule || !tqlPath) return cb(null, 'Error: name, schedule, and path are required');

      mc.webPost('/web/api/timers', { name: name, schedule: schedule, path: tqlPath, autoStart: autoStart }, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var resp = JSON.parse(data);
          if (!resp.success) return cb(null, 'Error: ' + resp.reason);
          cb(null, 'Timer \'' + name + '\' created. (schedule: ' + schedule + ', path: ' + tqlPath + ')\nNOTE: Call start_timer with name=\'' + name + '\' to begin execution.');
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'start_timer',
    description: 'Start (run) an existing timer in Machbase Neo.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Timer name to start' } },
      required: ['name'],
    },
    fn: function (args, cb) {
      var name = argStr(args, 'name', '').toUpperCase();
      if (!name) return cb(null, 'Error: name is required');
      mc.webPost('/web/api/timers/' + name + '/state', { state: 'start' }, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var resp = JSON.parse(data);
          if (!resp.success) return cb(null, 'Error: ' + resp.reason);
          cb(null, 'Timer \'' + name + '\' started.');
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'stop_timer',
    description: 'Stop a running timer in Machbase Neo.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Timer name to stop' } },
      required: ['name'],
    },
    fn: function (args, cb) {
      var name = argStr(args, 'name', '').toUpperCase();
      if (!name) return cb(null, 'Error: name is required');
      mc.webPost('/web/api/timers/' + name + '/state', { state: 'stop' }, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var resp = JSON.parse(data);
          if (!resp.success) return cb(null, 'Error: ' + resp.reason);
          cb(null, 'Timer \'' + name + '\' stopped.');
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'delete_timer',
    description: 'Delete a timer from Machbase Neo. The timer will be auto-stopped if running.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Timer name to delete' } },
      required: ['name'],
    },
    fn: function (args, cb) {
      var name = argStr(args, 'name', '').toUpperCase();
      if (!name) return cb(null, 'Error: name is required');
      // Auto-stop then delete
      mc.webPost('/web/api/timers/' + name + '/state', { state: 'stop' }, function () {
        mc.webDelete('/web/api/timers/' + name, function (err, data) {
          if (err) return cb(null, 'Error: ' + err.message);
          try {
            var resp = JSON.parse(data);
            if (!resp.success) return cb(null, 'Error: ' + resp.reason);
            cb(null, 'Timer \'' + name + '\' deleted.');
          } catch (e) { cb(null, 'Error: ' + e.message); }
        });
      });
    },
  });
}

module.exports = { register };
