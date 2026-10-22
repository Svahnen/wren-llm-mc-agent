package wren.wrenmap;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Mob type -> marker icon. The list comes from web/icons/index.txt (written by tools/gen-icons.mjs). */
public final class IconCatalog {
    public static final String URL_PREFIX = "assets/wrenmap/icons/";
    private static final Map<String, String> CATEGORY = load();

    private IconCatalog() {}

    private static Map<String, String> load() {
        Map<String, String> m = new LinkedHashMap<>();
        try (InputStream in = IconCatalog.class.getResourceAsStream("/web/icons/index.txt")) {
            if (in != null) {
                BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                for (String l; (l = br.readLine()) != null; ) {
                    String[] p = l.trim().split("\\s+");
                    if (p.length == 2) m.put(p[0], p[1]);
                }
            }
        } catch (IOException ignored) { }
        return m;
    }

    /** All icon names (types and fallbacks), for copying into the web root. */
    public static List<String> names() { return new ArrayList<>(CATEGORY.keySet()); }

    public static boolean known(String type) { return CATEGORY.containsKey(type); }

    /** Icon name for a mob type; unknown types get the fallback of their category (hostile flag decides). */
    public static String icon(String type, boolean hostile) {
        if (type != null && known(type) && !type.startsWith("fallback-")) return type;
        return hostile ? "fallback-hostile" : "fallback-passive";
    }

    public static String category(String iconName) { return CATEGORY.getOrDefault(iconName, "passive"); }

    /** Marker icon value understood by BlueMapSink: a web-root relative URL. */
    public static String url(String iconName) { return URL_PREFIX + iconName + ".svg"; }
}
