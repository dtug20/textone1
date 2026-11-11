// Cleartext WS is allowed only for loopback or the dedicated LAN gateway (192.168.1.198:18802).
export function pipelineEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('Địa chỉ pipeline không được chứa mật khẩu hoặc fragment.');
  const allowedWs = url.protocol === 'ws:' && (
    url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || (url.hostname === '192.168.1.198' && url.port === '18802')
  );
  if (url.protocol !== 'wss:' && !allowedWs) {
    throw new Error('Dùng WSS, ws://192.168.1.198:18802 hoặc ws://localhost.');
  }
  return url;
}
export function pipelinePermission(value) {
  const url = pipelineEndpoint(value);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}/*`;
}
