var fs = require('fs');
var pathMod = require('path');
var { createAgent } = require('../agent/agent');
var { createLLM } = require('../llm/factory');
var config = require('../config/config');

var SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function createWSServer(mc, registry, cfg) {
  var sessions = {};

  // Resolve the per-user config file: configs/{userID}.json under the same dir as
  // the boot-time cfg. Falls back to the boot cfg path (sys.json) if the per-user
  // file doesn't exist. We re-read from disk every call so newly saved settings
  // show up without a service restart.
  function freshCfg(userID) {
    if (!cfg || !cfg._path) return cfg;
    // jsh's fs.existsSync against relative paths in the virtual filesystem returns
    // false even when the file exists, so always resolve to an absolute path first.
    var absSysPath = pathMod.resolve(cfg._path);
    var configsDir = pathMod.dirname(absSysPath);
    var name = (userID || cfg.machbase.user || 'sys') + '.json';
    var userPath = pathMod.join(configsDir, name);
    var exists;
    try { exists = fs.existsSync(userPath); } catch (e) { exists = false; }
    if (exists) {
      try {
        return config.loadConfig(userPath);
      } catch (e) {
        console.println('[WSServer] per-user cfg reload failed (' + userPath + '): ' + e.message);
      }
    }
    try {
      return config.loadConfig(absSysPath);
    } catch (e) {
      console.println('[WSServer] cfg reload failed: ' + e.message);
      return cfg;
    }
  }

  function handleMessage(conn, raw, authUserID) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // Identity resolution: prefer the authUserID captured in server.js's WS
    // connection closure (from the URL path). jsh's @jsh/http WS request.url
    // appears to come through empty in this build, so URL extraction is best-
    // effort. We fall back to msg.user_id (which the client sends today) so
    // per-user routing works in practice. Trade-off: msg.user_id is spoofable
    // by a malicious client editing the body — acceptable under the localhost-
    // trust assumption documented in MEMORY.
    var userID = authUserID || (msg && msg.user_id) || cfg.machbase.user || 'sys';

    switch (msg.type) {
      case 'chat':
        handleChat(conn, userID, msg.session_id, msg.provider, msg.model, msg.query);
        break;
      case 'stop':
        handleStop(conn, msg.session_id, userID);
        break;
      case 'clear':
        handleClear(conn, msg.session_id, userID);
        break;
      case 'get_models':
        handleGetModels(conn, userID);
        break;
      default:
        console.println('[WSServer] Unknown type: ' + msg.type);
    }
  }

  function handleChat(conn, userID, sessionID, provider, model, query) {
    if (!provider || !model) {
      sendJSON(conn, { type: 'error', session_id: sessionID, msg: 'provider와 model은 필수입니다.' });
      return;
    }

    var sess = sessions[sessionID];

    // Check model change
    if (sess && (sess.provider !== provider || sess.model !== model)) {
      console.println('[WSServer] Model changed: ' + sess.provider + '/' + sess.model + ' → ' + provider + '/' + model);
      delete sessions[sessionID];
      sess = null;
    }

    if (!sess) {
      // Create new session — load per-user cfg so each user's api_keys and models
      // are isolated; newly saved settings take effect without service restart.
      var cfgCopy = JSON.parse(JSON.stringify(freshCfg(userID)));
      cfgCopy.provider = provider;
      cfgCopy.model = model;
      var llmClient;
      try {
        llmClient = createLLM(cfgCopy);
      } catch (e) {
        sendJSON(conn, { type: 'error', session_id: sessionID, msg: 'LLM 초기화 실패: ' + e.message });
        return;
      }
      sess = {
        agent: createAgent(llmClient, registry),
        lastUsed: Date.now(),
        userID: userID,
        provider: provider,
        model: model,
        conn: conn,
      };
      sessions[sessionID] = sess;
      console.println('[WSServer] New session: ' + sessionID + ' (' + provider + '/' + model + ')');
    } else {
      sess.lastUsed = Date.now();
      sess.conn = conn;
      console.println('[WSServer] Continuing session: ' + sessionID);
    }

    // Helper: check if this session was cleared while the agent was running
    function isCleared() {
      return sess.agent.cancelled || !sessions[sessionID];
    }

    // Send answer_start
    sendStreamMsg(conn, 'answer_start');

    // Wire up progress reporting → send tool steps as block messages
    // If send fails (connection closed), cancel the agent
    sess.agent.onProgress = function (text) {
      if (isCleared()) return;
      if (!trySend(conn, sess.agent, 'stream_block_start')) return;
      if (!trySend(conn, sess.agent, 'stream_block_delta', text)) return;
      trySend(conn, sess.agent, 'stream_block_stop');
    };

    // Run agent (req.do() is blocking-sync, so callback chain runs inline)
    sess.agent.cancelled = false;
    sess.agent.run(query, function (err, result) {
      if (isCleared()) {
        console.println('[WSServer] Agent was cancelled, skipping response');
        sendStreamMsg(conn, 'answer_stop');
        return;
      }
      if (err) {
        sendStreamMsg(conn, 'answer_stop');
        sendJSON(conn, { type: 'error', session_id: sessionID, msg: 'Agent 오류: ' + err.message });
        return;
      }

      // Send result as streaming protocol
      sendStreamMsg(conn, 'stream_msg_start');
      sendStreamMsg(conn, 'stream_msg_delta', result || '');
      sendStreamMsg(conn, 'stream_msg_stop');
      sendStreamMsg(conn, 'answer_stop');
    });
  }

  function handleStop(conn, sessionID, userID) {
    var sess = sessions[sessionID];
    if (sess && sess.agent) {
      sess.agent.cancelled = true;
      console.println('[WSServer] Stop requested: ' + sessionID + ' — agent.cancelled=true');
    } else {
      console.println('[WSServer] Stop requested: ' + sessionID + ' — no active session');
    }
    sendJSON(conn, { type: 'stop', session_id: sessionID, msg: 'stopped' });
  }

  function handleClear(conn, sessionID, userID) {
    var sess = sessions[sessionID];
    if (sess && sess.agent) {
      sess.agent.cancelled = true;
      console.println('[WSServer] Stop before clear: ' + sessionID);
    }
    if (sess) {
      delete sessions[sessionID];
      console.println('[WSServer] Session cleared: ' + sessionID);
    }
    sendJSON(conn, { type: 'clear', session_id: sessionID });
  }

  function handleGetModels(conn, userID) {
    var c = freshCfg(userID);
    // A model entry is "real" only if its name is non-empty — defaultConfig() seeds
    // placeholder entries with empty names so the settings form can render an editable
    // row, but those should not appear in the chat model dropdown.
    function namedModels(models) {
      var out = [];
      for (var i = 0; i < models.length; i++) {
        var name = (models[i].name || '').trim();
        if (!name) continue;
        out.push({ name: name, model_id: models[i].model_id || name });
      }
      return out;
    }

    var providers = [];
    var claudeModels = namedModels(c.claude.models);
    if (c.claude.api_key && claudeModels.length > 0) {
      providers.push({ provider: 'claude', models: claudeModels });
    }
    var chatgptModels = namedModels(c.chatgpt.models);
    if (c.chatgpt.api_key && chatgptModels.length > 0) {
      providers.push({ provider: 'chatgpt', models: chatgptModels });
    }
    var geminiModels = namedModels(c.gemini.models);
    if (c.gemini.api_key && geminiModels.length > 0) {
      providers.push({ provider: 'gemini', models: geminiModels });
    }
    // Ollama: no api_key required (server falls back to localhost:11434 if base_url is empty)
    var ollamaModels = namedModels(c.ollama.models);
    if (ollamaModels.length > 0) {
      providers.push({ provider: 'ollama', models: ollamaModels });
    }
    if (providers.length === 0) {
      sendJSON(conn, { type: 'models', msg: 'No providers configured. Please set API keys in Settings.' });
    } else {
      sendJSON(conn, { type: 'models', providers: providers });
    }
  }

  // Try to send a stream message; returns false and cancels agent on failure
  function trySend(conn, agent, msgType, text) {
    try {
      sendStreamMsg(conn, msgType, text);
      return true;
    } catch (e) {
      console.println('[WSServer] Send failed (connection closed?): ' + e.message);
      agent.cancelled = true;
      return false;
    }
  }

  function sendStreamMsg(conn, msgType, text) {
    var message = {
      ver: '1.0',
      id: Date.now(),
      type: msgType,
    };
    if (text !== undefined) {
      message.body = {
        ofStreamBlockDelta: {
          contentType: 'text/markdown',
          text: text,
        },
      };
    }
    sendJSON(conn, { type: 'msg', message: message });
  }

  function sendJSON(conn, obj) {
    try {
      conn.send(JSON.stringify(obj));
    } catch (e) {
      console.println('[WSServer] Send error: ' + e.message);
    }
  }

  // Session reaper (call periodically via setInterval)
  function reapSessions() {
    var now = Date.now();
    var keys = Object.keys(sessions);
    for (var i = 0; i < keys.length; i++) {
      if (now - sessions[keys[i]].lastUsed > SESSION_TTL) {
        console.println('[WSServer] Session expired: ' + keys[i]);
        delete sessions[keys[i]];
      }
    }
  }

  // Clean up all sessions bound to a disconnected connection
  function cleanupConnection(conn) {
    var keys = Object.keys(sessions);
    for (var i = 0; i < keys.length; i++) {
      var sess = sessions[keys[i]];
      if (sess.conn === conn) {
        if (sess.agent) sess.agent.cancelled = true;
        delete sessions[keys[i]];
        console.println('[WSServer] Session cleaned up on disconnect: ' + keys[i]);
      }
    }
  }

  return {
    handleMessage: handleMessage,
    reapSessions: reapSessions,
    cleanupConnection: cleanupConnection,
    sessions: sessions,
  };
}

module.exports = { createWSServer };
