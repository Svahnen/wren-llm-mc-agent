package wren.wrenvoice;

import de.maxhenkel.voicechat.api.Entity;
import de.maxhenkel.voicechat.api.VoicechatApi;
import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.audiochannel.EntityAudioChannel;
import de.maxhenkel.voicechat.api.events.EventRegistration;
import de.maxhenkel.voicechat.api.events.MicrophonePacketEvent;
import de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent;
import de.maxhenkel.voicechat.api.events.VoicechatServerStoppedEvent;
import de.maxhenkel.voicechat.api.opus.OpusDecoder;
import de.maxhenkel.voicechat.api.opus.OpusEncoder;
import net.minecraft.server.level.ServerPlayer;

import java.io.IOException;
import java.util.UUID;

/** Simple Voice Chat plugin (entrypoint "voicechat"). Adapts SVC to the MC-free VoiceBridge. */
public final class WrenVoicePlugin implements VoicechatPlugin {
    private static volatile VoicechatServerApi serverApi;
    private static final Object lock = new Object();

    // Channel state, guarded by `lock`; the encoder is only used under `lock` too.
    private static EntityAudioChannel channel;
    private static OpusEncoder encoder;
    private static ServerPlayer boundEntity;
    private static String boundDim;

    @Override public String getPluginId() { return "wrenvoice"; }

    @Override
    public void initialize(VoicechatApi api) {
        WrenVoiceMod.LOG.info("wrenvoice plugin initialised (SVC API)");
    }

    @Override
    public void registerEvents(EventRegistration reg) {
        reg.registerEvent(VoicechatServerStartedEvent.class, e -> {
            serverApi = e.getVoicechat();
            ensureBridge();
        });
        reg.registerEvent(VoicechatServerStoppedEvent.class, e -> {
            synchronized (lock) { channel = null; boundEntity = null; if (encoder != null) { encoder.close(); encoder = null; } }
            serverApi = null;
        });
        reg.registerEvent(MicrophonePacketEvent.class, this::onMic);
    }

    private void onMic(MicrophonePacketEvent e) {
        VoiceBridge b = WrenVoiceMod.bridge;
        if (b == null || e.getSenderConnection() == null) return;
        // Deafened / disabled voice chat: SVC then does not deliver this player's speech to anyone; skip decoding too.
        if (e.getSenderConnection().isDisabled()) return;
        UUID id = e.getSenderConnection().getPlayer().getUuid();
        // Never feed the bot's own channel back (it has no mic, but be safe). Bot filtering is also in Proximity.
        b.onMic(id, e.getPacket().getOpusEncodedData());
    }

    /** Create + start the bridge once both the Fabric server and the SVC server API exist. */
    static void ensureBridge() {
        VoicechatServerApi api = serverApi;
        Config cfg = WrenVoiceMod.config;
        if (api == null || cfg == null || WrenVoiceMod.bridge != null) return;
        synchronized (lock) {
            if (WrenVoiceMod.bridge != null) return;
            VoiceBridge b = new VoiceBridge(cfg, () -> {
                OpusDecoder d = api.createDecoder();
                return new VoiceBridge.OpusIn() {
                    public short[] decode(byte[] opus) { return d.decode(opus); }
                    public void close() { try { d.close(); } catch (RuntimeException ignored) {} }
                };
            });
            b.setSpeaker(new VoiceBridge.Speaker() {
                public boolean available() { synchronized (lock) { return channel != null && boundEntity != null && !boundEntity.hasDisconnected(); } }
                public void sendFrame(short[] pcm) {
                    synchronized (lock) { if (channel != null && encoder != null) channel.send(encoder.encode(pcm)); }
                }
                public void flush() {
                    synchronized (lock) {
                        if (channel != null) channel.flush();
                        if (encoder != null) encoder.resetState();
                    }
                }
                public void setDistance(float dist) { synchronized (lock) { if (channel != null) channel.setDistance(dist); } }
            });
            try {
                b.start();
                WrenVoiceMod.bridge = b;
                WrenVoiceMod.LOG.info("wrenvoice: WebSocket listening on {}:{} (bot '{}', hearRadius {}, secret {})",
                        cfg.bindAddress, cfg.wsPort, cfg.botName, cfg.hearRadius, cfg.secret.isEmpty() ? "off" : "on");
            } catch (IOException ex) {
                WrenVoiceMod.LOG.error("wrenvoice: cannot bind WebSocket on 127.0.0.1:{}", cfg.wsPort, ex);
            }
        }
    }

    /**
     * Called every server tick (server thread). (Re)creates the entity audio channel when the bot player
     * instance or dimension changes (respawn, relog, dimension change), drops it when the bot is gone.
     */
    static void checkBotBinding(ServerPlayer bot, String dim) {
        VoicechatServerApi api = serverApi;
        if (api == null) return;
        synchronized (lock) {
            if (bot == null) {
                if (boundEntity != null) {
                    WrenVoiceMod.LOG.info("wrenvoice: bot left, channel dropped");
                    channel = null; boundEntity = null; boundDim = null;
                }
                return;
            }
            if (bot == boundEntity && dim.equals(boundDim) && channel != null) return;
            try {
                if (encoder == null) encoder = api.createEncoder();
                Entity ent = api.fromEntity(bot);
                EntityAudioChannel ch = api.createEntityAudioChannel(UUID.randomUUID(), ent);
                if (ch == null) { WrenVoiceMod.LOG.warn("wrenvoice: createEntityAudioChannel returned null"); return; }
                ch.setDistance((float) WrenVoiceMod.config.speakDistance);
                channel = ch; boundEntity = bot; boundDim = dim;
                if (encoder != null) encoder.resetState();
                WrenVoiceMod.LOG.info("wrenvoice: audio channel bound to bot '{}' in {}", WrenVoiceMod.config.botName, dim);
            } catch (RuntimeException ex) {
                WrenVoiceMod.LOG.error("wrenvoice: channel creation failed", ex);
            }
        }
    }
}
