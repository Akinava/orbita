"""Shared world simulated on the server: stations (bases), pirate zones, pirates and asteroid damage.

Ported from the client's former single-player code (static/js/combat.js, world.js): the same zones,
steering and gunnery, but each pirate now goes after the nearest player in reach of its zone.
What a map has depends on its type (app/modes.py): pirates on "farm" only, asteroid belts everywhere
(the server places every asteroid and moves the destroyed ones; the clients only draw them); the team
types have a base per team, and on "station" the bases can be shot down (BASE_* below).
Coordinates are world space, metres; ships fly along their local -Z ("forward").
"""

import math
import random

STATION_SIZE = 500.0
# Destructible bases ("station" maps): hit points, regeneration after a quiet spell, and the time a
# destroyed base stays gone before it is rebuilt
BASE_HP = 1800  # 300 laser hits of LASER_DAMAGE (app/room.py)
BASE_REGEN_DELAY = 10.0  # seconds without hits before a damaged base starts repairing itself
BASE_REGEN = 30.0  # hit points per second
BASE_RESPAWN = 30.0  # seconds

ZONE_COUNT = 5
ZONE_LEASH = 2.2  # pursuit continues until the player is this many zone radii from the centre
ZONE_REFILL = 45.0  # seconds per replacement pirate once nobody is near the zone
PATROL_SPEED = 150.0
PIRATE_HP = 6
BOLT_SPEED = 1100.0
TURN_RATE = 1.1  # rad/s

ASTEROID_MAX_HP = 14
# Kept clear of asteroids: around a station, the lane to its docking slot, and the free-for-all start
CLEAR_STATION = 1000.0
CLEAR_LANE = (3500.0, 600.0)  # length from the station along the slot's direction, half-width
CLEAR_START = 500.0

MODES = {"patrol": 0, "attack": 1, "evade": 2}


# --- small vector helpers (3-tuples) ------------------------------------------------------------
def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(dot(a, a))


def dist(a, b):
    return length(sub(a, b))


def norm(a):
    n = length(a)
    return scale(a, 1 / n) if n > 1e-9 else (0.0, 0.0, -1.0)


def random_unit():
    u = random.uniform(-1, 1)
    th = random.uniform(0, 2 * math.pi)
    r = math.sqrt(1 - u * u)
    return (r * math.cos(th), u, r * math.sin(th))


