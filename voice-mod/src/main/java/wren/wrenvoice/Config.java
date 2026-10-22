package wren.wrenvoice;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** config/wrenvoice.json. Plain fields so Gson can fill them; missing keys keep defaults. */
public final class Config {
    public String botName = "Wren";
    public double hearRadius = 16.0;
    /** v2: forward mic audio of EVERY real player (with dist/in_range). false = only players within hearRadius (v1 behaviour). */
    public boolean transcribeAll = false;
    public double speakDistance = 20.0;
    public int wsPort = 19520;
    /** Keep "127.0.0.1". Only inside a container, where host-side -p 127.0.0.1:PORT:PORT is the loopback guard, use "0.0.0.0". */
    public String bindAddress = "127.0.0.1";
    /** Shared secret: clients must send header X-Wren-Secret with this value. Generated randomly on first start when empty; put the same value in the voice service (WRENVOICE_SECRET). */
    public String secret = "";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static Config loadOrCreate(Path file) throws IOException {
        if (Files.exists(file)) {
            Config c = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), Config.class);
            if (c == null) c = new Config();
            c.sanitize();
            if (c.secret.isEmpty()) { c.secret = randomSecret(); Files.writeString(file, GSON.toJson(c), StandardCharsets.UTF_8); }
            return c;
        }
        Config c = new Config();
        c.secret = randomSecret();
        Files.createDirectories(file.getParent());
        Files.writeString(file, GSON.toJson(c), StandardCharsets.UTF_8);
        return c;
    }

    static String randomSecret() {
        byte[] b = new byte[24];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    public void sanitize() {
        if (botName == null || botName.isBlank()) botName = "Wren";
        if (!(hearRadius > 0)) hearRadius = 16.0;
        if (!(speakDistance > 0)) speakDistance = 20.0;
        if (wsPort < 1 || wsPort > 65535) wsPort = 19520;
        if (secret == null) secret = "";
        if (bindAddress == null || bindAddress.isBlank()) bindAddress = "127.0.0.1";
    }
}
