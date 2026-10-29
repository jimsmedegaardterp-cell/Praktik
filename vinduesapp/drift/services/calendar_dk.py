"""Danske helligdage og faste lukkedage. Ren beregning – ingen ekstern tjeneste."""
from datetime import date, timedelta
from functools import lru_cache


def easter_sunday(year: int) -> date:
    # Gregoriansk påskeberegning (anonym algoritme / Meeus).
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


@lru_cache(maxsize=64)
def closed_days(year: int) -> frozenset[date]:
    e = easter_sunday(year)
    days = {
        date(year, 1, 1),            # Nytårsdag
        e - timedelta(days=3),       # Skærtorsdag
        e - timedelta(days=2),       # Langfredag
        e,                           # Påskedag
        e + timedelta(days=1),       # 2. påskedag
        e + timedelta(days=39),      # Kr. himmelfartsdag
        e + timedelta(days=49),      # Pinsedag
        e + timedelta(days=50),      # 2. pinsedag
        date(year, 12, 25),
        date(year, 12, 26),
        # Faste lukkedage (ikke officielle helligdage) – SKAL VERIFICERES med ejeren:
        date(year, 6, 5),            # Grundlovsdag
        date(year, 12, 24),          # Juleaften
        date(year, 12, 31),          # Nytårsaften
    }
    # Store bededag er afskaffet som helligdag fra 2024.
    return frozenset(days)


def is_workday(d: date) -> bool:
    return d.weekday() < 5 and d not in closed_days(d.year)


def next_workday(d: date) -> date:
    while not is_workday(d):
        d += timedelta(days=1)
    return d
