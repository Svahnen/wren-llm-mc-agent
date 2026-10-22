package wren.wrenmap;

import com.flowpowered.math.vector.Vector2i;
import com.flowpowered.math.vector.Vector3d;
import de.bluecolored.bluemap.api.BlueMapAPI;
import de.bluecolored.bluemap.api.BlueMapMap;
import de.bluecolored.bluemap.api.markers.HtmlMarker;
import de.bluecolored.bluemap.api.markers.LineMarker;
import de.bluecolored.bluemap.api.markers.Marker;
import de.bluecolored.bluemap.api.markers.MarkerSet;
import de.bluecolored.bluemap.api.markers.POIMarker;
import de.bluecolored.bluemap.api.math.Color;
import de.bluecolored.bluemap.api.math.Line;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Writes marker specs into BlueMap marker sets (one set instance per map and set id). */
public final class BlueMapSink implements MarkerSink {
    private static final int ICON = 20, MOB_ICON = 24;
    private final Map<String, List<MarkerSet>> sets = new HashMap<>();
    private final Map<String, String> iconAddr = new HashMap<>();

    public BlueMapSink(BlueMapAPI api, List<BlueMapMap> maps) {
        defineSet(maps, MobPlanner.SET_HOSTILE, "Hostile mobs");
        defineSet(maps, MobPlanner.SET_ANIMALS, "Animals & villagers");
        defineSet(maps, WrenOverlay.SET, "Wren");
        makeIcon(api, "hostile", 0xE53935);
        makeIcon(api, "animal", 0x43A047);
        makeIcon(api, "home", 0x1E88E5);
        makeIcon(api, "death", 0x212121);
        makeIcon(api, "place", 0xFDD835);
        makeIcon(api, "wren", 0x4FC3F7);
    }

    private void defineSet(List<BlueMapMap> maps, String id, String label) {
        List<MarkerSet> list = new ArrayList<>();
        for (BlueMapMap map : maps) {
            MarkerSet s = new MarkerSet(label, true, false);
            map.getMarkerSets().put(id, s);
            list.add(s);
        }
        sets.put(id, list);
    }

    private void makeIcon(BlueMapAPI api, String key, int rgb) {
        try {
            BufferedImage img = new BufferedImage(ICON, ICON, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = img.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new java.awt.Color(255, 255, 255, 230));
            g.fillOval(0, 0, ICON, ICON);
            g.setColor(new java.awt.Color(rgb));
            g.fillOval(3, 3, ICON - 6, ICON - 6);
            g.dispose();
            iconAddr.put(key, api.getWebApp().createImage(img, "wrenmap/" + key));
        } catch (Exception | LinkageError e) {
            WrenMapMod.LOG.warn("could not create icon {}: {}", key, e.toString());
        }
    }

    @Override
    public void put(String setId, String markerId, MarkerSpec s) {
        List<MarkerSet> list = sets.get(setId);
        if (list == null) return;
        for (MarkerSet set : list) set.put(markerId, build(s));
    }

    @Override
    public void remove(String setId, String markerId) {
        List<MarkerSet> list = sets.get(setId);
        if (list == null) return;
        for (MarkerSet set : list) set.remove(markerId);
    }

    private Marker build(MarkerSpec s) {
        Vector3d p = new Vector3d(s.pos().x(), s.pos().y(), s.pos().z());
        switch (s.type()) {
            case LINE -> {
                List<Vector3d> pts = new ArrayList<>();
                for (Vec v : s.points()) pts.add(new Vector3d(v.x(), v.y() + 0.5, v.z()));
                LineMarker m = new LineMarker(s.label(), new Line(pts));
                m.setLineColor(new Color(0, 200, 255, 0.9f));
                m.setLineWidth(3);
                m.setDepthTestEnabled(false);
                return m;
            }
            case HTML -> {
                return new HtmlMarker(s.label(), p, s.html(), new Vector2i(0, 0));
            }
            default -> {
                POIMarker m = new POIMarker(s.label(), p);
                String addr = iconAddr.get(s.icon());
                if (addr != null) m.setIcon(addr, ICON / 2, ICON / 2);
                else if (s.icon().startsWith(IconCatalog.URL_PREFIX)) m.setIcon(s.icon(), MOB_ICON / 2, MOB_ICON / 2);
                return m;
            }
        }
    }
}
