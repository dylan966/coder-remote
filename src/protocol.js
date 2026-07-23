function buildPtyUrl({ coderHost, agentId, reconnect, width, height }) {
  return `wss://${coderHost}/api/v2/workspaceagents/${agentId}/pty` +
    `?reconnect=${reconnect}&width=${width}&height=${height}`;
}

function encodeMsg(obj) {
  return Buffer.from(JSON.stringify(obj));
}

module.exports = { buildPtyUrl, encodeMsg };
