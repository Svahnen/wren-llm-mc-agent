package wren.wrenmap;

import java.util.UUID;

/** One living entity seen near a player. {@code name} is the custom name or null. */
public record MobSnapshot(UUID id, String type, String name, boolean hostile, Vec pos) {}
