package wren.wrenvoice;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Glue between the WebSocket and the voice chat: no Minecraft / SVC types, so it is unit-testable. */
public final class VoiceBridge {
    /** Bot's mouth. Implementations encode to opus and send via the entity audio channel. */
    public interface Speaker {
        boolean available();
        void sendFrame(short[] pcm48k20ms);
        void flush();
        void setDistance(float d);
    }

    /** One opus decoder per speaking player. */
    public interface OpusIn {
        short[] decode(byte[] opus);
        void close();
    }

    public record Snapshot(Proximity.Pos bot, List<Proximity.Pos> players) {}

    private static final long END_SILENCE_MS = 400;

    private final Config cfg;
    private final MiniWsServer ws;
    private final Supplier<OpusIn> decoderFactory;
    private volatile Snapshot snap = new Snapshot(null, List.of());
    private volatile Speaker speaker;

    private final Object playLock = new Object();
    private final PlayoutQueue queue = new PlayoutQueue();
    private int emptyTicks = 0;
    private int tickNo = 0;
    private volatile long lastOfflineErrMs = 0;

    private static final class Talker {
        final String name;
        final OpusIn dec;
        final Resampler rs = new Resampler();
        long seq = 0;
        volatile long lastMs;
        Talker(String name, OpusIn dec) { this.name = name; this.dec = dec; this.lastMs = System.nanoTime() / 1_000_000; }
    }
    private final Map<UUID, Talker> talkers = new ConcurrentHashMap<>();
    private ScheduledExecutorService sched;

    public VoiceBridge(Config cfg, Supplier<OpusIn> decoderFactory) {
        this.cfg = cfg;
        this.decoderFactory = decoderFactory;
        this.ws = new MiniWsServer(cfg.bindAddress, cfg.wsPort, cfg.secret, new MiniWsServer.Listener() {
            public void onOpen() { ws().send(Protocol.hello(cfg.botName, snap.bot() != null, cfg.transcribeAll, cfg.hearRadius)); }
            public void onText(String t) { handleText(t); }
            public void onClose() { clientGone(); }
        });
    }

    private MiniWsServer ws() { return ws; }
    public MiniWsServer server() { return ws; }
    public void setSpeaker(Speaker s) { this.speaker = s; }
    public void setSnapshot(Snapshot s) { this.snap = s; }
    public Snapshot snapshot() { return snap; }

