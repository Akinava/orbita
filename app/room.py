"""One map: its pilots, its world (app/game.py) and, on team maps, its teams and rounds (app/modes.py).

On each map the clients report their own ship state; the room simulates its shared world, sends its
players snapshots and passes shots, hits and kills around. Laser hits are detected by the shooter and
sanity-checked here, including the map type's rules (who may shoot whom, and when); a kill goes to
the last shooter.
Area of interest: a pilot's snapshots carry only the ships and pirates near it, and only nearby shots
and pirate bolts are passed to it, so the traffic does not grow with the square of the map's
population. The map's full list of pilots (names, teams, voice chat) goes out separately as a "roster"
when it changes.
"""

import asyncio
import json
import logging
import math
import random
import time

from fastapi import WebSocket

from app import auth, metrics, stats
from app.game import STATION_SIZE, World
from app.modes import BASE_LIMIT, BASE_SCORE, COUNTDOWN, KILL_SCORE, ROUND_TIME, TEAM_MAX, TEAMS, Mode

LASER_DAMAGE = 6
LASER_RANGE = 4500  # a bit over the client's 4000 to allow for latency
RAM_RANGE = 150  # pirate-to-ship distance accepted for a ram, with latency slack
MIN_HIT_INTERVAL = 0.1  # the client fires every 0.14 s
NAME_MAX = 16
RTC_MAX = 16000  # bytes of WebRTC signalling (SDP or ICE candidate) relayed per message
INTEREST_RADIUS = 6000  # other ships, pirates, shots and pirate bolts are sent within this distance
INTEREST_KEEP = 7000  # a ship or pirate already seen is kept up to this distance: no flicker at the edge
MATCH_INTERVAL = 1.0  # seconds between match updates (the clock) on team maps
# Statistics (app/stats.py): flight time from the state reports, kills as the server settles them. A
# pilot's death is credited to another only if that one hit them within KILL_CREDIT_TIME, so nobody can
# hand out victories by crashing on purpose.
KILL_CREDIT_TIME = 10  # seconds, as on the client
FLIGHT_GAP = 2  # seconds: longer gaps between state reports do not count as flight time
log = logging.getLogger("orbita.game")


def _vec(value, size):
    """A list of `size` finite floats, or None."""
    if not isinstance(value, list) or len(value) != size:
        return None
    try:
        out = [float(x) for x in value]
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(x) for x in out) else None


class Player:
    def __init__(self, pid: int, ws: WebSocket, key: str):
        self.id = pid
        self.ws = ws
        self.name = f"Pilot-{pid}"
        self.account: int | None = None  # users.id when signed in
        self.account_name: str | None = None
        self.key = key
        self.hit_by: dict[int, float] = {}  # attacker id -> when they last hit us
        self.pos = [0.0, 0.0, 0.0]
        self.quat = [0.0, 0.0, 0.0, 1.0]
        self.vel = (0.0, 0.0, 0.0)  # estimated from successive reports, for pirate gunnery
        self.reported = 0.0
        self.active = False  # alive, playing and not docked: visible and hittable
        self.voice = False  # takes part in voice chat
        self.talking = False
        self.last_hit = 0.0
        self.sees: set[int] = set()  # ids of the players within the area of interest
        self.sees_pirates: set[int] = set()  # ids of the pirates within it
        self.team: int | None = None  # team maps
        self.ready = False  # team maps, between rounds
        # The pilot's own numbers for the info panel: all-time on "farm" (loaded at join), on this map
        # on "pvp", in the current round on team maps; sent to the pilot when they change
        self.score = 0
        self.wins = 0
        self.score_changed = True

    def report(self, pos, quat, active):
        now = time.monotonic()
        dt = now - self.reported
        if self.active and active and 0 < dt < FLIGHT_GAP:
            stats.add(self.account, "flight_seconds", dt)
        if self.active and active and 0 < dt < 1:
            v = tuple((a - b) / dt for a, b in zip(pos, self.pos))
            self.vel = tuple(0.7 * o + 0.3 * n for o, n in zip(self.vel, v))
        elif not active:
            self.vel = (0.0, 0.0, 0.0)
        self.pos, self.quat, self.active, self.reported = pos, quat, active, now

    def may_hit(self):
        """Rate limit for reported laser hits of any kind."""
        now = time.monotonic()
        if not self.active or now - self.last_hit < MIN_HIT_INTERVAL:
            return False
        self.last_hit = now
        return True

    def gain(self, score, wins=0):
        self.score += score
        self.wins += wins
        self.score_changed = True

    def public(self):
        out = {
            "id": self.id, "name": self.name, "p": self.pos, "q": self.quat, "a": self.active,
            "v": self.voice, "t": self.talking,
        }
        if self.team is not None:
            out["tm"] = self.team
        return out


