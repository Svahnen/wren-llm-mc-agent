package wren.wrenvoice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class ProtocolTest {
    @Test void pcmRoundTripLittleEndian() {
        short[] x = {0, 1, -1, 32767, -32768, 258};
        assertEquals("AAABAP///38AgAIB", Protocol.encodePcm(x));
        assertArrayEquals(x, Protocol.decodePcm(Protocol.encodePcm(x)));
    }
    @Test void helloAndPlayers() {
        JsonObject h = JsonParser.parseString(Protocol.hello("Wren", true)).getAsJsonObject();
        assertEquals("hello", h.get("type").getAsString());
        assertEquals(2, h.get("version").getAsInt());
        assertTrue(h.get("botOnline").getAsBoolean());
        JsonObject n = JsonParser.parseString(Protocol.players(5L, null, List.of())).getAsJsonObject();
        assertTrue(n.get("bot").isJsonNull());
        assertEquals(0, n.getAsJsonArray("near").size());
        var bot = new Proximity.Pos(UUID.randomUUID(), "Wren", 1.234, 2, 3, "o");
        var pl = new Proximity.Pos(UUID.randomUUID(), "Sam", 4, 2, 3, "o");
        JsonObject o = JsonParser.parseString(Protocol.players(5L, bot, Proximity.near(bot, List.of(pl), 16))).getAsJsonObject();
        assertEquals(1.23, o.getAsJsonObject("bot").get("x").getAsDouble());
        JsonObject e = o.getAsJsonArray("near").get(0).getAsJsonObject();
        assertEquals("Sam", e.get("name").getAsString());
        assertEquals(2.77, e.get("dist").getAsDouble(), 0.02);
    }
    @Test void audioInFields() {
        JsonObject o = JsonParser.parseString(Protocol.audioIn("u", "n", 3.456, true, 7, 99L, new short[320])).getAsJsonObject();
        assertEquals("audio_in", o.get("type").getAsString());
        assertEquals(7, o.get("seq").getAsInt());
        assertEquals(640, java.util.Base64.getDecoder().decode(o.get("pcm16k").getAsString()).length);
    }
    @Test void parseIncoming() {
        String b64 = Protocol.encodePcm(new short[960]);
        var a = (Protocol.AudioOut) Protocol.parse("{\"type\":\"audio_out\",\"utt_id\":\"x\",\"seq\":3,\"pcm48k\":\"" + b64 + "\"}");
        assertEquals("x", a.uttId()); assertEquals(3, a.seq()); assertEquals(960, a.pcm48k().length);
        assertEquals("*", ((Protocol.Flush) Protocol.parse("{\"type\":\"flush\",\"utt_id\":\"*\"}")).uttId());
        assertEquals(12.5, ((Protocol.SpeakDistance) Protocol.parse("{\"type\":\"speak_distance\",\"d\":12.5}")).d());
    }
    @Test void parseRejectsGarbage() {
        for (String s : new String[]{"nope", "[]", "{}", "{\"type\":\"zzz\"}", "{\"type\":\"speak_distance\",\"d\":-1}",
                "{\"type\":\"audio_out\",\"utt_id\":\"x\",\"pcm48k\":\"!!!\"}", "{\"type\":\"audio_out\"}"})
            assertThrows(IllegalArgumentException.class, () -> Protocol.parse(s), s);
    }
}
