#!/usr/bin/env python3
"""Generates Minecraft console commands for the trap map from traps.json (stdlib only).
Usage: trapgen.py build <name|all> | verify <name|all> TOKEN | start <name> | names | region
Every coordinate is bounds-checked against the documented region/cell before it is emitted."""
import json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, "traps.json")))
OX, OZ, FY = D["origin"]["x"], D["origin"]["z"], D["origin"]["floor_y"]
S, COLS, ROWS = D["cell"]["size"], D["cell"]["cols"], D["cell"]["rows"]
FD, CH, WH = D["cell"]["floor_depth"], D["cell"]["clear_height"], D["cell"]["wall_height"]
TRAPS = {t["name"]: t for t in D["traps"]}
REGION = (OX, OZ, OX + COLS * S - 1, OZ + ROWS * S - 1)
YMIN, YMAX = FY - FD, FY + CH

def cell_origin(t):
    return OX + t["col"] * S, OZ + t["row"] * S

def pick(arg):
    if arg == "all":
        return list(TRAPS.values())
    if arg not in TRAPS:
        sys.exit("unknown trap '%s'; known: %s" % (arg, " ".join(TRAPS)))
    return [TRAPS[arg]]

def thrash_blocks(cfg):
    r = random.Random(cfg["seed"])
    x1, z1, x2, z2 = cfg["area"]
    kinds = ["minecraft:oak_fence", "minecraft:cobblestone_wall", "minecraft:oak_slab[type=bottom]",
             "minecraft:oak_slab[type=top]", "minecraft:stone_brick_stairs[facing=%s,half=bottom]",
             "minecraft:stone_brick_stairs[facing=%s,half=top]", "minecraft:glass_pane",
             "minecraft:oak_fence_gate[facing=%s,open=false]", "minecraft:iron_bars",
             "minecraft:oak_trapdoor[half=bottom,open=true,facing=%s]"]
    out = []
    for x in range(x1, x2 + 1):
        for z in range(z1, z2 + 1):
            if [x, z] in cfg["keep_clear"]:
                continue
            if r.random() < cfg["density"]:
                k = r.choice(kinds)
                if "%s" in k:
                    k = k % r.choice(["north", "south", "east", "west"])
                out.append(((x, cfg["y"], z), k))
    return out

class Cell:
    """Command emitter + expected-block simulator for one cell (local coords)."""
    def __init__(self, t):
        self.t = t; self.cx, self.cz = cell_origin(t); self.cmds = []; self.exp = {}; self.key = set(); self.base = True
    def _chk(self, x, y, z):
        assert 0 <= x < S and 0 <= z < S, "x/z outside cell in %s: %s,%s" % (self.t["name"], x, z)
        assert YMIN <= FY + y <= YMAX, "y outside region in %s: %s" % (self.t["name"], y)
    def fill(self, x1, y1, z1, x2, y2, z2, b):
        x1, x2 = sorted((x1, x2)); y1, y2 = sorted((y1, y2)); z1, z2 = sorted((z1, z2))
        self._chk(x1, y1, z1); self._chk(x2, y2, z2)
        n = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1); assert n <= 32768
        self.cmds.append("fill %d %d %d %d %d %d %s" % (self.cx + x1, FY + y1, self.cz + z1,
                                                      self.cx + x2, FY + y2, self.cz + z2, b))
        for x in range(x1, x2 + 1):
            for y in range(y1, y2 + 1):
                for z in range(z1, z2 + 1):
                    self.exp[(x, y, z)] = b
                    if not self.base: self.key.add((x, y, z))
    def set(self, x, y, z, b):
        self._chk(x, y, z)
        self.cmds.append("setblock %d %d %d %s" % (self.cx + x, FY + y, self.cz + z, b))
        self.exp[(x, y, z)] = b
        self.key.add((x, y, z))

def build_cell(t):
    c = Cell(t)
    c.fill(0, -FD, 0, S - 1, 0, S - 1, "minecraft:stone")            # floor slab (also wipes old liquids)
    c.fill(0, 1, 0, S - 1, CH, S - 1, "minecraft:air")               # clear air volume
    for a in ((0, 1, 0, S - 1, WH, 0), (0, 1, S - 1, S - 1, WH, S - 1),
              (0, 1, 0, 0, WH, S - 1), (S - 1, 1, 0, S - 1, WH, S - 1)):
        c.fill(*a, "minecraft:stone")                                # perimeter wall
    c.base = False
    for op in t["ops"]:
        if "fill" in op: c.fill(*op["fill"], op["block"])
        elif "set" in op: c.set(*op["set"], op["block"])
        elif "thrash" in op:
            for (p, b) in thrash_blocks(op["thrash"]): c.set(*p, b)
        else: sys.exit("bad op %r" % op)
    return c

def start_xyz(t):
    cx, cz = cell_origin(t); s = t["start"]
    return cx + s["x"], FY + s["y"], cz + s["z"], s.get("yaw", 0)

def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    if a[0] == "names": print(" ".join(TRAPS))
    elif a[0] == "region":
        print("%d %d %d %d" % REGION)
    elif a[0] == "start":
        x, y, z, yaw = start_xyz(pick(a[1])[0]); print("%s %s %s %s" % (x, y, z, yaw))
    elif a[0] == "build":
        for t in pick(a[1]):
            c = build_cell(t)
            for line in c.cmds: print(line)
    elif a[0] == "verify":
        token = a[2]
        for t in pick(a[1]):
            c = build_cell(t)
            # every position written by the trap's own ops (final value), plus a strided sample of the base (floor/air/walls)
            items = sorted(c.exp.items())
            base = [kv for kv in items if kv[0] not in c.key][::97]
            sample = [(k, c.exp[k]) for k in sorted(c.key)] + base
            for (x, y, z), b in sample:
                bid = b.split("[")[0]
                print("execute unless block %d %d %d %s run say %s FAIL %s %d %d %d expected %s" % (
                    c.cx + x, FY + y, c.cz + z, bid, token, t["name"], c.cx + x, FY + y, c.cz + z, bid))
            print("say %s DONE %s %d" % (token, t["name"], len(sample)))
main()
