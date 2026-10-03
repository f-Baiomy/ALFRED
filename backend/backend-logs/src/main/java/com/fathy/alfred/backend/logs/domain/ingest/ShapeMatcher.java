package com.fathy.alfred.backend.logs.domain.ingest;

import com.fathy.alfred.backend.logs.domain.model.LineShape;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Sorts lines into structures by the set of stored fields they carry. A line joins the existing
 * structure whose field set it shares most with, if they overlap by at least {@link #SAME_SHAPE}
 * (Jaccard), so one optional field does not make a new structure; otherwise it starts a new one.
 * Past {@link #MAX_SHAPES} every line joins its nearest structure. One instance per source, used by
 * the single ingest writer of that source.
 */
public final class ShapeMatcher {

    static final double SAME_SHAPE = 0.7;
    public static final int MAX_SHAPES = 100;
    /** Exact field sets remembered so the common case skips the comparison. */
    private static final int EXACT_CACHE = 10_000;

    private static final class Shape {
        final int id;
        final BitSet fields;
        final int size;
        long lines;
        final Map<Integer, Long> fieldCounts = new HashMap<>();

        Shape(int id, BitSet fields) {
            this.id = id;
            this.fields = fields;
            this.size = fields.cardinality();
        }
    }

    private final Map<Integer, Shape> shapes = new LinkedHashMap<>();
    private final Map<BitSet, Integer> exact = new HashMap<>();
    private final Set<Integer> changed = new LinkedHashSet<>();

    /** Continues from stored structures. */
    public ShapeMatcher(Collection<LineShape> stored) {
        for (LineShape s : stored) {
            BitSet b = new BitSet();
            s.fields().forEach(b::set);
            Shape sh = new Shape(s.id(), b);
            sh.lines = s.lineCount();
            sh.fieldCounts.putAll(s.fieldCounts());
            shapes.put(s.id(), sh);
        }
    }

    /** Assigns the line with these stored field indexes to a structure and counts it; returns its id. */
    public int assign(Collection<Integer> fieldIndexes) {
        BitSet b = new BitSet();
        fieldIndexes.forEach(b::set);
        Integer id = exact.get(b);
        Shape sh = id == null ? null : shapes.get(id);
        if (sh == null) {
            sh = nearest(b);
            if (sh == null) {
                int next = shapes.keySet().stream().mapToInt(Integer::intValue).max().orElse(0) + 1;
                sh = new Shape(next, b);
                shapes.put(next, sh);
            }
            if (exact.size() < EXACT_CACHE) {
                exact.put(b, sh.id);
            }
        }
        sh.lines++;
        for (Integer i : fieldIndexes) {
            sh.fieldCounts.merge(i, 1L, Long::sum);
        }
        changed.add(sh.id);
        return sh.id;
    }

    /** Best match at or above {@link #SAME_SHAPE}; past the cap, the best match whatever its overlap. */
    private Shape nearest(BitSet b) {
        Shape best = null;
        double bestScore = -1;
        int size = b.cardinality();
        for (Shape s : shapes.values()) {
            BitSet and = (BitSet) b.clone();
            and.and(s.fields);
            int common = and.cardinality();
            int union = size + s.size - common;
            double score = union == 0 ? 1 : common / (double) union;
            if (score > bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best != null && (bestScore >= SAME_SHAPE || shapes.size() >= MAX_SHAPES)) {
            return best;
        }
        return null;
    }

    /** Current totals of the structures changed since the last call (written with the batch). */
    public List<LineShape> drainChanged() {
        List<LineShape> out = new ArrayList<>();
        for (Integer id : changed) {
            out.add(snapshot(shapes.get(id)));
        }
        changed.clear();
        return out;
    }

    public List<LineShape> all() {
        return shapes.values().stream().map(ShapeMatcher::snapshot).toList();
    }

    private static LineShape snapshot(Shape s) {
        return new LineShape(s.id, null, null, s.fields.stream().boxed().toList(), s.lines, Map.copyOf(s.fieldCounts));
    }
}
