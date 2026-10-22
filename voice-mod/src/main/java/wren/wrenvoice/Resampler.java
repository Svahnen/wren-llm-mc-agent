package wren.wrenvoice;

/**
 * Stateful 48 kHz -> 16 kHz decimator (factor 3) with a windowed-sinc low-pass FIR
 * (cutoff 7.2 kHz, Blackman window, 97 taps). Feed it consecutive frames of one stream.
 * Output length is exactly input.length / 3 when the input length is a multiple of 3.
 */
public final class Resampler {
    public static final int FACTOR = 3;
    private static final int TAPS = 97;
    private static final double CUTOFF = 7200.0 / 48000.0; // cycles per input sample
    private static final double[] H = design();

    private final double[] hist = new double[TAPS - 1];
    private int phase = 0; // position within the decimation cycle, carried across calls

    private static double[] design() {
        double[] h = new double[TAPS];
        int m = TAPS - 1;
        double sum = 0;
        for (int n = 0; n < TAPS; n++) {
            double x = n - m / 2.0;
            double sinc = x == 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x);
            double w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / m) + 0.08 * Math.cos(4 * Math.PI * n / m);
            h[n] = sinc * w;
            sum += h[n];
        }
        for (int n = 0; n < TAPS; n++) h[n] /= sum; // unity DC gain
        return h;
    }

    public short[] process(short[] in) {
        int n = in.length;
        short[] out = new short[n <= phase ? 0 : (n - phase + FACTOR - 1) / FACTOR];
        int oi = 0;
        int hl = hist.length;
        for (int i = phase; i < n; i += FACTOR) {
            double acc = 0;
            // y[i] = sum_k h[k] * x[i-k]
            for (int k = 0; k < TAPS; k++) {
                int idx = i - k;
                double x = idx >= 0 ? in[idx] : hist[hl + idx];
                acc += H[k] * x;
            }
            long r = Math.round(acc);
            out[oi++] = (short) Math.max(-32768, Math.min(32767, r));
        }
        int next = phase;
        while (next < n) next += FACTOR;
        phase = next - n;
        // update history with last TAPS-1 samples
        if (n >= hl) {
            for (int i = 0; i < hl; i++) hist[i] = in[n - hl + i];
        } else {
            System.arraycopy(hist, n, hist, 0, hl - n);
            for (int i = 0; i < n; i++) hist[hl - n + i] = in[i];
        }
        return oi == out.length ? out : java.util.Arrays.copyOf(out, oi);
    }

    public void reset() {
        java.util.Arrays.fill(hist, 0);
        phase = 0;
    }
}
