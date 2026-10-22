package wren.wrenmap;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Pure logic: dedupe across players, cap by proximity, and turn mobs into marker specs. */
public final class MobPlanner {
    public static final String SET_HOSTILE = "wrenmap-hostile";
    public static final String SET_ANIMALS = "wrenmap-animals";

    public record Plan(Map<String, MarkerSpec> hostile, Map<String, MarkerSpec> animals) {}

    private MobPlanner() {}

    public static Plan plan(List<MobSnapshot> seen, List<Vec> players, int max) {
        Map<UUID, MobSnapshot> byId = new LinkedHashMap<>();
        for (MobSnapshot m : seen) byId.putIfAbsent(m.id(), m);
        List<MobSnapshot> all = new ArrayList<>(byId.values());
        if (all.size() > max) {
            all.sort(Comparator.comparingDouble(m -> nearest2(m.pos(), players)));
            all = all.subList(0, max);
        }
        Map<String, MarkerSpec> hostile = new LinkedHashMap<>();
        Map<String, MarkerSpec> animals = new LinkedHashMap<>();
        for (MobSnapshot m : all) {
            MarkerSpec spec = MarkerSpec.poi(IconCatalog.url(IconCatalog.icon(m.type(), m.hostile())), label(m), m.pos());
            (m.hostile() ? hostile : animals).put("m-" + m.id(), spec);
        }
        return new Plan(hostile, animals);
    }

    private static double nearest2(Vec p, List<Vec> players) {
        double best = Double.MAX_VALUE;
        for (Vec v : players) best = Math.min(best, p.dist2(v));
        return best;
    }

    /** "zombie_villager" -> "Zombie Villager"; a custom name is appended in quotes. */
    public static String label(MobSnapshot m) {
        String base = pretty(m.type());
        return m.name() == null || m.name().isBlank() ? base : base + " \"" + m.name() + "\"";
    }

    public static String pretty(String id) {
        StringBuilder sb = new StringBuilder();
        for (String part : id.split("_")) {
            if (part.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
        }
        return sb.toString();
    }
}
