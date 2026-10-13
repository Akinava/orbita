"""Map types. Players create maps of these types on the fly (app/main.py, /api/maps); each type decides
who is on the map, what is in its world (app/game.py) and whether pilots can shoot each other.
Every type has asteroid belts (BELTS): on the free-for-all maps one off to the side of the start, on
the team maps one in the middle and a ring around each base, with the bases' approaches left clear.

    farm     Farming space: up to 40 pilots, pirates and asteroids, several stations for repairs; pilots
             cannot shoot each other. The info panel shows the pilot's all-time score and victories.
    pvp      Up to 40 pilots shooting each other, several stations. Score and victories on this map.
    team     Team battle: two teams of 1-10, a base each (repairs for its own team only). Rounds of
             ROUND_TIME start when every pilot on the map is ready, after COUNTDOWN; between rounds
             nobody can fire and pilots may change teams. The team with more points wins the round.
    station  Like team, but the bases can be destroyed (and rebuild themselves): a team whose base is
             destroyed BASE_LIMIT times in a round loses it.
"""

from dataclasses import dataclass

TEAMS = 2
TEAM_MAX = 10
COUNTDOWN = 10.0  # seconds from "everyone is ready" to the start of a round
ROUND_TIME = 20 * 60.0
KILL_SCORE = 250  # an enemy pilot shot down (pvp and team maps; experience as in app/stats.py)
BASE_SCORE = 1000  # an enemy base destroyed ("station")
BASE_LIMIT = 3  # bases lost in a round that lose it ("station")


@dataclass(frozen=True)
class Belt:
    """Asteroids scattered between `inner` and `outer` metres of `center`, squashed vertically to `flat`."""
    center: tuple
    inner: float
    outer: float
    count: int
    flat: float = 0.35


@dataclass(frozen=True)
class Mode:
    id: str
    max_players: int
    pirates: bool  # pirate zones and the asteroid belt
    pvp: bool  # pilots can shoot each other (on team maps: the other team, during a round)
    teams: bool  # two teams, rounds started by "ready"
    destructible: bool  # the bases can be destroyed
    stations: tuple  # ((x, y, z), team or None) per station
    belts: tuple  # Belt per asteroid belt


# Free-for-all maps: the old station ahead of the start point and two more far out
SHARED_STATIONS = (((0.0, 0.0, -3800.0), None), ((9000.0, 600.0, 5000.0), None), ((-8500.0, -500.0, 6500.0), None))
# Team maps: the bases face each other across the middle, 14 km apart
TEAM_STATIONS = (((0.0, 0.0, -7000.0), 0), ((0.0, 0.0, 7000.0), 1))
# The belt of the free-for-all maps, off to the side between the start and the first station; on team
# maps one in the middle between the bases and a ring around each (90 asteroids, js/world.js BELT_MAX)
SHARED_BELTS = (Belt((2600.0, 300.0, -3000.0), 0.0, 2300.0, 70),)
TEAM_BELTS = (
    Belt((0.0, 0.0, 0.0), 0.0, 2500.0, 40),
    *(Belt(pos, 1300.0, 2600.0, 25) for pos, _ in TEAM_STATIONS),
)

MODES = {
    "farm": Mode("farm", 40, pirates=True, pvp=False, teams=False, destructible=False, stations=SHARED_STATIONS,
                 belts=SHARED_BELTS),
    "pvp": Mode("pvp", 40, pirates=False, pvp=True, teams=False, destructible=False, stations=SHARED_STATIONS,
                belts=SHARED_BELTS),
    "team": Mode("team", 2 * TEAM_MAX, pirates=False, pvp=True, teams=True, destructible=False,
                 stations=TEAM_STATIONS, belts=TEAM_BELTS),
    "station": Mode("station", 2 * TEAM_MAX, pirates=False, pvp=True, teams=True, destructible=True,
                    stations=TEAM_STATIONS, belts=TEAM_BELTS),
}
