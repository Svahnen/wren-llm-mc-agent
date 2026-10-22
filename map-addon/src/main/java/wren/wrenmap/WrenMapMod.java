package wren.wrenmap;

import de.bluecolored.bluemap.api.BlueMapAPI;
import de.bluecolored.bluemap.api.BlueMapMap;
import de.bluecolored.bluemap.api.BlueMapWorld;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.ambient.AmbientCreature;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.animal.AbstractGolem;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.WaterAnimal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.npc.AbstractVillager;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Server-side BlueMap addon: mob markers near players + Wren overlays. Markers are recreated on every BlueMap enable. */
public class WrenMapMod implements ModInitializer {
    /** Bump when web/wrenmap-time.js changes: the query string defeats browser caches of the dynamically loaded script. */
    static final String SCRIPT_VERSION = "map4";

    public static final Logger LOG = LoggerFactory.getLogger("wrenmap");

    /** Everything that lives only while BlueMap is enabled. */
    private static final class Runtime {
        final BlueMapSink sink;
        final Map<String, MarkerSpec> hostile = new LinkedHashMap<>(), animals = new LinkedHashMap<>(), wren = new LinkedHashMap<>();
        Runtime(BlueMapSink sink) { this.sink = sink; }
    }

    private Config cfg;
    private volatile BlueMapAPI api;
    private Runtime rt;           // server thread only
    private volatile boolean apiChanged;
    private int tickCounter, intervalTicks = 40;
    private Path wrenPath;
    private long wrenMtime = -1, wrenSize = -1;
    private WrenData wrenData;
    private boolean warnedNoMap;
    private volatile Path webDir;   // <webroot>/assets/wrenmap, set while BlueMap is enabled
    private WrenStatus.Vitals wrenVitals;   // server thread only, refreshed every update
    private int timeCounter;
    private String lastTimeJson = "", lastStatusJson = "";