    public void start() throws IOException {
        ws.start();
        sched = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "wrenvoice-clock");
            t.setDaemon(true);
            return t;
        });
        sched.scheduleAtFixedRate(() -> {
            try { tick(); } catch (Throwable e) { /* keep the clock alive */ }
        }, 20, 20, TimeUnit.MILLISECONDS);
    }

    public void stop() {
        if (sched != null) sched.shutdownNow();
        ws.close();
        for (Talker t : talkers.values()) t.dec.close();
        talkers.clear();
    }

    // ---------------- hearing ----------------

    /** Called from the SVC mic event thread. Empty opus data = end of stream marker. */
    public void onMic(UUID sender, byte[] opus) {
        if (!ws.hasClient()) return;
        Snapshot s = snap;
        Proximity.Pos sp = null;
        for (Proximity.Pos p : s.players()) if (p.uuid().equals(sender)) { sp = p; break; }
        if (sp == null) return;
        if (opus == null || opus.length == 0) { endTalker(sender); return; }
        if (s.bot() != null && sp.uuid().equals(s.bot().uuid())) return;
        Double d = Proximity.distOrNull(s.bot(), sp);
        boolean inRange = Proximity.inRange(d, cfg.hearRadius);
        if (!inRange && !cfg.transcribeAll) return;
        Talker t = talkers.computeIfAbsent(sender, k -> new Talker(sp0name(s, k), decoderFactory.get()));
        short[] pcm48;
        synchronized (t) {
            pcm48 = t.dec.decode(opus);
            if (pcm48 == null || pcm48.length == 0) return;
            short[] pcm16 = t.rs.process(pcm48);
            t.lastMs = System.nanoTime() / 1_000_000;
            ws.send(Protocol.audioIn(sender.toString(), t.name, d, inRange, t.seq++, System.currentTimeMillis(), pcm16));
        }
    }

    private static String sp0name(Snapshot s, UUID u) {
        for (Proximity.Pos p : s.players()) if (p.uuid().equals(u)) return p.name();
        return u.toString();
    }

    private void endTalker(UUID id) {
        Talker t = talkers.remove(id);
        if (t == null) return;
        synchronized (t) { t.dec.close(); }
        ws.send(Protocol.audioEnd(id.toString(), t.name));
    }

    // ---------------- speaking ----------------

    private void handleText(String text) {
        Protocol.In in;
        try {
            in = Protocol.parse(text);
        } catch (IllegalArgumentException e) {
            ws.send(Protocol.error("bad message: " + e.getMessage()));
            return;
        }
        if (in instanceof Protocol.AudioOut a) {
            Speaker sp = speaker;
            if (sp == null || !sp.available()) {
                reportOffline(a.uttId());
                return;
            }
            int accepted;
            synchronized (playLock) { accepted = queue.add(a.uttId(), a.pcm48k()); }
            if (accepted == 0) {
                if (a.pcm48k().length == 0 || a.pcm48k().length % PlayoutQueue.FRAME != 0)
                    ws.send(Protocol.error("bad_chunk_size utt=" + a.uttId() + " (need a multiple of 960 samples)"));
                else
                    ws.send(Protocol.error("queue_overflow utt=" + a.uttId() + " seq=" + a.seq() + " dropped (>2s queued)"));
            }
        } else if (in instanceof Protocol.Flush f) {
            List<PlayoutQueue.Progress> ps;
            synchronized (playLock) { ps = queue.flush(f.uttId()); emptyTicks = 0; }
            Speaker sp = speaker;
            if (sp != null) sp.flush();
            for (PlayoutQueue.Progress p : ps) ws.send(Protocol.played(p.utt(), p.msPlayed(), false));
            if ("*".equals(f.uttId()) && ps.isEmpty()) ws.send(Protocol.played("*", 0, false));
        } else if (in instanceof Protocol.SpeakDistance sd) {
            cfg.speakDistance = sd.d();
            Speaker sp = speaker;
            if (sp != null) sp.setDistance((float) sd.d());
        }
    }

    private void reportOffline(String utt) {
        long now = System.currentTimeMillis();
        if (now - lastOfflineErrMs > 1000) {
            lastOfflineErrMs = now;
            ws.send(Protocol.error("bot_offline: audio for utt=" + utt + " dropped"));
        }
    }

    private void clientGone() {
        synchronized (playLock) { queue.flush("*"); }
        Speaker sp = speaker;
        if (sp != null) sp.flush();
        for (UUID id : new ArrayList<>(talkers.keySet())) {
            Talker t = talkers.remove(id);
            if (t != null) synchronized (t) { t.dec.close(); }
        }
    }

    // ---------------- clock ----------------

    /** Runs every 20 ms on the clock thread. Package-private for tests. */
    void tick() {
        tickNo++;
        Speaker sp = speaker;
        List<PlayoutQueue.Progress> done = null;
        PlayoutQueue.Frame frame = null;
        List<PlayoutQueue.Progress> prog = null;
        synchronized (playLock) {
            if (sp != null && sp.available()) frame = queue.poll();
            else if (queue.queuedFrames() > 0) {
                // bot went away mid-speech: drop everything, report as finished
                while (queue.pollDrop() != null) { }
                done = queue.progress(true);
            }
            if (frame != null) emptyTicks = 0;
            else if (queue.queuedFrames() == 0 && ++emptyTicks == 5) done = queue.progress(true);
            if (frame != null && tickNo % 12 == 0) prog = queue.progress(false);
        }
        if (frame != null) {
            try { sp.sendFrame(frame.pcm()); } catch (RuntimeException e) { ws.send(Protocol.error("send failed: " + e)); }
            // channel flush after the last frame of the queue is done by the speaker when it sees silence; see WrenVoicePlugin
        }
        if (done != null) {
            if (sp != null) sp.flush();
            for (PlayoutQueue.Progress p : done) ws.send(Protocol.played(p.utt(), p.msPlayed(), true));
        }
        if (prog != null) for (PlayoutQueue.Progress p : prog) ws.send(Protocol.played(p.utt(), p.msPlayed(), false));

        long now = System.nanoTime() / 1_000_000;
        for (Map.Entry<UUID, Talker> e : talkers.entrySet()) {
            if (now - e.getValue().lastMs >= END_SILENCE_MS) endTalker(e.getKey());
        }
        if (tickNo % 25 == 0 && ws.hasClient()) {
            Snapshot s = snap;
            ws.send(Protocol.players(System.currentTimeMillis(), s.bot(), Proximity.near(s.bot(), s.players(), cfg.hearRadius),
                    Proximity.all(s.bot(), s.players(), cfg.hearRadius)));
        }
    }
}