class Room:
    """One map: its players, its own world and, on team maps, the round."""

    def __init__(self, map_id: str, mode: Mode, name: str, private: bool):
        self.id = map_id
        self.mode = mode
        self.name = name  # who created it
        self.private = private  # not listed; joined by its link
        self.players: dict[int, Player] = {}
        self.world = World(mode)
        self.roster_changed = False
        self.empty_since = time.monotonic()  # app/main.py closes maps left empty for a while
        # Team maps: "lobby" (between rounds, waiting for everyone to be ready) -> "countdown" -> "round"
        self.phase = "lobby"
        self.left = 0.0  # seconds left of the countdown or the round
        self.team_score = [0] * TEAMS
        self.lost = [0] * TEAMS  # bases destroyed this round, by owner team ("station")
        self.result = None  # how the last round ended
        self.match_changed = False
        self.match_clock = 0.0

    def info(self):
        """The map as listed in the menu."""
        return {
            "id": self.id, "type": self.mode.id, "name": self.name, "players": len(self.players),
            "max": self.mode.max_players, "private": self.private, "phase": self.phase if self.mode.teams else None,
        }

    @property
    def full(self):
        return len(self.players) >= self.mode.max_players

    # --- sending ----------------------------------------------------------------------------------
    async def send(self, player: Player, msg: dict):
        try:
            text = json.dumps(msg)
            await player.ws.send_text(text)
            metrics.sent(len(text))  # json.dumps writes ASCII: a character is a byte
        except Exception:
            pass  # the receive loop notices the disconnect and cleans up

    async def deliver(self, texts):
        """Send each (player, text) pair at once."""

        async def one(p, text):
            try:
                await p.ws.send_text(text)
                metrics.sent(len(text))
            except Exception:
                pass

        await asyncio.gather(*(one(p, text) for p, text in texts))

    async def broadcast(self, msg: dict, exclude: int | None = None, targets=None):
        """Send `msg` to `targets` (default: everyone on the map) except the player `exclude`."""
        text = json.dumps(msg)
        targets = self.players.values() if targets is None else targets
        await self.deliver([(p, text) for p in targets if p.id != exclude])

    # --- joining and leaving ----------------------------------------------------------------------
    def join(self, player: Player):
        if self.mode.teams:
            counts = self.team_counts()
            player.team = min(range(TEAMS), key=lambda t: (counts[t], random.random()))
        self.players[player.id] = player
        self.roster_changed = True

    def leave(self, player: Player):
        self.players.pop(player.id, None)
        for p in self.players.values():
            p.sees.discard(player.id)
        self.roster_changed = True
        if not self.players:
            self.empty_since = time.monotonic()

    def welcome(self, player: Player):
        return {
            "type": "welcome", "id": player.id, "map": self.info(), "team": player.team,
            "match": self.match_state(), **self.world.welcome(),
        }

    # --- rules ------------------------------------------------------------------------------------
    def team_counts(self):
        counts = [0] * TEAMS
        for p in self.players.values():
            if p.team is not None:
                counts[p.team] += 1
        return counts

    def firing(self):
        """Weapons are live: always on free-for-all maps, during a round on team maps."""
        return not self.mode.teams or self.phase == "round"

    def may_hit(self, shooter: Player, target: Player):
        return self.mode.pvp and self.firing() and (not self.mode.teams or shooter.team != target.team)

    def team_voice(self):
        """Voice chat is split by team: during a round on team maps (between rounds everyone talks)."""
        return self.mode.teams and self.phase == "round"

    # --- the round (team maps) --------------------------------------------------------------------
    def match_state(self):
        if not self.mode.teams:
            return None
        return {
            "phase": self.phase, "left": round(self.left, 1), "score": self.team_score, "lost": self.lost,
            "result": self.result,
        }

    def can_start(self):
        """Everyone on the map is ready and each team has someone."""
        players = self.players.values()
        return bool(players) and all(p.ready for p in players) and all(self.team_counts())

    async def step_match(self, dt):
        if self.phase == "lobby":
            if self.can_start():
                self.phase, self.left, self.match_changed = "countdown", COUNTDOWN, True
        elif self.phase == "countdown":
            if not self.can_start():
                self.phase, self.left, self.match_changed = "lobby", 0.0, True
            else:
                self.left -= dt
                if self.left <= 0:
                    await self.start_round()
        else:
            self.left -= dt
            if self.left <= 0:
                await self.end_round("time")
        self.match_clock += dt
        if self.match_clock >= MATCH_INTERVAL or self.match_changed:
            self.match_clock = 0.0
            self.match_changed = False
            await self.broadcast({"type": "match", **self.match_state()})

    async def start_round(self):
        self.phase, self.left = "round", ROUND_TIME
        self.team_score, self.lost, self.result = [0] * TEAMS, [0] * TEAMS, None
        self.world.reset_bases()
        for p in self.players.values():
            p.ready = False
            p.score = p.wins = 0
            p.score_changed = True
            p.hit_by.clear()
        self.roster_changed = self.match_changed = True
        await self.broadcast({"type": "round"})  # the clients start everyone at their base

    async def end_round(self, reason, winner=None):
        if winner is None and self.team_score[0] != self.team_score[1]:
            winner = 0 if self.team_score[0] > self.team_score[1] else 1
        self.phase, self.left = "lobby", 0.0
        self.result = {"winner": winner, "reason": reason, "score": self.team_score, "lost": self.lost}
        for p in self.players.values():
            p.ready = False
        self.roster_changed = self.match_changed = True
        await self.broadcast({"type": "roundEnd", **self.result})

    # --- simulation -------------------------------------------------------------------------------
    async def step(self, dt):
        """Advance the world and send each player a snapshot of what is near it."""
        bolts = []
        active = [(tuple(p.pos), p.vel) for p in self.players.values() if p.active]
        self.world.step(dt, active, lambda origin, direction: bolts.append((origin, direction)))
        rebuilt = self.world.step_bases(dt) if self.mode.destructible else []
        if not self.players:
            return
        for sid in rebuilt:
            await self.broadcast({"type": "base", "id": sid, "alive": True})
        if self.mode.teams:
            await self.step_match(dt)
        if self.roster_changed:
            self.roster_changed = False
            await self.broadcast({
                "type": "roster",
                "players": [
                    {"id": p.id, "name": p.name, "v": p.voice, "tm": p.team, "r": p.ready} for p in self.players.values()
                ],
            })
        for p in self.players.values():
            if p.score_changed:
                p.score_changed = False
                await self.send(p, {"type": "score", "score": p.score, "wins": p.wins})
        for origin, direction in bolts:
            await self.broadcast({
                "type": "bolt",
                "from": [round(x, 2) for x in origin],
                "dir": [round(x, 4) for x in direction],
            }, targets=self.nearby(origin))
        # Each ship and the world are serialised once and the per-player snapshots assembled from them
        self.update_interest()
        ships = {p.id: json.dumps(p.public()) for p in self.players.values()}
        pirates = [(e.id, e.pos, json.dumps(e.public())) for e in self.world.pirates.values()]
        world = json.dumps(self.world.snapshot())[1:]  # '"zones": [...]}'
        await self.deliver([
            (p, '{"type": "snap", "players": [' + ", ".join(ships[i] for i in p.sees) + '], "pirates": ['
             + ", ".join(self.pirates_near(p, pirates)) + "], " + world)
            for p in self.players.values()
        ])

    def update_interest(self):
        """Refresh who sees whom: pairs within INTEREST_RADIUS, kept up to INTEREST_KEEP."""
        players = list(self.players.values())
        for i, a in enumerate(players):
            for b in players[i + 1:]:
                if math.dist(a.pos, b.pos) < (INTEREST_KEEP if b.id in a.sees else INTEREST_RADIUS):
                    a.sees.add(b.id)
                    b.sees.add(a.id)
                else:
                    a.sees.discard(b.id)
                    b.sees.discard(a.id)

    def pirates_near(self, player, pirates):
        """The serialised pirates `player` sees, with the same radii as the ships; refreshes its set."""
        seen, out = set(), []
        for pid, pos, text in pirates:
            if math.dist(player.pos, pos) < (INTEREST_KEEP if pid in player.sees_pirates else INTEREST_RADIUS):
                seen.add(pid)
                out.append(text)
        player.sees_pirates = seen
        return out

    def nearby(self, pos):
        return [p for p in self.players.values() if math.dist(p.pos, pos) <= INTEREST_RADIUS]

    # --- messages from a pilot --------------------------------------------------------------------
    async def handle(self, player: Player, msg: dict):
        kind = msg.get("type")
        if kind == "hello":
            taken = False
            if player.account_name:
                player.name = player.account_name
            else:
                name = " ".join(str(msg.get("name") or "").split())[:NAME_MAX]
                try:
                    taken = bool(name) and await auth.name_reserved(name)
                except Exception:
                    log.exception("name check failed")  # the database is down: let the guest keep it
                if name and not taken:
                    player.name = name
            await self.send(player, {"type": "you", "name": player.name, "account": player.account is not None, "taken": taken})
            self.roster_changed = True
            await self.broadcast({"type": "join", "id": player.id, "name": player.name}, exclude=player.id)
        elif kind == "state":
            pos, quat = _vec(msg.get("p"), 3), _vec(msg.get("q"), 4)
            if pos and quat:
                player.report(pos, quat, bool(msg.get("a")))
            voice = bool(msg.get("v"))
            if voice != player.voice:
                player.voice = voice
                self.roster_changed = True
            player.talking = player.voice and bool(msg.get("t"))
        elif kind == "rtc":
            # Voice chat signalling between two pilots on this map; during a round on a team map only
            # within a team
            target = self.players.get(msg.get("to"))
            data = msg.get("data")
            if (target and target is not player and isinstance(data, dict) and len(json.dumps(data)) <= RTC_MAX
                    and (not self.team_voice() or target.team == player.team)):
                await self.send(target, {"type": "rtc", "from": player.id, "data": data})
        elif kind == "ready":
            if self.mode.teams and self.phase != "round":
                player.ready = bool(msg.get("on"))
                self.roster_changed = True
        elif kind == "team":
            # Between rounds only, into a team with room
            if self.mode.teams and self.phase != "round" and player.team is not None:
                other = 1 - player.team
                if self.team_counts()[other] < TEAM_MAX:
                    player.team, player.ready = other, False
                    self.roster_changed = True
        elif kind == "shot":
            start, end = _vec(msg.get("from"), 3), _vec(msg.get("to"), 3)
            if start and end and self.firing():
                watchers = [self.players[i] for i in player.sees if i in self.players]
                await self.broadcast({"type": "shot", "id": player.id, "from": start, "to": end}, targets=watchers)
        elif kind == "hit":
            target = self.players.get(msg.get("target"))
            if (
                target
                and target is not player
                and target.active
                and self.may_hit(player, target)
                and math.dist(player.pos, target.pos) <= LASER_RANGE
                and player.may_hit()
            ):
                target.hit_by[player.id] = time.monotonic()
                await self.send(target, {"type": "hit", "by": player.id, "dmg": LASER_DAMAGE})
        elif kind == "bhit":
            await self.hit_base(player, msg.get("id"))
        elif kind == "phit":
            pirate = self.world.pirates.get(msg.get("id"))
            if pirate and math.dist(player.pos, pirate.pos) <= LASER_RANGE and player.may_hit():
                if self.world.hit_pirate(pirate.id):
                    stats.add(player.account, "pirate_kills")
                    player.gain(stats.XP["pirate_kills"], 1)
                    await self.broadcast({
                        "type": "pkill", "id": pirate.id, "p": [round(x, 1) for x in pirate.pos],
                        "killer": player.id, "killerName": player.name,
                    })
        elif kind == "ram":
            pirate = self.world.pirates.get(msg.get("id"))
            if pirate and player.active and math.dist(player.pos, pirate.pos) <= RAM_RANGE:
                self.world.ram_pirate(pirate.id)
                await self.broadcast({
                    "type": "pkill", "id": pirate.id, "p": [round(x, 1) for x in pirate.pos],
                    "killer": None, "killerName": None,
                })
        elif kind == "ahit":
            index, max_hp = msg.get("i"), msg.get("hp")
            if (
                isinstance(index, int) and 0 <= index < len(self.world.asteroids) and isinstance(max_hp, int)
                and player.may_hit()
            ):
                pos = self.world.hit_asteroid(index, max_hp, tuple(player.pos))
                if pos:
                    stats.add(player.account, "asteroid_kills")
                    player.gain(stats.XP["asteroid_kills"])
                    await self.broadcast({
                        "type": "arespawn", "i": index, "p": [round(x, 1) for x in pos],
                        "killer": player.id,
                    })
        elif kind == "died":
            await self.died(player, self.players.get(msg.get("by")))

    async def hit_base(self, player: Player, sid):
        """A laser hit on an enemy base ("station" maps, during a round)."""
        if not isinstance(sid, int) or not 0 <= sid < len(self.world.stations):
            return
        base = self.world.stations[sid]
        if (
            not self.mode.destructible
            or not self.firing()
            or base.team == player.team
            or math.dist(player.pos, base.pos) > LASER_RANGE + STATION_SIZE
            or not player.may_hit()
        ):
            return
        if not self.world.hit_base(sid, LASER_DAMAGE):
            return
        self.lost[base.team] += 1
        self.team_score[player.team] += BASE_SCORE
        player.gain(BASE_SCORE)
        self.match_changed = True
        await self.broadcast({
            "type": "base", "id": sid, "alive": False, "team": base.team, "by": player.id, "byName": player.name,
        })
        if self.lost[base.team] >= BASE_LIMIT:
            await self.end_round("bases", winner=1 - base.team)

    async def died(self, player: Player, killer: Player | None):
        if not player.active:
            return  # already dead or docked: one death per life
        if killer is player or time.monotonic() - player.hit_by.get(killer.id if killer else -1, -1e9) > KILL_CREDIT_TIME:
            killer = None
        player.active = False
        player.hit_by.clear()
        stats.add(player.account, "deaths")
        if killer:
            stats.add(killer.account, "pvp_kills")
            if not self.mode.teams:
                killer.gain(KILL_SCORE, 1)
            elif self.phase == "round":
                killer.gain(KILL_SCORE, 1)
                self.team_score[killer.team] += KILL_SCORE
                self.match_changed = True
        await self.broadcast({
            "type": "kill",
            "victim": player.id,
            "victimName": player.name,
            "killer": killer.id if killer else None,
            "killerName": killer.name if killer else None,
        })
