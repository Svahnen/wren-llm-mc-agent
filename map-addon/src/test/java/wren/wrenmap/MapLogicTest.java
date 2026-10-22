package wren.wrenmap;

import static org.junit.jupiter.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class MapLogicTest {
    static class FakeSink implements MarkerSink {
        final Map<String, Map<String, MarkerSpec>> data = new HashMap<>();
        int puts, removes;
        public void put(String s, String id, MarkerSpec m) { data.computeIfAbsent(s, k -> new HashMap<>()).put(id, m); puts++; }
        public void remove(String s, String id) { data.getOrDefault(s, new HashMap<>()).remove(id); removes++; }
    }

    static MobSnapshot mob(UUID id, String type, String name, boolean hostile, double x, double z) {
        return new MobSnapshot(id, type, name, hostile, Vec.of(x, 64, z));
    }

    @Test void dedupAcrossPlayersAndSplit() {
        UUID a = UUID.randomUUID(), b = UUID.randomUUID();
        var plan = MobPlanner.plan(List.of(mob(a, "zombie", null, true, 1, 1), mob(a, "zombie", null, true, 1, 1), mob(b, "cow", null, false, 5, 5)),
            List.of(Vec.of(0, 64, 0)), 200);
        assertEquals(1, plan.hostile().size());
        assertEquals(1, plan.animals().size());
        assertEquals("Zombie", plan.hostile().get("m-" + a).label());
        assertEquals("assets/wrenmap/icons/zombie.svg", plan.hostile().get("m-" + a).icon());
        assertEquals("assets/wrenmap/icons/cow.svg", plan.animals().get("m-" + b).icon());
    }

    @Test void capKeepsNearest() {
        List<MobSnapshot> l = new ArrayList<>();
        for (int i = 0; i < 300; i++) l.add(mob(UUID.randomUUID(), "pig", null, false, i, 0));
        var plan = MobPlanner.plan(l, List.of(Vec.of(0, 64, 0)), 200);
        assertEquals(200, plan.animals().size());
        double far = plan.animals().values().stream().mapToDouble(s -> s.pos().x()).max().getAsDouble();
        assertEquals(199.0, far);
    }

    @Test void labelUsesNameAndPrettyType() {
        assertEquals("Zombie Villager", MobPlanner.label(mob(UUID.randomUUID(), "zombie_villager", null, true, 0, 0)));
        assertEquals("Wolf \"Rex\"", MobPlanner.label(mob(UUID.randomUUID(), "wolf", "Rex", false, 0, 0)));
    }

    @Test void syncCreatesUpdatesRemovesOnlyChanges() {
        FakeSink sink = new FakeSink();
        Map<String, MarkerSpec> applied = new LinkedHashMap<>();
        UUID a = UUID.randomUUID(), b = UUID.randomUUID();
        var p1 = MobPlanner.plan(List.of(mob(a, "zombie", null, true, 1, 1), mob(b, "creeper", null, true, 9, 9)), List.of(Vec.of(0, 64, 0)), 200);
        assertArrayEquals(new int[] {2, 0, 0}, MarkerSync.sync("h", applied, p1.hostile(), sink));
        assertArrayEquals(new int[] {0, 0, 0}, MarkerSync.sync("h", applied, p1.hostile(), sink)); // nothing changed, nothing sent
        assertEquals(2, sink.puts);
        var p2 = MobPlanner.plan(List.of(mob(a, "zombie", null, true, 2, 1)), List.of(Vec.of(0, 64, 0)), 200); // a moved, b gone
        assertArrayEquals(new int[] {0, 1, 1}, MarkerSync.sync("h", applied, p2.hostile(), sink));
        assertEquals(1, sink.data.get("h").size());
        assertEquals(2.0, sink.data.get("h").get("m-" + a).pos().x());
        MarkerSync.clear("h", applied, sink);
        assertTrue(sink.data.get("h").isEmpty());
    }

    static final String JSON = """
        {"trail":[[1,64,1],[2,64,2],[3,64,3],[4,64,4]],"home":[10,65,10],
         "deaths":[{"pos":[5,60,5],"cause":"lava","t":"day 4"},{"pos":["x"],"cause":"bad"}],
         "goal":"get <food>","thought":"I'm \\"hungry\\" & tired","places":[{"name":"lake","pos":[20,63,20]},{"name":"","pos":[1,1,1]}]}
        """;

    @Test void parseWrenJson() {
        WrenData d = WrenData.parse(JSON, 200);
        assertEquals(4, d.trail().size());
        assertEquals(10.0, d.home().x());
        assertEquals(1, d.deaths().size());
        assertEquals("lava", d.deaths().get(0).cause());
        assertEquals(1, d.places().size());
    }

    @Test void trailCapKeepsNewest() {
        StringBuilder sb = new StringBuilder("{\"trail\":[");
        for (int i = 0; i < 500; i++) sb.append(i == 0 ? "" : ",").append("[").append(i).append(",64,0]");
        WrenData d = WrenData.parse(sb.append("]}").toString(), 200);
        assertEquals(200, d.trail().size());
        assertEquals(499.0, d.trail().get(199).x());
        assertEquals(300.0, d.trail().get(0).x());
    }

    @Test void homeNullAndMissingFieldsTolerated() {
        WrenData d = WrenData.parse("{\"home\":null}", 200);
        assertNull(d.home());
        assertTrue(d.trail().isEmpty());
        assertThrows(RuntimeException.class, () -> WrenData.parse("not json", 200));
    }

    @Test void overlayMarkersAndHtmlEscaped() {
        WrenData d = WrenData.parse(JSON, 200);
        var m = WrenOverlay.build(d, Vec.of(7, 64, 7), "Wren");
        assertEquals(MarkerSpec.Type.LINE, m.get("trail").type());
        assertEquals("home", m.get("home").icon());
        assertEquals("Death: lava (day 4)", m.get("death-0").label());
        assertEquals("lake", m.get("place-0").label());
        assertEquals(MarkerSpec.Type.POI, m.get("now").type());
        assertEquals("wren", m.get("now").icon());
        assertEquals("Wren", m.get("now").label());
        assertEquals(7.0, m.get("now").pos().x());
    }

    @Test void overlayWithoutWrenOnlineHasNoNowMarker() {
        var m = WrenOverlay.build(WrenData.parse(JSON, 200), null, "Wren");
        assertFalse(m.containsKey("now"));
        var none = WrenOverlay.build(null, null, "Wren");
        assertTrue(none.isEmpty());
    }

    @Test void overlayUpdatesWhenFileChanges() {
        FakeSink sink = new FakeSink();
        Map<String, MarkerSpec> applied = new LinkedHashMap<>();
        MarkerSync.sync("w", applied, WrenOverlay.build(WrenData.parse(JSON, 200), Vec.of(0, 0, 0), "Wren"), sink);
        int before = sink.puts;
        MarkerSync.sync("w", applied, WrenOverlay.build(WrenData.parse(JSON.replace("lake", "river"), 200), Vec.of(0, 0, 0), "Wren"), sink);
        assertEquals(before + 1, sink.puts);
    }
}
