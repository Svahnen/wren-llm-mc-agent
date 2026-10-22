package wren.wrenmap;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** config/wrenmap/config.json (written with defaults on first start). */
public final class Config {
    public int intervalMs = 2000;
    public int radius = 48;
    public int maxMarkers = 200;
    public int trailMax = 200;
    public String botName = "Wren";
    public String wrenFile = "wren.json";
    /** Empty = every map of the overworld. */
    public String[] mapIds = new String[0];
    public boolean mobs = true;
    public boolean wren = true;
    /** Write the game-time feed + register the viewer script that makes the web map follow it. */
    public boolean followTime = true;
    public int timeIntervalMs = 5000;

    public void clamp() {
        intervalMs = Math.max(500, Math.min(60000, intervalMs));
        radius = Math.max(8, Math.min(128, radius));
        maxMarkers = Math.max(1, Math.min(1000, maxMarkers));
        trailMax = Math.max(2, Math.min(2000, trailMax));
        if (botName == null || botName.isBlank()) botName = "Wren";
        if (wrenFile == null || wrenFile.isBlank()) wrenFile = "wren.json";
        timeIntervalMs = Math.max(1000, Math.min(60000, timeIntervalMs));
        if (mapIds == null) mapIds = new String[0];
    }

    public static Config load(Path file) {
        Gson gson = new GsonBuilder().setPrettyPrinting().create();
        Config c = new Config();
        try {
            if (Files.exists(file)) {
                JsonObject o = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                c = gson.fromJson(o, Config.class);
                if (c == null) c = new Config();
            }
            c.clamp();
            Files.createDirectories(file.getParent());
            Files.writeString(file, gson.toJson(c));
        } catch (IOException | RuntimeException e) {
            c = new Config();
            c.clamp();
        }
        return c;
    }
}
