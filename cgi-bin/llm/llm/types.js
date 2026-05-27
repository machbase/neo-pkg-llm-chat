/**
 * Message represents a chat message shared across all LLM providers.
 * @typedef {Object} Message
 * @property {string} role - "system" | "user" | "assistant" | "tool"
 * @property {string} content - text content
 * @property {ToolCall[]} [toolCalls] - tool calls (assistant only)
 */

/**
 * ToolCall represents a function call requested by the LLM.
 * @typedef {Object} ToolCall
 * @property {ToolCallFunction} function
 */

/**
 * @typedef {Object} ToolCallFunction
 * @property {string} name
 * @property {Object} arguments
 */

/**
 * ChatResponse is the unified response type for all LLM providers.
 * @typedef {Object} ChatResponse
 * @property {string} model
 * @property {Message} message
 * @property {boolean} done
 */

function createMessage(role, content, toolCalls) {
  return {
    role: role,
    content: content || '',
    toolCalls: toolCalls || [],
  };
}

function createToolCall(name, args) {
  return {
    function: {
      name: name,
      arguments: args || {},
    },
  };
}

function createChatResponse(model, message, done) {
  return {
    model: model,
    message: message,
    done: done !== undefined ? done : true,
  };
}

module.exports = { createMessage, createToolCall, createChatResponse };
