package wren.wrenvoice;

import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

/** End-to-end over a real loopback WebSocket (JDK client) with fake opus + fake speaker. */
class BridgeWsTest {
    static class Rx implements WebSocket.Listener {
        final LinkedBlockingQueue<String> q = new LinkedBlockingQueue<>();
        final StringBuilder sb = new StringBuilder();
        public CompletionStage<?> onText(WebSocket ws, CharSequence d, boolean last) {
            sb.append(d);
            if (last) { q.add(sb.toString()); sb.setLength(0); }
            ws.request(1);
            return null;
        }
        public void onOpen(WebSocket ws) { ws.request(1); }
        String next(String type, long ms) throws Exception {
            long end = System.currentTimeMillis() + ms;
            while (System.currentTimeMillis() < end) {
                String s = q.poll(100, TimeUnit.MILLISECONDS);
                if (s != null && s.contains("\"type\":\"" + type + "\"")) return s;
            }
            return null;
        }
    }
    static class FakeSpeaker implements VoiceBridge.Speaker {
        volatile boolean avail = true;
        final AtomicInteger frames = new AtomicInteger(), flushes = new AtomicInteger();
        public boolean available() { return avail; }
        public void sendFrame(short[] p) { assertEquals(960, p.length); frames.incrementAndGet(); }
        public void flush() { flushes.incrementAndGet(); }
        public void setDistance(float d) {}
    }
    static Config cfg(String secret) {
        Config c = new Config(); c.wsPort = 0; c.secret = secret; return c;
    }
    static VoiceBridge bridge(Config c, FakeSpeaker sp) throws Exception {
        VoiceBridge b = new VoiceBridge(c, () -> new VoiceBridge.OpusIn() {
            public short[] decode(byte[] o) { return new short[960]; }
            public void close() {}
        });
        b.setSpeaker(sp);
        b.start();
        return b;
    }
    static WebSocket connect(VoiceBridge b, Rx rx, String secret) throws Exception {
        var bld = HttpClient.newHttpClient().newWebSocketBuilder();
        if (secret != null) bld.header("X-Wren-Secret", secret);
        return bld.buildAsync(URI.create("ws://127.0.0.1:" + b.server().port()), rx).get(5, TimeUnit.SECONDS);
    }

    @Test void helloPlayersAndAudioIn() throws Exception {
        Config c = cfg("");
        c.transcribeAll = false; // v1 behaviour
        // use a port we can discover: server binds 0 -> ServerSocket picks one; MiniWsServer.port() reports it
        VoiceBridge b = bridge(c, new FakeSpeaker());
        try {
            UUID botId = UUID.randomUUID(), pid = UUID.randomUUID(), far = UUID.randomUUID();
            var bot = new Proximity.Pos(botId, "Wren", 0, 64, 0, "o");
            var near = new Proximity.Pos(pid, "Sam", 3, 64, 4, "o");
            var farP = new Proximity.Pos(far, "Far", 100, 64, 0, "o");
            b.setSnapshot(new VoiceBridge.Snapshot(bot, List.of(bot, near, farP)));
            Rx rx = new Rx();
            WebSocket ws = connect(b, rx, null);
            assertNotNull(rx.next("hello", 2000));
            String pl = rx.next("players", 2000);
            assertNotNull(pl); assertTrue(pl.contains("Sam")); assertFalse(com.google.gson.JsonParser.parseString(pl).getAsJsonObject().getAsJsonArray("near").toString().contains("Far"));
            b.onMic(pid, new byte[]{1, 2, 3});
            b.onMic(far, new byte[]{1, 2, 3});
            b.onMic(botId, new byte[]{1, 2, 3});
            String a = rx.next("audio_in", 2000);
            assertNotNull(a); assertTrue(a.contains("Sam")); assertTrue(a.contains("\"seq\":0"));
            String end = rx.next("audio_end", 2000);   // 400 ms silence
            assertNotNull(end); assertTrue(end.contains("Sam"));
            assertNull(rx.next("audio_in", 300), "far player and bot must never be forwarded");
            ws.sendClose(1000, "").get(2, TimeUnit.SECONDS);
        } finally { b.stop(); }
    }

