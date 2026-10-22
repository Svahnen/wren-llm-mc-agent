package wren.wrenmap;

import java.util.LinkedHashMap;
import java.util.Map;

/** Pure logic: Wren's file data (+ her live position) -> marker specs for the "Wren" set. */
public final class WrenOverlay {
    public static final String SET = "wrenmap-wren";
    private static final int TEXT_MAX = 240;

    private WrenOverlay() {}

    /** {@code data} and {@code wrenPos} may each be null. */
    public static Map<String, MarkerSpec> build(WrenData data, Vec wrenPos, String botName) {
        Map<String, MarkerSpec> m = new LinkedHashMap<>();
        if (data != null) {
            if (data.trail().size() >= 2) m.put("trail", MarkerSpec.line(botName + "'s trail", data.trail()));
            if (data.home() != null) m.put("home", MarkerSpec.poi("home", "Home", data.home()));
            int i = 0;
            for (WrenData.Death d : data.deaths()) {
                String label = "Death" + (d.cause().isBlank() ? "" : ": " + d.cause()) + (d.t().isBlank() ? "" : " (" + d.t() + ")");
                m.put("death-" + (i++), MarkerSpec.poi("death", label, d.pos()));
            }
            i = 0;
            for (WrenData.Place p : data.places()) m.put("place-" + (i++), MarkerSpec.poi("place", p.name(), p.pos()));
        }
        if (wrenPos != null) {
            m.put("now", MarkerSpec.poi("wren", botName, wrenPos));
        }
        return m;
    }

    public static String nowHtml(String botName, String goal, String thought) {
        StringBuilder sb = new StringBuilder();
        sb.append("<div style=\"background:rgba(20,20,30,.85);color:#fff;border:2px solid #4fc3f7;border-radius:6px;")
          .append("padding:4px 8px;max-width:260px;font:12px sans-serif;transform:translate(-50%,-110%);white-space:normal\">")
          .append("<b>").append(escape(botName)).append("</b>");
        if (!goal.isBlank()) sb.append("<br><span style=\"color:#ffd54f\">Goal:</span> ").append(escape(cut(goal)));
        if (!thought.isBlank()) sb.append("<br><i>&ldquo;").append(escape(cut(thought))).append("&rdquo;</i>");
        return sb.append("</div>").toString();
    }

    static String cut(String s) {
        s = s.strip();
        return s.length() <= TEXT_MAX ? s : s.substring(0, TEXT_MAX - 1) + "…";
    }

    public static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (char c : s.toCharArray()) {
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
