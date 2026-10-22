package wren.wrenmap;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;

/** Parsed config/wrenmap/wren.json. Tolerant: unknown or malformed parts are skipped. */
public record WrenData(List<Vec> trail, Vec home, List<Death> deaths, String goal, String thought, List<Place> places) {
    public record Death(Vec pos, String cause, String t) {}
    public record Place(String name, Vec pos) {}

    public static final int MAX_DEATHS = 50, MAX_PLACES = 100;

    /** Throws on invalid JSON (the caller keeps its previous data). */
    public static WrenData parse(String json, int trailMax) {
        JsonObject o = JsonParser.parseString(json).getAsJsonObject();
        List<Vec> trail = new ArrayList<>();
        if (o.get("trail") instanceof JsonArray a) {
            for (JsonElement e : a) {
                Vec v = vec(e);
                if (v != null) trail.add(v);
            }
        }
        if (trail.size() > trailMax) trail = new ArrayList<>(trail.subList(trail.size() - trailMax, trail.size()));
        Vec home = vec(o.get("home"));
        List<Death> deaths = new ArrayList<>();
        if (o.get("deaths") instanceof JsonArray a) {
            for (JsonElement e : a) {
                if (!(e instanceof JsonObject d)) continue;
                Vec v = vec(d.get("pos"));
                if (v == null) continue;
                deaths.add(new Death(v, str(d.get("cause")), str(d.get("t"))));
            }
        }
        if (deaths.size() > MAX_DEATHS) deaths = new ArrayList<>(deaths.subList(deaths.size() - MAX_DEATHS, deaths.size()));
        List<Place> places = new ArrayList<>();
        if (o.get("places") instanceof JsonArray a) {
            for (JsonElement e : a) {
                if (!(e instanceof JsonObject p)) continue;
                Vec v = vec(p.get("pos"));
                String n = str(p.get("name"));
                if (v == null || n.isBlank()) continue;
                places.add(new Place(n, v));
            }
        }
        if (places.size() > MAX_PLACES) places = new ArrayList<>(places.subList(0, MAX_PLACES));
        return new WrenData(trail, home, deaths, str(o.get("goal")), str(o.get("thought")), places);
    }

    private static String str(JsonElement e) {
        return e == null || e.isJsonNull() || !e.isJsonPrimitive() ? "" : e.getAsString();
    }

    private static Vec vec(JsonElement e) {
        if (e == null || !e.isJsonArray()) return null;
        JsonArray a = e.getAsJsonArray();
        if (a.size() < 3) return null;
        try {
            double x = a.get(0).getAsDouble(), y = a.get(1).getAsDouble(), z = a.get(2).getAsDouble();
            if (Double.isNaN(x) || Double.isNaN(y) || Double.isNaN(z) || Double.isInfinite(x + y + z)) return null;
            return Vec.of(x, y, z);
        } catch (RuntimeException ex) {
            return null;
        }
    }
}
