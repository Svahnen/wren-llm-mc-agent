package wren.wrenmap;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Diffs the desired marker state against what was already applied and pushes only the changes. */
public final class MarkerSync {
    private MarkerSync() {}

    /** Mutates {@code applied} to equal {@code desired}. Returns {added, updated, removed}. */
    public static int[] sync(String setId, Map<String, MarkerSpec> applied, Map<String, MarkerSpec> desired, MarkerSink sink) {
        int add = 0, upd = 0, rem = 0;
        for (String id : new ArrayList<>(applied.keySet())) {
            if (!desired.containsKey(id)) {
                sink.remove(setId, id);
                applied.remove(id);
                rem++;
            }
        }
        for (Map.Entry<String, MarkerSpec> e : desired.entrySet()) {
            MarkerSpec old = applied.get(e.getKey());
            if (old == null) add++;
            else if (!old.equals(e.getValue())) upd++;
            else continue;
            sink.put(setId, e.getKey(), e.getValue());
            applied.put(e.getKey(), e.getValue());
        }
        return new int[] {add, upd, rem};
    }

    /** Remove every marker in {@code applied} (used before dropping state). */
    public static void clear(String setId, Map<String, MarkerSpec> applied, MarkerSink sink) {
        List<String> ids = new ArrayList<>(applied.keySet());
        for (String id : ids) sink.remove(setId, id);
        applied.clear();
    }
}
