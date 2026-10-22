package wren.wrenvoice;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/** Pure proximity logic. Positions in blocks; dimension must match. */
public final class Proximity {
    public record Pos(UUID uuid, String name, double x, double y, double z, String dim) {}
    public record Near(Pos p, double dist) {}

    private Proximity() {}

    public static double dist(Pos a, Pos b) {
        double dx = a.x() - b.x(), dy = a.y() - b.y(), dz = a.z() - b.z();
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** Real players within radius of the bot (bot itself excluded, other dimensions excluded), nearest first. */
    public static List<Near> near(Pos bot, List<Pos> players, double radius) {
        List<Near> out = new ArrayList<>();
        if (bot == null) return out;
        for (Pos p : players) {
            if (p.uuid().equals(bot.uuid())) continue;
            if (!p.dim().equals(bot.dim())) continue;
            double d = dist(bot, p);
            if (d <= radius) out.add(new Near(p, d));
        }
        out.sort(Comparator.comparingDouble(Near::dist));
        return out;
    }

    /** 3D distance bot -> p, or null if the bot is offline or in another dimension. */
    public static Double distOrNull(Pos bot, Pos p) {
        if (bot == null || p == null || !p.dim().equals(bot.dim())) return null;
        return dist(bot, p);
    }

    public static boolean inRange(Double d, double radius) { return d != null && d <= radius; }

    /** Everyone except the bot (nearest first, unknown distance last). dist may be null. */
    public record Entry(Pos p, Double dist, boolean inRange) {}
    public static List<Entry> all(Pos bot, List<Pos> players, double radius) {
        List<Entry> out = new ArrayList<>();
        for (Pos p : players) {
            if (bot != null && p.uuid().equals(bot.uuid())) continue;
            Double d = distOrNull(bot, p);
            out.add(new Entry(p, d, inRange(d, radius)));
        }
        out.sort(Comparator.comparingDouble(e -> e.dist() == null ? Double.MAX_VALUE : e.dist()));
        return out;
    }

    /** Distance if the speaker counts as heard, else -1. */
    public static double heardDistance(Pos bot, Pos speaker, double radius) {
        if (bot == null || speaker == null) return -1;
        if (speaker.uuid().equals(bot.uuid()) || !speaker.dim().equals(bot.dim())) return -1;
        double d = dist(bot, speaker);
        return d <= radius ? d : -1;
    }
}
