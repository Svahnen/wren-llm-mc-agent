package wren.wrenmap;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Set;
import org.junit.jupiter.api.Test;

class IconCatalogTest {
    @Test void everyCommonTypeHasItsOwnIconAndCategory() {
        for (String t : Set.of("zombie", "husk", "drowned", "skeleton", "stray", "creeper", "spider", "cave_spider", "enderman", "witch",
            "slime", "phantom", "pillager", "zombie_villager", "pig", "cow", "sheep", "chicken", "horse", "donkey", "rabbit", "wolf", "cat",
            "fox", "salmon", "cod", "squid", "bee", "llama", "goat", "villager", "wandering_trader", "iron_golem")) {
            assertEquals(t, IconCatalog.icon(t, false), t);
            assertEquals(t, IconCatalog.icon(t, true), t);
            assertNotNull(IconCatalog.class.getResource("/web/icons/" + t + ".svg"), t);
        }
        assertEquals("hostile", IconCatalog.category("zombie"));
        assertEquals("passive", IconCatalog.category("pig"));
        assertEquals("neutral", IconCatalog.category("wolf"));
        assertEquals("neutral", IconCatalog.category("bee"));
        assertEquals("npc", IconCatalog.category("villager"));
        assertEquals("npc", IconCatalog.category("wandering_trader"));
    }

    @Test void fallbackPerCategory() {
        assertEquals("fallback-hostile", IconCatalog.icon("modded_thing", true));
        assertEquals("fallback-passive", IconCatalog.icon("modded_thing", false));
        assertEquals("fallback-passive", IconCatalog.icon(null, false));
        assertEquals("fallback-hostile", IconCatalog.icon("fallback-npc", true));
        for (String f : new String[] {"fallback-hostile", "fallback-passive", "fallback-neutral", "fallback-npc"}) {
            assertTrue(IconCatalog.known(f));
            assertNotNull(IconCatalog.class.getResource("/web/icons/" + f + ".svg"));
        }
        assertEquals("npc", IconCatalog.category("fallback-npc"));
    }

    @Test void urlAndNamesConsistent() {
        assertEquals("assets/wrenmap/icons/cave_spider.svg", IconCatalog.url("cave_spider"));
        assertTrue(IconCatalog.names().size() >= 40);
        for (String n : IconCatalog.names()) assertNotNull(IconCatalog.class.getResource("/web/icons/" + n + ".svg"), n);
    }
}
