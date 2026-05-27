var ws = require('ws');
var { createAgent } = require('../agent/agent');

var SESSION_TTL = 30 * 60 * 1000;

function runWSClient(neoURL, llmClient, registry) {
  console.println('[WSClient] Connecting to ' + neoURL);

  var sessions = {};
  var conn = new ws.WebSocket(neoURL);

  conn.on('open', function () {
    console.println('[WSClient] Connected to Neo');
  });

  conn.on('message', function (data) {
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    switch (msg.type) {
      case 'chat':
        handleChat(conn, msg.session_id, msg.query, llmClient, registry, sessions);
        break;
      case 'stop':
        console.println('[WSClient] Stop: ' + msg.session_id + ' (no-op in JSH)');
        break;
      default:
        console.println('[WSClient] Unknown: ' + msg.type);
    }
  });

  conn.on('close', function () {
    console.println('[WSClient] Disconnected from Neo');
  });

  conn.on('error', function (err) {
    console.println('[WSClient] Error: ' + err.message);
  });

  // Session reaper
  setInterval(function () {
    var now = Date.now();
    var keys = Object.keys(sessions);
    for (var i = 0; i < keys.length; i++) {
      if (now - sessions[keys[i]].lastUsed > SESSION_TTL) {
        delete sessions[keys[i]];
      }
    }
  }, 5 * 60 * 1000);
}

function handleChat(conn, sessionID, query, llmClient, registry, sessions) {
  var sess = sessions[sessionID];
  if (!sess) {
    sess = {
      agent: createAgent(llmClient, registry),
      lastUsed: Date.now(),
    };
    sessions[sessionID] = sess;
  }
  sess.lastUsed = Date.now();

  // Send status
  sendJSON(conn, { type: 'status', session_id: sessionID, content: '답변 생성중...' });

  // Run agent
  var result;
  try {
    result = sess.agent.run(query);
  } catch (e) {
    sendJSON(conn, { type: 'error', session_id: sessionID, content: e.message });
    return;
  }

  sendJSON(conn, { type: 'final', session_id: sessionID, content: result });
}

function sendJSON(conn, obj) {
  try { conn.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

module.exports = { runWSClient };