    @Test void transcribeAllForwardsFarPlayersWithInRangeFlag() throws Exception {
        Config c = cfg("");
        assertFalse(new Config().transcribeAll, "default is false: only players in range are transcribed");
        c.transcribeAll = true;
        VoiceBridge b = bridge(c, new FakeSpeaker());
        try {
            UUID botId = UUID.randomUUID(), near = UUID.randomUUID(), far = UUID.randomUUID(), other = UUID.randomUUID();
            var bot = new Proximity.Pos(botId, "Wren", 0, 64, 0, "o");
            var pn = new Proximity.Pos(near, "Near", 3, 64, 4, "o");
            var pf = new Proximity.Pos(far, "Far", 100, 64, 0, "o");
            var po = new Proximity.Pos(other, "Nether", 1, 64, 0, "n");
            b.setSnapshot(new VoiceBridge.Snapshot(bot, List.of(bot, pn, pf, po)));
            Rx rx = new Rx();
            connect(b, rx, null);
            String hello = rx.next("hello", 2000);
            assertTrue(hello.contains("\"version\":2")); assertTrue(hello.contains("\"transcribeAll\":true"));
            String pl = rx.next("players", 2000);
            var o = com.google.gson.JsonParser.parseString(pl).getAsJsonObject();
            assertEquals(1, o.getAsJsonArray("near").size());
            var all = o.getAsJsonArray("all");
            assertEquals(3, all.size());
            for (var el : all) {
                var e = el.getAsJsonObject();
                switch (e.get("name").getAsString()) {
                    case "Near" -> { assertTrue(e.get("in_range").getAsBoolean()); assertEquals(5.0, e.get("dist").getAsDouble(), 0.01); }
                    case "Far" -> { assertFalse(e.get("in_range").getAsBoolean()); assertEquals(100.0, e.get("dist").getAsDouble(), 0.01); }
                    case "Nether" -> { assertFalse(e.get("in_range").getAsBoolean()); assertTrue(e.get("dist").isJsonNull()); }
                    default -> fail();
                }
            }
            b.onMic(far, new byte[]{1});
            String a = rx.next("audio_in", 2000);
            assertNotNull(a); assertTrue(a.contains("Far")); assertTrue(a.contains("\"in_range\":false")); assertTrue(a.contains("\"dist\":100"));
            b.onMic(near, new byte[]{1});
            String a2 = rx.next("audio_in", 2000);
            assertNotNull(a2); assertTrue(a2.contains("Near")); assertTrue(a2.contains("\"in_range\":true"));
            b.onMic(other, new byte[]{1});
            String a3 = rx.next("audio_in", 2000);
            assertNotNull(a3); assertTrue(a3.contains("Nether")); assertTrue(a3.contains("\"dist\":null")); assertTrue(a3.contains("\"in_range\":false"));
            b.onMic(botId, new byte[]{1});
            assertNull(rx.next("audio_in", 300), "bot never forwarded");
            // bot offline: everyone still transcribed, dist null
            b.setSnapshot(new VoiceBridge.Snapshot(null, List.of(pn, pf)));
            b.onMic(near, new byte[]{1});
            String a4 = rx.next("audio_in", 2000);
            assertNotNull(a4); assertTrue(a4.contains("\"dist\":null")); assertTrue(a4.contains("\"in_range\":false"));
        } finally { b.stop(); }
    }

    @Test void noClientNoAudio() throws Exception {
        VoiceBridge b = bridge(cfg(""), new FakeSpeaker());
        try {
            UUID pid = UUID.randomUUID();
            var bot = new Proximity.Pos(UUID.randomUUID(), "Wren", 0, 0, 0, "o");
            var p = new Proximity.Pos(pid, "J", 1, 0, 0, "o");
            b.setSnapshot(new VoiceBridge.Snapshot(bot, List.of(bot, p)));
            b.onMic(pid, new byte[]{1}); // must not throw nor allocate a talker
            Rx rx = new Rx();
            connect(b, rx, null);
            rx.next("hello", 2000);
            assertNull(rx.next("audio_in", 300));
        } finally { b.stop(); }
    }

    @Test void secretAndSingleClient() throws Exception {
        VoiceBridge b = bridge(cfg("s3"), new FakeSpeaker());
        try {
            assertThrows(Exception.class, () -> connect(b, new Rx(), null));
            assertThrows(Exception.class, () -> connect(b, new Rx(), "wrong"));
            Rx rx = new Rx();
            WebSocket ok = connect(b, rx, "s3");
            assertNotNull(rx.next("hello", 2000));
            assertThrows(Exception.class, () -> connect(b, new Rx(), "s3"), "second client rejected");
            ok.sendClose(1000, "").get(2, TimeUnit.SECONDS);
        } finally { b.stop(); }
    }

