package wren.wrenmap;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class SkyTimeTest {
    @Test void dayNightDawnDusk() {
        assertEquals(1.0, SkyTime.sunlight(6000, 0, 0), 1e-9);
        assertEquals(0.5, SkyTime.sunlight(12900, 0, 0), 1e-9);
        assertEquals(0.0, SkyTime.sunlight(18000, 0, 0), 1e-9);
        assertEquals(0.5, SkyTime.sunlight(23100, 0, 0), 1e-9);
        assertEquals(1.0, SkyTime.sunlight(24000 * 5L + 100, 0, 0), 1e-9); // day counter wraps
    }
    @Test void weatherDims() {
        assertEquals(0.7, SkyTime.sunlight(6000, 1, 0), 1e-9);
        assertEquals(0.4, SkyTime.sunlight(6000, 1, 1), 1e-9);
        assertEquals(0.0, SkyTime.sunlight(18000, 1, 1), 1e-9);
    }
    @Test void jsonShape() {
        assertEquals("{\"dayTime\":6000,\"sunlight\":1.000,\"rain\":0.00,\"thunder\":0.00}", SkyTime.json(30000, 0, 0));
    }
}
