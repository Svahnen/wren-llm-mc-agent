package wren.wrenvoice;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ResamplerTest {
    static short[] sine(double hz, int n, int off) {
        short[] s = new short[n];
        for (int i = 0; i < n; i++) s[i] = (short) Math.round(10000 * Math.sin(2 * Math.PI * hz * (i + off) / 48000.0));
        return s;
    }
    static double rms(short[] s, int from) {
        double a = 0; int c = 0;
        for (int i = from; i < s.length; i++) { a += (double) s[i] * s[i]; c++; }
        return Math.sqrt(a / c);
    }
    @Test void frameLength() {
        Resampler r = new Resampler();
        for (int f = 0; f < 5; f++) assertEquals(320, r.process(sine(440, 960, f * 960)).length);
    }
    @Test void passbandKeptStopbandKilled() {
        Resampler r = new Resampler();
        short[] pass = new short[0], stop = new short[0];
        Resampler r2 = new Resampler();
        java.io.ByteArrayOutputStream dummy = null;
        short[] outP = new short[320 * 20], outS = new short[320 * 20];
        for (int f = 0; f < 20; f++) {
            System.arraycopy(r.process(sine(1000, 960, f * 960)), 0, outP, f * 320, 320);
            System.arraycopy(r2.process(sine(12000, 960, f * 960)), 0, outS, f * 320, 320);
        }
        double inRms = 10000 / Math.sqrt(2);
        assertEquals(inRms, rms(outP, 320), inRms * 0.03);
        assertTrue(rms(outS, 320) < inRms * 0.01, "12 kHz must be removed (alias would land at 4 kHz)");
    }
    @Test void odd_chunking_is_seamless() {
        short[] x = sine(700, 960 * 4, 0);
        Resampler a = new Resampler(), b = new Resampler();
        short[] whole = a.process(x);
        java.util.ArrayList<Short> parts = new java.util.ArrayList<>();
        int[] cuts = {0, 100, 1001, 2000, 3840};
        for (int i = 0; i + 1 < cuts.length; i++) {
            short[] seg = java.util.Arrays.copyOfRange(x, cuts[i], cuts[i + 1]);
            for (short s : b.process(seg)) parts.add(s);
        }
        assertEquals(whole.length, parts.size());
        for (int i = 0; i < whole.length; i++) assertEquals(whole[i], parts.get(i).shortValue());
    }
}
