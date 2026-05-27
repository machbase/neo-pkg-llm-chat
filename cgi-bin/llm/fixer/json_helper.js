function jsonMarshal(obj) {
  try { return JSON.stringify(obj); } catch (e) { return ''; }
}

function jsonUnmarshal(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

module.exports = { jsonMarshal, jsonUnmarshal };
