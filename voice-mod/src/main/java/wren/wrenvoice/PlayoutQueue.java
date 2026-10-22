package wren.wrenvoice;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pacing queue for outgoing speech: 20 ms frames (960 samples @ 48 kHz), FIFO across utterances,
 * max 2 s queued. Not thread-safe by itself; callers synchronise (the bridge uses one lock).
 */
public final class PlayoutQueue {
    public static final int FRAME = 960;
    public static final int FRAME_MS = 20;
    public static final int MAX_FRAMES = 100; // 2 s

    public record Frame(String utt, short[] pcm) {}
    public record Progress(String utt, long msPlayed, boolean done) {}

    private final ArrayDeque<Frame> queue = new ArrayDeque<>();
    private final Map<String, Long> played = new LinkedHashMap<>(); // ms played per active utt
    private final Map<String, Integer> queued = new HashMap<>();   // frames queued per utt

    public int queuedFrames() { return queue.size(); }

    /** @return number of samples accepted: all of them, or 0 if rejected (not a multiple of 960, or over 2 s). */
    public int add(String utt, short[] pcm) {
        if (pcm.length == 0 || pcm.length % FRAME != 0) return 0;
        int frames = pcm.length / FRAME;
        if (queue.size() + frames > MAX_FRAMES) return 0;
        for (int f = 0; f < frames; f++) {
            short[] fr = new short[FRAME];
            System.arraycopy(pcm, f * FRAME, fr, 0, FRAME);
            queue.addLast(new Frame(utt, fr));
        }
        queued.merge(utt, frames, Integer::sum);
        played.putIfAbsent(utt, 0L);
        return pcm.length;
    }

    /** Next frame to play, or null. Advances ms_played of its utterance. */
    public Frame poll() {
        Frame f = queue.pollFirst();
        if (f == null) return null;
        queued.merge(f.utt(), -1, Integer::sum);
        played.merge(f.utt(), (long) FRAME_MS, Long::sum);
        return f;
    }

    /** Drop a frame without crediting it as played (bot offline). */
    public Frame pollDrop() {
        Frame f = queue.pollFirst();
        if (f == null) return null;
        queued.merge(f.utt(), -1, Integer::sum);
        return f;
    }

    /** Remove all queued audio of utt ("*" = everything). Returns progress (done=false) for each affected utterance. */
    public List<Progress> flush(String utt) {
        List<Progress> out = new ArrayList<>();
        boolean all = "*".equals(utt);
        for (Iterator<Frame> it = queue.iterator(); it.hasNext(); ) {
            Frame f = it.next();
            if (all || f.utt().equals(utt)) it.remove();
        }
        List<String> targets = new ArrayList<>();
        if (all) targets.addAll(played.keySet()); else targets.add(utt);
        for (String u : targets) {
            out.add(new Progress(u, played.getOrDefault(u, 0L), false));
            played.remove(u);
            queued.remove(u);
        }
        return out;
    }

    /** Utterances currently known (queued or still being tracked). */
    public List<Progress> progress(boolean finishDrained) {
        List<Progress> out = new ArrayList<>();
        for (Iterator<Map.Entry<String, Long>> it = played.entrySet().iterator(); it.hasNext(); ) {
            var e = it.next();
            boolean drained = queued.getOrDefault(e.getKey(), 0) <= 0;
            if (drained && finishDrained) {
                out.add(new Progress(e.getKey(), e.getValue(), true));
                queued.remove(e.getKey());
                it.remove();
            } else {
                out.add(new Progress(e.getKey(), e.getValue(), false));
            }
        }
        return out;
    }

    public boolean isUttDrained(String utt) { return queued.getOrDefault(utt, 0) <= 0; }
}
