package wren.wrenmap;

import com.google.gson.JsonObject;

/** Pure logic: Wren's state -> the small JSON the top-center web panel polls (assets/wrenmap/wren-status.json). */
public final class WrenStatus {
    private static final int GOAL_MAX = 160, THOUGHT_MAX = 400;

    private WrenStatus() {}

    /** Authoritative server-side vitals of Wren's player entity. {@code held} is "" when the hand is empty. */
    public record Vitals(double health, double maxHealth, int food, double saturation, String held, int heldCount) {}

    public static String json(String botName, Vec pos, String goal, String thought, String nearestName, double nearestDist,
                              long gameTime) {
        return json(botName, pos, goal, thought, nearestName, nearestDist, gameTime, null);
    }

    /** {@code pos}, {@code nearestName}, {@code vitals} may be null (Wren offline / nobody else online). */
    public static String json(String botName, Vec pos, String goal, String thought, String nearestName, double nearestDist,
                              long gameTime, Vitals vitals) {
        JsonObject o = new JsonObject();
        o.addProperty("name", botName);
        o.addProperty("online", pos != null);
        o.addProperty("goal", cut(goal, GOAL_MAX));
        o.addProperty("thought", cut(thought, THOUGHT_MAX));
        if (pos != null) {
            JsonObject p = new JsonObject();
            p.addProperty("x", Math.round(pos.x()));
            p.addProperty("y", Math.round(pos.y()));
            p.addProperty("z", Math.round(pos.z()));
            o.add("pos", p);
        }
        if (pos != null && nearestName != null && nearestDist >= 0) {
            JsonObject n = new JsonObject();
            n.addProperty("name", nearestName);
            n.addProperty("dist", Math.round(nearestDist));
            o.add("nearest", n);
        }
        if (pos != null && vitals != null) {
            JsonObject v = new JsonObject();
            v.addProperty("hp", Math.round(vitals.health() * 10) / 10.0);
            v.addProperty("maxHp", Math.round(vitals.maxHealth() * 10) / 10.0);
            v.addProperty("food", vitals.food());
            v.addProperty("sat", Math.round(vitals.saturation() * 10) / 10.0);
            v.addProperty("held", vitals.held() == null ? "" : vitals.held());
            v.addProperty("heldCount", vitals.heldCount());
            o.add("vitals", v);
        }
        o.addProperty("day", Math.floorDiv(gameTime, 24000L) + 1);
        o.addProperty("clock", clock(gameTime));
        return o.toString();
    }

    /** Minecraft tick 0 is 06:00. */
    public static String clock(long gameTime) {
        long t = Math.floorMod(gameTime, 24000L);
        long minutes = (t * 60 / 1000 + 6 * 60) % (24 * 60);
        return String.format("%02d:%02d", minutes / 60, minutes % 60);
    }

    static String cut(String s, int max) {
        if (s == null) return "";
        s = s.strip().replaceAll("\\s+", " ");
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
