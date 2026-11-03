/**
 * 전 LLM 프로바이더 공통 채팅 메시지
 * @typedef {Object} Message
 * @property {string} role - "system" | "user" | "assistant" | "tool"
 * @property {string} content - 텍스트 내용
 * @property {ToolCall[]} [toolCalls] - 도구 호출(assistant 전용)
 */

/**
 * LLM이 요청한 함수 호출
 * @typedef {Object} ToolCall
 * @property {ToolCallFunction} function
 */

/**
 * @typedef {Object} ToolCallFunction
 * @property {string} name
 * @property {Object} arguments
 */

/**
 * 전 LLM 프로바이더 공통 응답 형식
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
