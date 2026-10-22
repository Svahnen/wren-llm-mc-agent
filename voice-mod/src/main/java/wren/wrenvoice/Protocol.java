package wren.wrenvoice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

/** JSON text protocol v2 (see README). Pure: no Minecraft imports. */
public final class Protocol {
    public static final int VERSION = 2;
    private Protocol() {}

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }

    public static String hello(String bot, boolean online) { return hello(bot, online, true, 16.0); }

    /** v2 adds transcribeAll + hearRadius (extra fields; v1 clients ignore them). */
    public static String hello(String bot, boolean online, boolean transcribeAll, double hearRadius) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "hello");
        o.addProperty("version", VERSION);
        o.addProperty("bot", bot);
        o.addProperty("botOnline", online);
        o.addProperty("transcribeAll", transcribeAll);
        o.addProperty("hearRadius", hearRadius);
        return o.toString();
    }

    public static String players(long t, Proximity.Pos bot, List<Proximity.Near> near) {
        return players(t, bot, near, null);
    }

    /** v2: `near` (in range, as v1) plus `all` = every online real player with dist (null if unknown) and in_range. */
    public static String players(long t, Proximity.Pos bot, List<Proximity.Near> near, List<Proximity.Entry> all) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "players");
        o.addProperty("t", t);
        if (bot == null) o.add("bot", com.google.gson.JsonNull.INSTANCE);
        else {
            JsonObject b = new JsonObject();
            b.addProperty("x", r2(bot.x())); b.addProperty("y", r2(bot.y())); b.addProperty("z", r2(bot.z()));
            b.addProperty("uuid", bot.uuid().toString());
            o.add("bot", b);
        }
        JsonArray arr = new JsonArray();
        for (Proximity.Near n : near) {
            JsonObject p = new JsonObject();
            p.addProperty("uuid", n.p().uuid().toString());
            p.addProperty("name", n.p().name());
            p.addProperty("dist", r2(n.dist()));
            p.addProperty("x", r2(n.p().x())); p.addProperty("y", r2(n.p().y())); p.addProperty("z", r2(n.p().z()));
            arr.add(p);
        }
        o.add("near", arr);
        if (all != null) {
            JsonArray aa = new JsonArray();
            for (Proximity.Entry e : all) {
                JsonObject p = new JsonObject();
                p.addProperty("uuid", e.p().uuid().toString());
                p.addProperty("name", e.p().name());
                if (e.dist() == null) p.add("dist", com.google.gson.JsonNull.INSTANCE); else p.addProperty("dist", r2(e.dist()));
                p.addProperty("in_range", e.inRange());
                p.addProperty("x", r2(e.p().x())); p.addProperty("y", r2(e.p().y())); p.addProperty("z", r2(e.p().z()));
                aa.add(p);
            }
            o.add("all", aa);
        }
        return o.toString();
    }

    public static String audioIn(String uuid, String name, Double dist, boolean inRange, long seq, long t, short[] pcm16k) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "audio_in");
        o.addProperty("uuid", uuid);
        o.addProperty("name", name);
        if (dist == null) o.add("dist", com.google.gson.JsonNull.INSTANCE); else o.addProperty("dist", r2(dist));
        o.addProperty("in_range", inRange);
        o.addProperty("seq", seq);
        o.addProperty("t", t);
        o.addProperty("pcm16k", encodePcm(pcm16k));
        return o.toString();
    }

    public static String audioEnd(String uuid, String name) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "audio_end");
        o.addProperty("uuid", uuid);
        o.addProperty("name", name);
        return o.toString();
    }

    public static String played(String utt, long ms, boolean done) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "played");
        o.addProperty("utt_id", utt);
        o.addProperty("ms_played", ms);
        o.addProperty("done", done);
        return o.toString();
    }

    public static String error(String msg) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "error");
        o.addProperty("msg", msg);
        return o.toString();
    }

    public static String encodePcm(short[] pcm) {
        ByteBuffer bb = ByteBuffer.allocate(pcm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (short s : pcm) bb.putShort(s);
        return Base64.getEncoder().encodeToString(bb.array());
    }

    public static short[] decodePcm(String b64) {
        byte[] raw = Base64.getDecoder().decode(b64);
        if ((raw.length & 1) != 0) throw new IllegalArgumentException("odd byte count");
        short[] out = new short[raw.length / 2];
        ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(out);
        return out;
    }

    // ---- incoming (service -> mod) ----
    public sealed interface In permits AudioOut, Flush, SpeakDistance {}
    public record AudioOut(String uttId, long seq, short[] pcm48k) implements In {}
    public record Flush(String uttId) implements In {}
    public record SpeakDistance(double d) implements In {}

    /** @throws IllegalArgumentException on anything malformed or unknown */
    public static In parse(String text) {
        try {
            JsonObject o = JsonParser.parseString(text).getAsJsonObject();
            String type = o.get("type").getAsString().toLowerCase(Locale.ROOT);
            switch (type) {
                case "audio_out":
                    return new AudioOut(o.get("utt_id").getAsString(),
                            o.has("seq") ? o.get("seq").getAsLong() : 0L,
                            decodePcm(o.get("pcm48k").getAsString()));
                case "flush":
                    return new Flush(o.has("utt_id") ? o.get("utt_id").getAsString() : "*");
                case "speak_distance":
                    double d = o.get("d").getAsDouble();
                    if (!(d > 0) || d > 1000) throw new IllegalArgumentException("bad d");
                    return new SpeakDistance(d);
                default:
                    throw new IllegalArgumentException("unknown type " + type);
            }
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("malformed message: " + e.getMessage());
        }
    }
}
