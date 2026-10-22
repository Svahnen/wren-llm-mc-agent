package wren.wrenmap;

import java.util.List;

/** Platform-neutral description of one marker; value equality drives "did it change" checks. */
public record MarkerSpec(Type type, String icon, String label, Vec pos, List<Vec> points, String html) {
    public enum Type { POI, LINE, HTML }

    public static MarkerSpec poi(String icon, String label, Vec pos) {
        return new MarkerSpec(Type.POI, icon, label, pos, List.of(), "");
    }
    public static MarkerSpec line(String label, List<Vec> points) {
        return new MarkerSpec(Type.LINE, "", label, points.isEmpty() ? Vec.of(0, 0, 0) : points.get(0), List.copyOf(points), "");
    }
    public static MarkerSpec html(String label, Vec pos, String html) {
        return new MarkerSpec(Type.HTML, "", label, pos, List.of(), html);
    }
}