    @Override
    public void onInitialize() {
        Path dir = FabricLoader.getInstance().getConfigDir().resolve("wrenmap");
        cfg = Config.load(dir.resolve("config.json"));
        wrenPath = dir.resolve(cfg.wrenFile);
        intervalTicks = Math.max(1, cfg.intervalMs / 50);
        BlueMapAPI.onEnable(a -> { api = a; apiChanged = true; installWeb(a); LOG.info("BlueMap {} enabled; markers will be (re)created", a.getBlueMapVersion()); });
        BlueMapAPI.onDisable(a -> { api = null; webDir = null; apiChanged = true; LOG.info("BlueMap disabled"); });
        ServerTickEvents.END_SERVER_TICK.register(this::tick);
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> { api = null; apiChanged = true; });
        LOG.info("wrenmap loaded: interval {} ms, radius {}, max {} markers, wren file {}", cfg.intervalMs, cfg.radius, cfg.maxMarkers, wrenPath);
    }

    private void tick(MinecraftServer server) {
        if (++tickCounter < intervalTicks) return;
        tickCounter = 0;
        try {
            BlueMapAPI a = api;
            if (apiChanged) {
                apiChanged = false;
                rt = null;           // BlueMap throws its sets away on reload; build again
                warnedNoMap = false;
                wrenMtime = -1;      // re-read the file into the new markers
            }
            if (a == null) return;
            if (rt == null) {
                rt = createRuntime(server, a);
                if (rt == null) return;
            }
            update(server, rt);
            writeTime(server);
        } catch (RuntimeException | LinkageError e) {
            LOG.warn("wrenmap update failed: {}", e.toString());
        }
    }

    private Runtime createRuntime(MinecraftServer server, BlueMapAPI a) {
        ServerLevel overworld = server.getLevel(Level.OVERWORLD);
        if (overworld == null) return null;
        List<BlueMapMap> maps = new ArrayList<>();
        Optional<BlueMapWorld> w = a.getWorld(overworld);
        if (w.isPresent()) maps.addAll(w.get().getMaps());
        if (cfg.mapIds.length > 0) {
            maps.removeIf(m -> {
                for (String id : cfg.mapIds) if (id.equals(m.getId())) return false;
                return true;
            });
        }
        if (maps.isEmpty()) {
            if (!warnedNoMap) { LOG.warn("no BlueMap map for the overworld yet (will retry)"); warnedNoMap = true; }
            return null;
        }
        StringBuilder ids = new StringBuilder();
        for (BlueMapMap m : maps) ids.append(m.getId()).append(' ');
        LOG.info("creating marker sets on maps: {}", ids.toString().trim());
        return new Runtime(new BlueMapSink(a, maps));
    }

    private void update(MinecraftServer server, Runtime r) {
        List<Vec> playerPos = new ArrayList<>();
        List<MobSnapshot> seen = new ArrayList<>();
        Vec wrenPos = null;
        wrenVitals = null;
        java.util.Map<String, Vec> named = new java.util.LinkedHashMap<>();
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (p.level().dimension() != Level.OVERWORLD) continue;
            Vec pv = Vec.of(p.getX(), p.getY(), p.getZ());
            playerPos.add(pv);
            if (p.getGameProfile().getName().equalsIgnoreCase(cfg.botName)) {
                wrenPos = pv;
                var hand = p.getMainHandItem();
                String held = hand.isEmpty() ? "" : BuiltInRegistries.ITEM.getKey(hand.getItem()).getPath();
                wrenVitals = new WrenStatus.Vitals(p.getHealth(), p.getMaxHealth(), p.getFoodData().getFoodLevel(),
                    p.getFoodData().getSaturationLevel(), MobPlanner.pretty(held), hand.isEmpty() ? 0 : hand.getCount());
            }
            else named.put(p.getGameProfile().getName(), pv);
            if (!cfg.mobs) continue;
            double r2 = (double) cfg.radius * cfg.radius;
            AABB box = p.getBoundingBox().inflate(cfg.radius);
            for (Mob m : p.serverLevel().getEntitiesOfClass(Mob.class, box, Mob::isAlive)) {
                if (m.distanceToSqr(p) > r2) continue;
                Boolean hostile = classify(m);
                if (hostile == null) continue;
                String type = BuiltInRegistries.ENTITY_TYPE.getKey(m.getType()).getPath();
                String name = m.hasCustomName() ? m.getCustomName().getString() : null;
                seen.add(new MobSnapshot(m.getUUID(), type, name, hostile, Vec.of(m.getX(), m.getY(), m.getZ())));
            }
        }
        if (cfg.mobs) {
            MobPlanner.Plan plan = MobPlanner.plan(seen, playerPos, cfg.maxMarkers);
            MarkerSync.sync(MobPlanner.SET_HOSTILE, r.hostile, plan.hostile(), r.sink);
            MarkerSync.sync(MobPlanner.SET_ANIMALS, r.animals, plan.animals(), r.sink);
        }
        if (cfg.wren) {
            reloadWrenFile();
            MarkerSync.sync(WrenOverlay.SET, r.wren, WrenOverlay.build(wrenData, wrenPos, cfg.botName), r.sink);
            writeStatus(server, wrenPos, named);
        }
    }

    /** Copies the viewer script into BlueMap's web root and registers it (runs on BlueMap's thread). */
    private void installWeb(BlueMapAPI a) {
        if (!cfg.followTime) return;
        try {
            Path dir = a.getWebApp().getWebRoot().resolve("assets").resolve("wrenmap");
            Files.createDirectories(dir);
            Path icons = dir.resolve("icons");
            Files.createDirectories(icons);
            int n = 0;
            for (String name : IconCatalog.names()) {
                try (var in = WrenMapMod.class.getResourceAsStream("/web/icons/" + name + ".svg")) {
                    if (in != null) { Files.write(icons.resolve(name + ".svg"), in.readAllBytes()); n++; }
                }
            }
            LOG.info("installed {} mob icons into {}", n, icons);
            try (var in = WrenMapMod.class.getResourceAsStream("/web/wrenmap-time.js")) {
                Files.write(dir.resolve("wrenmap-time.js"), in.readAllBytes());
            }
            a.getWebApp().registerScript("assets/wrenmap/wrenmap-time.js?v=" + SCRIPT_VERSION);
            webDir = dir;
            lastTimeJson = "";
            lastStatusJson = "";
            LOG.info("registered viewer script assets/wrenmap/wrenmap-time.js; time feed in {}", dir);
        } catch (IOException | RuntimeException e) {
            LOG.warn("could not install the time-follow script: {}", e.toString());
        }
    }

    /** Called every map interval; writes the time feed every cfg.timeIntervalMs (atomic temp + move, only when changed). */
    private void writeTime(MinecraftServer server) {
        Path dir = webDir;
        if (dir == null || !cfg.followTime) return;
        timeCounter += intervalTicks;
        if (timeCounter < Math.max(1, cfg.timeIntervalMs / 50)) return;
        timeCounter = 0;
        ServerLevel ow = server.getLevel(Level.OVERWORLD);
        if (ow == null) return;
        String json = SkyTime.json(ow.getDayTime(), ow.getRainLevel(1.0f), ow.getThunderLevel(1.0f));
        if (json.equals(lastTimeJson)) return;
        try {
            Path tmp = dir.resolve("time.json.tmp");
            Files.writeString(tmp, json);
            Files.move(tmp, dir.resolve("time.json"), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            lastTimeJson = json;
        } catch (IOException e) {
            LOG.warn("could not write time feed: {}", e.toString());
        }
    }

    /** Every map interval (2 s): the top-center panel feed assets/wrenmap/wren-status.json (atomic, only when changed). */
    private void writeStatus(MinecraftServer server, Vec wrenPos, Map<String, Vec> others) {
        Path dir = webDir;
        if (dir == null) return;
        ServerLevel ow = server.getLevel(Level.OVERWORLD);
        if (ow == null) return;
        String near = null;
        double best = Double.MAX_VALUE;
        if (wrenPos != null) {
            for (Map.Entry<String, Vec> e : others.entrySet()) {
                if (e.getKey().matches(java.util.regex.Pattern.quote(cfg.botName) + "T\\d+")) continue;   // spare test bots (WrenT2..) are not people
                double d = e.getValue().dist2(wrenPos);
                if (d < best) { best = d; near = e.getKey(); }
            }
        }
        String json = WrenStatus.json(cfg.botName, wrenPos, wrenData == null ? "" : wrenData.goal(),
            wrenData == null ? "" : wrenData.thought(), near, near == null ? -1 : Math.sqrt(best), ow.getDayTime(), wrenVitals);
        if (json.equals(lastStatusJson)) return;
        try {
            Path tmp = dir.resolve("wren-status.json.tmp");
            Files.writeString(tmp, json);
            Files.move(tmp, dir.resolve("wren-status.json"), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            lastStatusJson = json;
        } catch (IOException e) {
            LOG.warn("could not write wren status: {}", e.toString());
        }
    }

    /** True = hostile, false = passive, null = not shown. */
    static Boolean classify(Mob m) {
        if (m instanceof Enemy) return true;
        if (m instanceof Animal || m instanceof AbstractVillager || m instanceof WaterAnimal
            || m instanceof AmbientCreature || m instanceof AbstractGolem) return false;
        return null;
    }

    private void reloadWrenFile() {
        try {
            if (!Files.exists(wrenPath)) {
                if (wrenMtime != -2) { wrenData = null; wrenMtime = -2; }
                return;
            }
            long mt = Files.getLastModifiedTime(wrenPath).toMillis(), sz = Files.size(wrenPath);
            if (mt == wrenMtime && sz == wrenSize) return;
            wrenMtime = mt;
            wrenSize = sz;
            wrenData = WrenData.parse(Files.readString(wrenPath), cfg.trailMax);
        } catch (IOException | RuntimeException e) {
            LOG.warn("could not read {} (keeping previous data): {}", wrenPath, e.toString());
        }
    }
}
