package wren.wrenvoice;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PlayoutQueueTest {
    @Test void framesAndOrder() {
        PlayoutQueue q = new PlayoutQueue();
        short[] a = new short[960 * 3]; a[0] = 1; a[960] = 2; a[1920] = 3;
        assertEquals(a.length, q.add("u1", a));
        assertEquals(3, q.queuedFrames());
        assertEquals(1, q.poll().pcm()[0]);
        assertEquals(2, q.poll().pcm()[0]);
        assertEquals(3, q.poll().pcm()[0]);
        assertNull(q.poll());
        assertEquals(60, q.progress(false).get(0).msPlayed());
    }
    @Test void rejectsBadSize() {
        PlayoutQueue q = new PlayoutQueue();
        assertEquals(0, q.add("u", new short[961]));
        assertEquals(0, q.add("u", new short[0]));
    }
    @Test void twoSecondCap() {
        PlayoutQueue q = new PlayoutQueue();
        assertEquals(960 * 100, q.add("u", new short[960 * 100]));
        assertEquals(0, q.add("u", new short[960]));   // 2.02 s -> dropped
        q.poll();
        assertEquals(960, q.add("u", new short[960])); // room again
    }
    @Test void flushOneAndAll() {
        PlayoutQueue q = new PlayoutQueue();
        q.add("a", new short[960 * 2]); q.add("b", new short[960 * 2]);
        q.poll(); // a played 20 ms
        List<PlayoutQueue.Progress> p = q.flush("a");
        assertEquals(1, p.size());
        assertEquals("a", p.get(0).utt()); assertEquals(20, p.get(0).msPlayed()); assertFalse(p.get(0).done());
        assertEquals(2, q.queuedFrames());
        assertEquals("b", q.poll().utt());
        q.flush("*");
        assertEquals(0, q.queuedFrames());
        assertNull(q.poll());
    }
    @Test void doneWhenDrained() {
        PlayoutQueue q = new PlayoutQueue();
        q.add("a", new short[960]);
        assertFalse(q.progress(true).get(0).done());
        q.poll();
        var p = q.progress(true);
        assertTrue(p.get(0).done()); assertEquals(20, p.get(0).msPlayed());
        assertTrue(q.progress(true).isEmpty());
    }
    @Test void dropDoesNotCreditPlayed() {
        PlayoutQueue q = new PlayoutQueue();
        q.add("a", new short[960 * 2]);
        q.pollDrop();
        assertEquals(0, q.progress(false).get(0).msPlayed());
    }
}
