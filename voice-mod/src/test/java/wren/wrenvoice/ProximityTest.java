package wren.wrenvoice;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class ProximityTest {
    static Proximity.Pos p(String n, double x, double y, double z, String dim) {
        return new Proximity.Pos(UUID.nameUUIDFromBytes(n.getBytes()), n, x, y, z, dim);
    }
    @Test void filtersAndSorts() {
        var bot = p("Wren", 0, 64, 0, "overworld");
        var a = p("a", 10, 64, 0, "overworld");
        var b = p("b", 3, 64, 4, "overworld");     // 5.0
        var c = p("c", 17, 64, 0, "overworld");    // too far
        var d = p("d", 1, 64, 0, "the_nether");    // other dim
        var near = Proximity.near(bot, List.of(a, bot, b, c, d), 16.0);
        assertEquals(2, near.size());
        assertEquals("b", near.get(0).p().name());
        assertEquals(5.0, near.get(0).dist(), 1e-9);
        assertEquals("a", near.get(1).p().name());
    }
    @Test void allListsEveryoneWithInRange() {
        var bot = p("Wren", 0, 0, 0, "o");
        var all = Proximity.all(bot, List.of(p("far", 50, 0, 0, "o"), bot, p("near", 5, 0, 0, "o"), p("nether", 1, 0, 0, "n")), 48.0);
        assertEquals(3, all.size());
        assertEquals("near", all.get(0).p().name()); assertTrue(all.get(0).inRange());
        assertEquals("far", all.get(1).p().name()); assertFalse(all.get(1).inRange());
        assertNull(all.get(2).dist()); assertFalse(all.get(2).inRange());
        assertTrue(Proximity.all(null, List.of(bot), 48).get(0).dist() == null);
    }
    @Test void is3d() {
        var bot = p("Wren", 0, 0, 0, "o");
        assertEquals(-1, Proximity.heardDistance(bot, p("x", 12, 12, 0, "o"), 16.0)); // 16.97
        assertEquals(15, Proximity.heardDistance(bot, p("x", 9, 12, 0, "o"), 16.0), 1e-9);
    }
    @Test void edgesAndNoBot() {
        var bot = p("Wren", 0, 0, 0, "o");
        assertTrue(Proximity.heardDistance(bot, p("x", 16, 0, 0, "o"), 16.0) >= 0);
        assertEquals(-1, Proximity.heardDistance(bot, bot, 16.0));
        assertEquals(-1, Proximity.heardDistance(null, bot, 16.0));
        assertTrue(Proximity.near(null, List.of(bot), 16).isEmpty());
    }
}
