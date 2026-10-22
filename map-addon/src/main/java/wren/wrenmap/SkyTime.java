package wren.wrenmap;

import java.util.Locale;

/** Pure logic: game time and weather -> sunlight 0..1 and the small JSON the web script polls. */
public final class SkyTime {
    private SkyTime() {}

    /** Day starts at tick 0 (6:00). Full light until 12000, dusk ramp to 13800, night, dawn ramp from 22200. */
    public static double sunlight(long dayTime, double rain, double thunder) {
        long t = Math.floorMod(dayTime, 24000L);
        double base;
        if (t <= 12000) base = 1;
        else if (t < 13800) base = 1 - (t - 12000) / 1800.0;
        else if (t < 22200) base = 0;
        else base = (t - 22200) / 1800.0;
        double weather = 1 - 0.3 * clamp(rain) - 0.3 * clamp(thunder);
        return clamp(base * weather);
    }

    public static String json(long dayTime, double rain, double thunder) {
        long t = Math.floorMod(dayTime, 24000L);
        return String.format(Locale.ROOT,
            "{\"dayTime\":%d,\"sunlight\":%.3f,\"rain\":%.2f,\"thunder\":%.2f}",
            t, sunlight(t, rain, thunder), clamp(rain), clamp(thunder));
    }

    private static double clamp(double v) { return Math.max(0, Math.min(1, v)); }
}
