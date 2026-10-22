package wren.wrenmap;

/** Where markers end up (BlueMap in production, a fake in tests). */
public interface MarkerSink {
    void put(String setId, String markerId, MarkerSpec spec);
    void remove(String setId, String markerId);
}