    @Test void browserOriginIsRejected() throws Exception {
        VoiceBridge b = bridge(cfg(""), new FakeSpeaker());
        try {
            var bld = HttpClient.newHttpClient().newWebSocketBuilder().header("Origin", "https://evil.example");
            assertThrows(Exception.class, () -> bld.buildAsync(URI.create("ws://127.0.0.1:" + b.server().port()), new Rx()).get(5, TimeUnit.SECONDS));
            Rx rx = new Rx();
            connect(b, rx, null);   // no Origin header (the voice service) still works
            assertNotNull(rx.next("hello", 2000));
        } finally { b.stop(); }
    }

    @Test void configGeneratesSecretOnFirstStart() throws Exception {
        java.nio.file.Path f = java.nio.file.Files.createTempDirectory("wrencfg").resolve("wrenvoice.json");
        Config c = Config.loadOrCreate(f);
        assertEquals(48, c.secret.length());
        assertEquals(c.secret, Config.loadOrCreate(f).secret, "secret is stable across restarts");
        java.nio.file.Files.writeString(f, "{\"bindAddress\":\"0.0.0.0\"}");
        Config d = Config.loadOrCreate(f);
        assertEquals("0.0.0.0", d.bindAddress);
        assertEquals(48, d.secret.length(), "an existing config without a secret gets one");
    }

    @Test void speakPacingFlushAndOverflow() throws Exception {
        FakeSpeaker sp = new FakeSpeaker();
        VoiceBridge b = bridge(cfg(""), sp);
        try {
            Rx rx = new Rx();
            WebSocket ws = connect(b, rx, null);
            rx.next("hello", 2000);
            String pcm = Protocol.encodePcm(new short[960 * 25]); // 500 ms
            ws.sendText("{\"type\":\"audio_out\",\"utt_id\":\"u1\",\"seq\":0,\"pcm48k\":\"" + pcm + "\"}", true).get();
            Thread.sleep(250);
            int f = sp.frames.get();
            assertTrue(f >= 6 && f <= 18, "paced at ~20 ms, got " + f + " frames in 250 ms");
            ws.sendText("{\"type\":\"flush\",\"utt_id\":\"u1\"}", true).get();
            String pl = rx.next("played", 2000);
            while (pl != null && !pl.contains("\"done\":false")) pl = rx.next("played", 500);
            assertNotNull(pl); assertTrue(pl.contains("\"utt_id\":\"u1\""));
            int after = sp.frames.get();
            Thread.sleep(150);
            assertTrue(sp.frames.get() - after <= 1, "stopped within a frame after flush");
            // overflow: 2.1 s in one go
            String big = Protocol.encodePcm(new short[960 * 105]);
            ws.sendText("{\"type\":\"audio_out\",\"utt_id\":\"u2\",\"seq\":0,\"pcm48k\":\"" + big + "\"}", true).get();
            String err = rx.next("error", 2000);
            assertNotNull(err); assertTrue(err.contains("queue_overflow"));
            // done:true after a short utterance drains
            ws.sendText("{\"type\":\"audio_out\",\"utt_id\":\"u3\",\"seq\":0,\"pcm48k\":\"" + Protocol.encodePcm(new short[960 * 3]) + "\"}", true).get();
            String d;
            do { d = rx.next("played", 2000); } while (d != null && !d.contains("\"done\":true"));
            assertNotNull(d); assertTrue(d.contains("u3")); assertTrue(d.contains("\"ms_played\":60"));
            // bot offline: dropped + error
            sp.avail = false;
            ws.sendText("{\"type\":\"audio_out\",\"utt_id\":\"u4\",\"seq\":0,\"pcm48k\":\"" + Protocol.encodePcm(new short[960]) + "\"}", true).get();
            String off = rx.next("error", 2000);
            assertNotNull(off); assertTrue(off.contains("bot_offline"));
            ws.sendText("garbage", true).get();
            String bad = rx.next("error", 2000);
            assertNotNull(bad); assertTrue(bad.contains("bad message"));
        } finally { b.stop(); }
    }
}