def look_quaternion(fwd, up):
    """Quaternion (x, y, z, w) turning local -Z to `fwd` with local +Y towards `up` (three.js lookAt)."""
    z = norm(scale(fwd, -1))
    x = cross(up, z)
    if length(x) < 1e-6:
        x = cross((0.0, 0.0, 1.0) if abs(z[1]) > 0.9 else (0.0, 1.0, 0.0), z)
    x = norm(x)
    y = cross(z, x)
    m11, m12, m13 = x[0], y[0], z[0]
    m21, m22, m23 = x[1], y[1], z[1]
    m31, m32, m33 = x[2], y[2], z[2]
    trace = m11 + m22 + m33
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1.0)
        return ((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
    if m11 > m22 and m11 > m33:
        s = 2.0 * math.sqrt(1.0 + m11 - m22 - m33)
        return (0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
    if m22 > m33:
        s = 2.0 * math.sqrt(1.0 + m22 - m11 - m33)
        return ((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
    s = 2.0 * math.sqrt(1.0 + m33 - m11 - m22)
    return ((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)


# --- world -----------------------------------------------------------------------------------------
class Station:
    """A station: repairs pilots who dock (on team maps only its own team), and on "station" maps it
    can be destroyed. `yaw` turns its docking slot (local +Z) to face the middle of the map."""

    def __init__(self, sid, pos, team, yaw):
        self.id = sid
        self.pos = pos
        self.team = team
        self.yaw = yaw
        self.hp = BASE_HP
        self.alive = True
        self.quiet = 0.0  # seconds since the last hit
        self.respawn_t = 0.0

    def public(self):
        return {"id": self.id, "p": list(self.pos), "team": self.team, "yaw": self.yaw}

    def state(self):
        return [round(self.hp / BASE_HP, 3), self.alive]


class Zone:
    def __init__(self, zid, center, radius):
        self.id = zid
        self.center = center
        self.radius = radius
        self.size = random.randint(2, 4)
        self.hostile = False
        self.provoked = False
        self.refill_t = 0.0

    def random_point(self):
        d = random.random() ** (1 / 3) * self.radius * 0.8
        p = scale(random_unit(), d)
        return add((p[0], p[1] * 0.4, p[2]), self.center)

    def public(self):
        return {"id": self.id, "c": [round(x, 1) for x in self.center], "r": round(self.radius, 1)}


class Pirate:
    def __init__(self, pid, zone):
        self.id = pid
        self.zone = zone
        self.pos = zone.random_point()
        self.waypoint = zone.random_point()
        self.fwd = norm(sub(self.waypoint, self.pos))
        self.up = (0.0, 1.0, 0.0)
        self.mode = "patrol"
        self.mode_t = 0.0
        self.cooldown = random.uniform(1.5, 3.5)
        self.evade_dir = (0.0, 0.0, -1.0)
        self.skill = random.uniform(0.6, 1.0)
        self.hp = PIRATE_HP

    def public(self):
        q = look_quaternion(self.fwd, self.up)
        return {
            "id": self.id,
            "z": self.zone.id,
            "p": [round(x, 2) for x in self.pos],
            "q": [round(x, 4) for x in q],
            "m": MODES[self.mode],
        }


def make_zones(stations):
    """Pirate lairs scattered at random, away from the start point, the stations and each other."""
    zones = []
    for _ in range(500):
        if len(zones) >= ZONE_COUNT:
            break
        radius = random.uniform(1400, 2300)
        c = scale(random_unit(), random.uniform(5000, 14000))
        center = (c[0], c[1] * 0.3, c[2])
        if any(dist(center, s.pos) < radius + STATION_SIZE + 2000 for s in stations):
            continue
        if any(dist(z.center, center) < z.radius + radius + 1500 for z in zones):
            continue
        zones.append(Zone(len(zones), center, radius))
    return zones


class World:
    def __init__(self, mode):
        self.mode = mode
        self.stations = [
            Station(i, pos, team, 0.0 if pos[2] <= 0 else math.pi) for i, (pos, team) in enumerate(mode.stations)
        ]
        self.zones = make_zones(self.stations) if mode.pirates else []
        self.pirates: dict[int, Pirate] = {}
        self.next_id = 1
        self.asteroid_hp: dict[int, int] = {}  # damaged asteroids only
        # Asteroid index -> its belt, and where each one is now
        self.asteroid_belt = [b for b in mode.belts for _ in range(b.count)]
        self.asteroids = [self.asteroid_spot(b, None) for b in self.asteroid_belt]
        for z in self.zones:
            for _ in range(z.size):
                self.spawn(z)

    def spawn(self, zone):
        p = Pirate(self.next_id, zone)
        self.next_id += 1
        self.pirates[p.id] = p
        return p

    def count(self, zone):
        return sum(1 for p in self.pirates.values() if p.zone is zone)

    def welcome(self):
        return {
            "zones": [z.public() for z in self.zones],
            "asteroids": [[round(x, 1) for x in p] for p in self.asteroids],
            "stations": [s.public() for s in self.stations],
        }

    def snapshot(self):
        """The map-wide part of a snapshot; the pirates go to each player separately (Room.step)."""
        snap = {"zones": [z.hostile for z in self.zones]}
        if self.mode.destructible:
            snap["bases"] = [s.state() for s in self.stations]
        return snap

    def reset_bases(self):
        for s in self.stations:
            s.hp, s.alive, s.quiet, s.respawn_t = BASE_HP, True, 0.0, 0.0

    def hit_base(self, sid, damage):
        """Damage to a destructible base; returns it if this hit destroyed it."""
        s = self.stations[sid] if 0 <= sid < len(self.stations) else None
        if not s or not s.alive or not self.mode.destructible:
            return None
        s.hp -= damage
        s.quiet = 0.0
        if s.hp > 0:
            return None
        s.hp, s.alive, s.respawn_t = 0, False, BASE_RESPAWN
        return s

    def step_bases(self, dt):
        """Repair and rebuild destructible bases; returns the ids of those rebuilt in this step."""
        rebuilt = []
        for s in self.stations:
            if not s.alive:
                s.respawn_t -= dt
                if s.respawn_t <= 0:
                    s.hp, s.alive, s.quiet = BASE_HP, True, 0.0
                    rebuilt.append(s.id)
            elif s.hp < BASE_HP:
                s.quiet += dt
                if s.quiet >= BASE_REGEN_DELAY:
                    s.hp = min(BASE_HP, s.hp + BASE_REGEN * dt)
        return rebuilt

    # --- damage ---------------------------------------------------------------------------------
    def hit_pirate(self, pid):
        """One laser hit; returns the pirate if it was destroyed by it."""
        p = self.pirates.get(pid)
        if not p:
            return None
        p.zone.provoked = True  # sniping from outside the zone still draws the pack
        p.hp -= 1
        if p.hp > 0:
            return None
        del self.pirates[pid]
        return p

    def ram_pirate(self, pid):
        return self.pirates.pop(pid, None)

    def hit_asteroid(self, index, max_hp, avoid):
        """One laser hit on asteroid `index`; returns its new position if it was destroyed."""
        hp = self.asteroid_hp.get(index, max(1, min(ASTEROID_MAX_HP, int(max_hp)))) - 1
        if hp > 0:
            self.asteroid_hp[index] = hp
            return None
        self.asteroid_hp.pop(index, None)
        pos = self.asteroids[index] = self.asteroid_spot(self.asteroid_belt[index], avoid)
        return pos

    def asteroid_spot(self, belt, avoid):
        """Random point in `belt`, clear of the stations and their lanes, the start and `avoid`."""
        p = belt.center
        for _ in range(30):
            d = (belt.inner ** 3 + random.random() * (belt.outer ** 3 - belt.inner ** 3)) ** (1 / 3)
            u = random_unit()
            p = add((u[0] * d, u[1] * d * belt.flat, u[2] * d), belt.center)
            if not self.clear(p) or (avoid and dist(p, avoid) < 1500):
                continue
            break
        return p

    def clear(self, p):
        """Whether an asteroid may stand at p."""
        if not self.mode.teams and length(p) < CLEAR_START:
            return False
        lane, half = CLEAR_LANE
        for s in self.stations:
            rel = sub(p, s.pos)
            if length(rel) < CLEAR_STATION:
                return False
            along = dot(rel, (math.sin(s.yaw), 0.0, math.cos(s.yaw)))  # the slot faces local +Z
            if 0 < along < lane and length(sub(rel, scale((math.sin(s.yaw), 0.0, math.cos(s.yaw)), along))) < half:
                return False
        return True

    # --- simulation -------------------------------------------------------------------------------
    def step(self, dt, players, fire):
        """Advance by dt. `players`: active (pos, vel) pairs. `fire(origin, dir)` emits a pirate bolt."""
        for z in self.zones:
            d = min((dist(pos, z.center) for pos, _ in players), default=math.inf)
            z.hostile = d < z.radius or ((z.hostile or z.provoked) and d < z.radius * ZONE_LEASH)
            z.provoked = False
            # Slowly restaff a zone nobody is near
            if self.count(z) < z.size and d > z.radius * 1.5:
                z.refill_t += dt
                if z.refill_t >= ZONE_REFILL:
                    z.refill_t = 0.0
                    self.spawn(z)
            else:
                z.refill_t = 0.0

        for p in self.pirates.values():
            self.steer(p, dt, players, fire)

    def steer(self, p, dt, players, fire):
        p.cooldown -= dt
        p.mode_t -= dt
        z = p.zone
        # Target: the nearest player still within the zone's leash
        target, tdist = None, math.inf
        if z.hostile:
            for pos, vel in players:
                if dist(pos, z.center) < z.radius * ZONE_LEASH:
                    d = dist(pos, p.pos)
                    if d < tdist:
                        target, tdist = (pos, vel), d
        if target is None and p.mode != "patrol":
            p.mode = "patrol"
        elif target is not None and p.mode == "patrol":
            p.mode = "attack"

        if p.mode == "patrol":
            if dist(p.pos, p.waypoint) < 150:
                p.waypoint = z.random_point()
            desired = norm(sub(p.waypoint, p.pos))
        elif p.mode == "attack":
            tpos, tvel = target
            lead = tdist / BOLT_SPEED
            desired = norm(sub(add(tpos, scale(tvel, lead * p.skill)), p.pos))
            if tdist < 260:
                p.mode = "evade"
                p.mode_t = random.uniform(2.5, 4.5)
                p.evade_dir = norm(add(random_unit(), scale(norm(sub(p.pos, tpos)), 1.2)))
        else:
            desired = p.evade_dir
            if p.mode_t <= 0:
                p.mode = "attack"

        # Steer away from station hulls
        for s in self.stations:
            if dist(p.pos, s.pos) < STATION_SIZE * 1.6:
                desired = norm(add(desired, scale(norm(sub(p.pos, s.pos)), 2)))

        # Turn towards `desired` at a limited rate
        angle = math.acos(max(-1.0, min(1.0, dot(p.fwd, desired))))
        if angle > 1e-4:
            k = min(1.0, TURN_RATE * dt / angle)
            p.fwd = norm(add(scale(p.fwd, 1 - k), scale(desired, k)))
        p.up = norm(sub(p.up, scale(p.fwd, dot(p.up, p.fwd))))

        if p.mode == "patrol":
            speed = PATROL_SPEED
        elif p.mode == "attack":
            speed = 380 if tdist > 1500 else 230
        else:
            speed = 330
        p.pos = add(p.pos, scale(p.fwd, speed * dt))

        if p.mode == "attack" and tdist < 1900 and angle < 0.12 and p.cooldown <= 0:
            p.cooldown = random.uniform(0.5, 1.4)
            spread = 0.035 * (1.5 - p.skill)
            direction = norm(add(desired, scale(random_unit(), spread)))
            fire(add(p.pos, scale(p.fwd, 26)), direction)
