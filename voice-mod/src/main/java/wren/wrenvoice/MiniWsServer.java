package wren.wrenvoice;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Minimal RFC 6455 server (text frames only), bound to 127.0.0.1, at most one client.
 * No dependencies so the mod jar stays tiny. Sending is queued and done by a writer thread so a
 * slow client can never block the audio threads; when the queue is full, sends are dropped.
 */
public final class MiniWsServer implements AutoCloseable {
    public interface Listener {
        void onOpen();
        void onText(String text);
        void onClose();
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_MSG = 8 * 1024 * 1024;
    private static final int OUT_CAP = 1000;

    private final String bind;
    private final int port;
    private final String secret;
    private final Listener listener;
    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean closed;
    private final AtomicReference<Conn> current = new AtomicReference<>();

    public MiniWsServer(String bind, int port, String secret, Listener listener) {
        this.bind = bind == null ? "127.0.0.1" : bind;
        this.port = port;
        this.secret = secret == null ? "" : secret;
        this.listener = listener;
    }

    public void start() throws IOException {
        server = new ServerSocket(port, 4, InetAddress.getByName(bind));
        acceptThread = new Thread(this::acceptLoop, "wrenvoice-ws-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public int port() { return server.getLocalPort(); }
    public boolean hasClient() { Conn c = current.get(); return c != null && c.open; }

    /** Queue a text message; returns false if there is no client or the queue is full (message dropped). */
    public boolean send(String text) {
        Conn c = current.get();
        if (c == null || !c.open) return false;
        return c.out.offer(text);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket s = server.accept();
                Thread t = new Thread(() -> handle(s), "wrenvoice-ws-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (!closed) try { Thread.sleep(200); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private static final class Conn {
        final Socket sock;
        final LinkedBlockingQueue<String> out = new LinkedBlockingQueue<>(OUT_CAP);
        volatile boolean open = true;
        Conn(Socket s) { sock = s; }
    }

    private void handle(Socket s) {
        Conn conn = new Conn(s);
        boolean registered = false;
        try {
            s.setTcpNoDelay(true);
            s.setSoTimeout(10_000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream os = s.getOutputStream();
            Map<String, String> h = readHeaders(in);
            String key = h.get("sec-websocket-key");
            if (key == null || !"websocket".equalsIgnoreCase(h.getOrDefault("upgrade", ""))) {
                httpError(os, "400 Bad Request");
                return;
            }
            // Browsers always send Origin on WebSocket handshakes; the voice service (non-browser) sends none. Refusing any Origin
            // stops a web page from connecting to this loopback port (cross-site WebSocket hijacking).
            if (h.containsKey("origin")) {
                httpError(os, "403 Forbidden");
                return;
            }
            if (!secret.isEmpty()) {
                String got = h.getOrDefault("x-wren-secret", "");
                if (!MessageDigest.isEqual(got.getBytes(StandardCharsets.UTF_8), secret.getBytes(StandardCharsets.UTF_8))) {
                    httpError(os, "403 Forbidden");
                    return;
                }
            }
            if (!current.compareAndSet(null, conn)) {
                httpError(os, "409 Conflict");
                return;
            }
            registered = true;
            String accept = Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
            os.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            os.flush();
            s.setSoTimeout(0);

            Thread writer = new Thread(() -> writeLoop(conn, os), "wrenvoice-ws-writer");
            writer.setDaemon(true);
            writer.start();
            try { listener.onOpen(); } catch (RuntimeException e) { /* never kill the connection from a callback */ }
            readLoop(conn, new DataInputStream(in), os);
        } catch (Exception e) {
            // connection ended
        } finally {
            conn.open = false;
            try { s.close(); } catch (IOException ignored) {}
            if (registered) {
                current.compareAndSet(conn, null);
                try { listener.onClose(); } catch (RuntimeException ignored) {}
            }
        }
    }

    private static Map<String, String> readHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) throw new IOException("eof");
            buf.write(b);
            if (buf.size() > 16384) throw new IOException("headers too large");
            if ((b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3))) state++;
            else state = b == '\r' ? 1 : 0;
        }
        Map<String, String> m = new HashMap<>();
        String[] lines = buf.toString(StandardCharsets.ISO_8859_1).split("\r\n");
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) m.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
        }
        return m;
    }

    private static void httpError(OutputStream os, String status) throws IOException {
        os.write(("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        os.flush();
    }

    private void writeLoop(Conn c, OutputStream os) {
        try {
            while (c.open) {
                String m = c.out.poll(200, TimeUnit.MILLISECONDS);
                if (m == null) continue;
                writeFrame(os, 0x1, m.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            c.open = false;
            try { c.sock.close(); } catch (IOException ignored) {}
        }
    }

    private static void writeFrame(OutputStream os, int opcode, byte[] payload) throws IOException {
        synchronized (os) {
            ByteArrayOutputStream f = new ByteArrayOutputStream(payload.length + 10);
            f.write(0x80 | opcode);
            if (payload.length < 126) f.write(payload.length);
            else if (payload.length <= 0xFFFF) { f.write(126); f.write(payload.length >> 8); f.write(payload.length); }
            else {
                f.write(127);
                long l = payload.length;
                for (int i = 7; i >= 0; i--) f.write((int) (l >> (8 * i)));
            }
            f.write(payload);
            os.write(f.toByteArray());
            os.flush();
        }
    }

    private void readLoop(Conn c, DataInputStream in, OutputStream os) throws IOException {
        ByteArrayOutputStream msg = new ByteArrayOutputStream();
        boolean textMsg = false;
        while (c.open && !closed) {
            int b0 = in.readUnsignedByte();
            int b1 = in.readUnsignedByte();
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) len = in.readUnsignedShort();
            else if (len == 127) len = in.readLong();
            if (!masked || len < 0 || len > MAX_MSG) throw new IOException("bad frame");
            byte[] mask = new byte[4];
            in.readFully(mask);
            byte[] p = new byte[(int) len];
            in.readFully(p);
            for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
            switch (op) {
                case 0x8 -> { try { writeFrame(os, 0x8, p); } catch (IOException ignored) {} return; }
                case 0x9 -> writeFrame(os, 0xA, p);
                case 0xA -> { }
                case 0x1, 0x2, 0x0 -> {
                    if (op != 0x0) { msg.reset(); textMsg = op == 0x1; }
                    msg.write(p);
                    if (msg.size() > MAX_MSG) throw new IOException("message too large");
                    if (fin) {
                        if (textMsg) {
                            String t = msg.toString(StandardCharsets.UTF_8);
                            try { listener.onText(t); } catch (RuntimeException ignored) {}
                        }
                        msg.reset();
                    }
                }
                default -> throw new IOException("bad opcode");
            }
        }
    }

    @Override
    public void close() {
        closed = true;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        Conn c = current.get();
        if (c != null) { c.open = false; try { c.sock.close(); } catch (IOException ignored) {} }
    }
}
