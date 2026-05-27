// Guard pipeline - runs checks before tool execution and after loop completion

function createPipeline(preToolGuards, postLoopGuards) {
  return {
    preTool: preToolGuards || [],
    postLoop: postLoopGuards || [],

    runPreTool: function (agent, msg) {
      for (var i = 0; i < this.preTool.length; i++) {
        msg = this.preTool[i].check(agent, msg);
      }
      return msg;
    },

    runPostLoop: function (agent, msg) {
      for (var i = 0; i < this.postLoop.length; i++) {
        msg = this.postLoop[i].check(agent, msg);
      }
      return msg;
    },
  };
}

// Re-prompt helper: appends msg + cancel results + hint, calls LLM again
function rePrompt(agent, msg, hint) {
  var msgs = agent.messages.slice();
  msgs.push(msg);
  for (var i = 0; i < (msg.toolCalls ? msg.toolCalls.length : 0); i++) {
    msgs.push({ role: 'tool', content: 'cancelled: redirecting', toolCalls: [] });
  }
  msgs.push({ role: 'user', content: hint, toolCalls: [] });

  // Update agent messages too
  agent.messages.push(msg);
  for (var j = 0; j < (msg.toolCalls ? msg.toolCalls.length : 0); j++) {
    agent.messages.push({ role: 'tool', content: 'cancelled: redirecting', toolCalls: [] });
  }
  agent.messages.push({ role: 'user', content: hint, toolCalls: [] });

  try {
    var resp = agent.llm.chatSync(msgs, agent.toolDefs);
    return resp.message;
  } catch (e) {
    console.println('  [guard] rePrompt failed: ' + (e.message || String(e)));
    return msg;
  }
}

// Re-prompt for post-loop (msg has no tool calls)
function rePromptNoToolCalls(agent, msg, hint) {
  agent.messages.push(msg);
  agent.messages.push({ role: 'user', content: hint, toolCalls: [] });

  try {
    var resp = agent.llm.chatSync(agent.messages, agent.toolDefs);
    return resp.message;
  } catch (e) {
    console.println('  [guard] rePromptNoToolCalls failed: ' + (e.message || String(e)));
    return msg;
  }
}

module.exports = { createPipeline, rePrompt, rePromptNoToolCalls };
