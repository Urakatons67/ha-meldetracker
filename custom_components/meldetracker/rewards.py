"""Auswertung: Wochenziele, Sterne, Wochensterne, Serien, Abzeichen, Stufen.

Alles wird bei Bedarf aus den gespeicherten Tagen neu berechnet (keine Zähler, die
auseinanderlaufen können). Jeder Erfolg hat einen festen Schlüssel; gefeiert wird
nur, was noch nicht in ``celebrated`` steht.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

LEVELS = [
    (0, "Startklar", "👀"),
    (25, "Mitdenken", "💡"),
    (75, "Mut zeigen", "✋"),
    (150, "Meldeprofi", "⭐"),
    (300, "Wortstark", "🎤"),
    (600, "Klassen-Star", "👑"),
]

# Schlüssel: (Titel, Beschreibung, Symbol)
BADGES = {
    "first": ("Erste Meldung", "Die allererste Meldung eingetragen", "🌱"),
    "m50": ("50 Meldungen", "Insgesamt 50 Meldungen", "🥉"),
    "m100": ("100 Meldungen", "Insgesamt 100 Meldungen", "🥈"),
    "m250": ("250 Meldungen", "Insgesamt 250 Meldungen", "🥇"),
    "m500": ("500 Meldungen", "Insgesamt 500 Meldungen", "🏆"),
    "ten_day": ("Zehnerpack", "10 Meldungen an einem Tag", "🔟"),
    "full_day": ("Jede Stunde dabei", "An einem Tag in jeder Stunde gemeldet (mind. 3 Stunden)", "🙋"),
    "allrounder": ("Rundum aktiv", "In einer Woche in jedem Fach mindestens einmal gemeldet", "🌈"),
    "weekstar1": ("Erster Wochenstern", "Zum ersten Mal den Wochenstern geholt", "🌟"),
    "streak3": ("3er-Serie", "3 Wochensterne hintereinander", "🔥"),
    "streak5": ("5er-Serie", "5 Wochensterne hintereinander", "🚀"),
    "streak10": ("10er-Serie", "10 Wochensterne hintereinander", "💎"),
    "mutig": ("Mutig!", "Wochenziel im bisher schwierigsten Fach geschafft", "🦁"),
    "diligent": ("Fleißig eingetragen", "4 Wochen lang jeden Schultag eingetragen", "📒"),
}

WEEKSTAR_SHARE = 0.6  # Anteil der Fachziele für den Wochenstern (3 von 5)


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def week_stats(days: dict) -> dict:
    weeks: dict = {}
    for ds, day in days.items():
        d = date.fromisoformat(ds)
        if d.weekday() > 4:
            continue
        w = weeks.setdefault(monday(d).isoformat(), {"by": {}, "entered": 0, "sum": 0, "units": 0})
        w["entered"] += 1
        for e in day.get("entries", []):
            s = w["by"].setdefault(e["subject_id"], {"sum": 0, "units": 0})
            if e.get("cancelled"):
                continue
            s["sum"] += e["count"]
            s["units"] += e["length"]
            w["sum"] += e["count"]
            w["units"] += e["length"]
    return weeks


def planned_units(timetable: list) -> dict:
    out: dict = {}
    for t in timetable:
        out[t["subject_id"]] = out.get(t["subject_id"], 0) + t["length"]
    return out


def goals_for(goal_hist: list, monday_iso: str) -> dict:
    cur: dict = {}
    for g in sorted(goal_hist or [], key=lambda g: g["from"]):
        if g["from"] <= monday_iso:
            cur = g["goals"]
    return cur


def level_for(total: int) -> dict:
    idx = 0
    for i, (at, _n, _i) in enumerate(LEVELS):
        if total >= at:
            idx = i
    nxt = LEVELS[idx + 1][0] if idx + 1 < len(LEVELS) else None
    return {"idx": idx, "name": LEVELS[idx][1], "icon": LEVELS[idx][2], "next_at": nxt,
            "next_name": LEVELS[idx + 1][1] if nxt is not None else None}


def evaluate(data: dict, today: date, name: str = "") -> dict:
    days = data.get("days", {})
    names = {s["id"]: s["name"] for s in data.get("subjects", [])}
    planned = planned_units(data.get("timetable", []))
    cur_mon = monday(today).isoformat()
    who = name or "Du"
    earned: dict = {}

    def badge(key: str, when: str) -> None:
        if f"badge:{key}" not in earned:
            t, desc, icon = BADGES[key]
            earned[f"badge:{key}"] = {"kind": "badge", "date": when, "big": True, "icon": icon,
                                      "title": f"Abzeichen „{t}“", "text": f"Neues Abzeichen: {t} – {desc}"}

    # ---- Tage: Gesamtzahl, Tagesabzeichen, erste Meldung je Fach ----
    total = 0
    for ds in sorted(days):
        entries = days[ds].get("entries", [])
        held = [e for e in entries if not e.get("cancelled")]
        day_sum = sum(e["count"] for e in held)
        before = total
        total += day_sum
        for key, at in (("first", 1), ("m50", 50), ("m100", 100), ("m250", 250), ("m500", 500)):
            if before < at <= total:
                badge(key, ds)
        if day_sum >= 10:
            badge("ten_day", ds)
        if len(held) >= 3 and all(e["count"] >= 1 for e in held):
            badge("full_day", ds)
        for e in held:
            k = f"first:{e['subject_id']}"
            if e["count"] > 0 and k not in earned:
                sn = names.get(e["subject_id"], "?")
                earned[k] = {"kind": "first", "date": ds, "big": False, "icon": "✨",
                             "title": f"Erste Meldung in {sn}", "text": f"Erste Meldung in {sn}!"}
    for idx in range(1, len(LEVELS)):
        if total >= LEVELS[idx][0]:
            earned[f"level:{idx}"] = {"kind": "level", "date": today.isoformat(), "big": True, "icon": LEVELS[idx][2],
                                      "title": f"Neue Stufe: {LEVELS[idx][1]}",
                                      "text": f"Neue Stufe erreicht: {LEVELS[idx][1]} {LEVELS[idx][2]}"}

    # ---- Wochen: Ziele, Sterne, Wochenstern, Serien, Bestwerte ----
    weeks = week_stats(days)
    stars = weekstars = streak = best_streak = full_weeks = 0
    best: dict = {}
    hist_cnt: dict = {}
    rates: list = []
    week_out: dict = {}
    for m in sorted(weeks):
        w = weeks[m]
        goals = {k: v for k, v in goals_for(data.get("goals"), m).items() if v}
        complete = m < cur_mon
        reached = {}
        for sid, g in goals.items():
            s = w["by"].get(sid, {"sum": 0, "units": 0})
            ok = s["sum"] >= g
            # Ausfall-/Ferienwoche: Ziel anteilig zu den gehaltenen Stunden
            if not ok and complete and planned.get(sid) and s["units"]:
                ok = s["sum"] >= math.ceil(g * min(1, s["units"] / planned[sid]))
            reached[sid] = ok
            if ok:
                stars += 1
                sn = names.get(sid, "?")
                earned[f"goal:{m}:{sid}"] = {"kind": "goal", "date": m, "big": False, "icon": "⭐",
                                             "title": f"Wochenziel {sn}",
                                             "text": f"Wochenziel in {sn} geschafft ({s['sum']} von {g})"}
        n_goals = len(goals)
        n_ok = sum(1 for v in reached.values() if v)
        star = n_goals > 0 and n_ok >= math.ceil(n_goals * WEEKSTAR_SHARE)
        if star:
            weekstars += 1
            streak += 1
            best_streak = max(best_streak, streak)
            earned[f"weekstar:{m}"] = {"kind": "weekstar", "date": m, "big": True, "icon": "🌟",
                                       "title": "Wochenstern",
                                       "text": f"Wochenstern! {n_ok} von {n_goals} Wochenzielen geschafft"}
            badge("weekstar1", m)
            for n in (3, 5, 10):
                if streak >= n:
                    badge(f"streak{n}", m)
        elif complete and w["entered"]:
            streak = 0
        # Bestwert je Fach (erst ab 3 Wochen Vorgeschichte)
        for sid, s in w["by"].items():
            if hist_cnt.get(sid, 0) >= 3 and s["sum"] > best.get(sid, 0):
                sn = names.get(sid, "?")
                earned[f"best:{sid}:{m}"] = {"kind": "best", "date": m, "big": False, "icon": "📈",
                                             "title": f"Bestwert {sn}",
                                             "text": f"Neuer Bestwert in {sn}: {s['sum']} Meldungen in einer Woche"}
        # Mutig: Ziel im schwächsten Fach der letzten 4 Wochen
        agg: dict = {}
        for r in rates[-4:]:
            for sid, (sm, un) in r.items():
                a = agg.setdefault(sid, [0, 0])
                a[0] += sm
                a[1] += un
        cand = {sid: a[0] / a[1] for sid, a in agg.items() if a[1]}
        if len(cand) >= 2:
            weakest = min(cand, key=cand.get)
            if reached.get(weakest):
                badge("mutig", m)
        # Rundum aktiv: mind. 3 Fächer, jedes mit Unterricht hat ≥1 Meldung
        held = {sid: s for sid, s in w["by"].items() if s["units"]}
        if len(held) >= 3 and all(s["sum"] >= 1 for s in held.values()):
            badge("allrounder", m)
        # Fleißig: 4 volle Wochen (5 Schultage eingetragen)
        if w["entered"] >= 5:
            full_weeks += 1
            if full_weeks >= 4:
                badge("diligent", m)
        for sid, s in w["by"].items():
            best[sid] = max(best.get(sid, 0), s["sum"])
            if s["units"]:
                hist_cnt[sid] = hist_cnt.get(sid, 0) + 1
        rates.append({sid: (s["sum"], s["units"]) for sid, s in w["by"].items()})
        week_out[m] = {"goals": goals, "reached": reached, "weekstar": star, "n_ok": n_ok, "n_goals": n_goals}

    badges = []
    for key, (t, desc, icon) in BADGES.items():
        e = earned.get(f"badge:{key}")
        badges.append({"key": key, "title": t, "desc": desc, "icon": icon, "date": e["date"] if e else None})
    recent = sorted(
        ({"key": k, **v} for k, v in earned.items()),
        key=lambda x: x["date"], reverse=True,
    )[:15]
    return {
        "earned": earned,
        "summary": {
            "total": total, "stars": stars, "weekstars": weekstars, "streak": streak,
            "best_streak": best_streak, "level": level_for(total), "badges": badges,
            "recent": [{k: v for k, v in r.items() if k != "big"} for r in recent],
            "weeks": week_out, "who": who,
        },
    }


def suggest_goals(data: dict, today: date) -> dict:
    """Vorschlag je Fach: Schnitt pro Stunde der letzten 4 Wochen × geplante Stunden × 1,1."""
    planned = planned_units(data.get("timetable", []))
    weeks = week_stats(data.get("days", {}))
    cur = monday(today).isoformat()
    past = [weeks[m] for m in sorted(weeks) if m < cur][-4:]
    out = {}
    for sid, units in planned.items():
        sm = sum(w["by"].get(sid, {}).get("sum", 0) for w in past)
        un = sum(w["by"].get(sid, {}).get("units", 0) for w in past)
        if un:
            out[sid] = max(1, math.ceil(sm / un * units * 1.1))
        else:
            out[sid] = units  # ohne Vorgeschichte: 1 Meldung je Stunde
    return out
