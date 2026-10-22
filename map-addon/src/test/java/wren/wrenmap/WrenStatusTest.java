package wren.wrenmap;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

class WrenStatusTest {
    @Test void fullStatus() {
        String j = WrenStatus.json("Wren", Vec.of(10.4, 64, -20.6), "get <food>", "hungry\n  and tired", "Sam", 42.4, 24000L * 2 + 6000);
        JsonObject o = JsonParser.parseString(j).getAsJsonObject();
        assertEquals("Wren", o.get("name").getAsString());
        assertTrue(o.get("online").getAsBoolean());
        assertEquals("get <food>", o.get("goal").getAsString());
        assertEquals("hungry and tired", o.get("thought").getAsString());
        assertEquals(10, o.getAsJsonObject("pos").get("x").getAsInt());
        assertEquals(-21, o.getAsJsonObject("pos").get("z").getAsInt());
        assertEquals("Sam", o.getAsJsonObject("nearest").get("name").getAsString());
        assertEquals(42, o.getAsJsonObject("nearest").get("dist").getAsInt());
        assertEquals(3, o.get("day").getAsInt());
        assertEquals("12:00", o.get("clock").getAsString());
    }

    @Test void offlineAndLongText() {
        JsonObject o = JsonParser.parseString(WrenStatus.json("Wren", null, null, "x".repeat(1000), "A", 5, 0)).getAsJsonObject();
        assertFalse(o.get("online").getAsBoolean());
        assertFalse(o.has("pos"));
        assertFalse(o.has("nearest"));
        assertEquals("", o.get("goal").getAsString());
        assertEquals(400, o.get("thought").getAsString().length());
        assertEquals("06:00", o.get("clock").getAsString());
    }

    @Test void clockWraps() {
        assertEquals("00:00", WrenStatus.clock(18000));
        assertEquals("23:59", WrenStatus.clock(17999));
    }

    @Test void vitals() {
        var v = new WrenStatus.Vitals(7.04, 20, 3, 1.26, "Bread", 5);
        JsonObject o = JsonParser.parseString(WrenStatus.json("Wren", Vec.of(0, 64, 0), "g", "t", null, -1, 0, v)).getAsJsonObject();
        JsonObject x = o.getAsJsonObject("vitals");
        assertEquals(7.0, x.get("hp").getAsDouble());
        assertEquals(20.0, x.get("maxHp").getAsDouble());
        assertEquals(3, x.get("food").getAsInt());
        assertEquals(1.3, x.get("sat").getAsDouble());
        assertEquals("Bread", x.get("held").getAsString());
        assertEquals(5, x.get("heldCount").getAsInt());
        assertFalse(JsonParser.parseString(WrenStatus.json("Wren", null, "g", "t", null, -1, 0, v)).getAsJsonObject().has("vitals"));
        assertFalse(JsonParser.parseString(WrenStatus.json("Wren", Vec.of(0, 64, 0), "g", "t", null, -1, 0)).getAsJsonObject().has("vitals"));
    }
}
