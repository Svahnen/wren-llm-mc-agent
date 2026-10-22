package wren.wrenvoice;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

/** Fabric main entrypoint: owns config + bridge, publishes a world snapshot every server tick. */
public final class WrenVoiceMod implements ModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("wrenvoice");
    static volatile Config config;
    static volatile VoiceBridge bridge;
    /** Latest bot player instance (server thread writes, plugin reads). */
    static volatile ServerPlayer botEntity;

    @Override
    public void onInitialize() {
        try {
            config = Config.loadOrCreate(FabricLoader.getInstance().getConfigDir().resolve("wrenvoice.json"));
        } catch (Exception e) {
            LOG.error("Cannot read config/wrenvoice.json, using defaults", e);
            config = new Config();
        }
        ServerLifecycleEvents.SERVER_STARTED.register(this::onStarted);
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
            VoiceBridge b = bridge;
            if (b != null) b.stop();
            bridge = null;
        });
        ServerTickEvents.END_SERVER_TICK.register(this::onTick);
    }

    private void onStarted(MinecraftServer server) {
        // The plugin supplies the decoder factory once SVC has started; the bridge is created there.
        WrenVoicePlugin.ensureBridge();
    }

    private void onTick(MinecraftServer server) {
        VoiceBridge b = bridge;
        if (b == null) return;
        List<ServerPlayer> all = server.getPlayerList().getPlayers();
        List<Proximity.Pos> ps = new ArrayList<>(all.size());
        ServerPlayer bot = null;
        Proximity.Pos botPos = null;
        for (ServerPlayer p : all) {
            Proximity.Pos pos = new Proximity.Pos(p.getUUID(), p.getGameProfile().getName(),
                    p.getX(), p.getY(), p.getZ(), p.level().dimension().location().toString());
            ps.add(pos);
            if (p.getGameProfile().getName().equals(config.botName)) { bot = p; botPos = pos; }
        }
        botEntity = bot;
        b.setSnapshot(new VoiceBridge.Snapshot(botPos, ps));
        WrenVoicePlugin.checkBotBinding(bot, botPos == null ? null : botPos.dim());
    }
}
