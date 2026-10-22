// Minimal RFC 6455 WebSocket SERVER (text frames, ping/pong, close) so the fake mod needs no dependency.
import http from 'node:http'; import crypto from 'node:crypto';
export function wsServer({ port, host = '127.0.0.1', onConnection }) {
  const srv = http.createServer((q, r) => { r.writeHead(426); r.end(); });
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']; if (!key) return socket.destroy();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
    const conn = { handlers: { message: [], close: [] }, on(e, f) { this.handlers[e].push(f); },
      send(text) { const p = Buffer.from(text); let h; if (p.length < 126) h = Buffer.from([0x81, p.length]); else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); } if (!socket.destroyed) socket.write(Buffer.concat([h, p])); },
      close() { socket.end(Buffer.from([0x88, 0])); } };
    let buf = Buffer.alloc(0), frag = [];
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, o = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
        const mk = masked ? 4 : 0; if (buf.length < o + mk + len) return;
        const payload = Buffer.from(buf.subarray(o + mk, o + mk + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[o + i % 4];
        buf = buf.subarray(o + mk + len);
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (op === 1 || op === 0 || op === 2) { frag.push(payload); if (fin) { const t = Buffer.concat(frag).toString(); frag = []; conn.handlers.message.forEach((f) => f(t)); } }
      }
    });
    socket.on('close', () => conn.handlers.close.forEach((f) => f()));
    socket.on('error', () => {});
    onConnection(conn);
  });
  return new Promise((res) => srv.listen(port, host, () => res(srv)));
}
