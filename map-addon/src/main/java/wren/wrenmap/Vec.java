package wren.wrenmap;

/** A rounded 3D point (0.1 block resolution, so tiny jitter does not cause marker updates). */
public record Vec(double x, double y, double z) {
    public static Vec of(double x, double y, double z) {
        return new Vec(r(x), r(y), r(z));
    }
    private static double r(double v) { return Math.round(v * 10.0) / 10.0; }
    public double dist2(Vec o) {
        double dx = x - o.x, dy = y - o.y, dz = z - o.z;
        return dx * dx + dy * dy + dz * dz;
    }
}
