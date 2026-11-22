"""Melde-Tracker: Meldungen im Unterricht je Fach erfassen und auswerten.

Daten liegen in .storage/meldetracker (ab 2.0 mit Profilen je Kind):
  profiles: {profil_id: {
      name, user_id,                      Kind und zugehöriger HA-Benutzer
      subjects:   [{id, name, color, active}]
      timetable:  [{day 0-4, period 1-12, subject_id, length 1|2}]
      periods:    Anzahl Stunden pro Tag im Stundenplan-Raster
      days:       {"YYYY-MM-DD": {entries: [{period, subject_id, length, count, cancelled}], updated, by}}
      goals:      [{from: Montag "YYYY-MM-DD", goals: {subject_id: Wochenziel}}]
      celebrate:  Feier-Einstellungen (siehe celebrate.py)
      celebrated: bereits gefeierte Erfolgs-Schlüssel
  }}
  parents: [HA-Benutzer-IDs]  dürfen alle Profile sehen, umschalten und bearbeiten

Rechte (vom Server geprüft): Admins und Eltern sehen alle Profile, ein Kind nur
das Profil mit seiner user_id. Feier- und Eltern-Einstellungen nur für Eltern/Admins
bzw. nur für Admins.

Ein gespeicherter Tag enthält eine Kopie der Stunden (Fach, Dauer). Spätere
Stundenplan-Änderungen verfälschen alte Wochen deshalb nicht.
"""
from __future__ import annotations

import copy
import hashlib
import logging
import shutil
import uuid
from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .celebrate import DEFAULT_CELEBRATE, async_celebrate
from .const import DOMAIN, PANEL_ELEMENT, PANEL_PATH, URL_BASE, VERSION
from .rewards import evaluate, monday, suggest_goals

_LOGGER = logging.getLogger(__name__)
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

DEFAULT_PROFILE = {
    "name": "", "user_id": None,
    "subjects": [], "timetable": [], "periods": 8, "days": {},
    "goals": [], "celebrate": {}, "celebrated": [],
}
PROFILE_KEYS = ("subjects", "timetable", "periods", "days", "goals", "celebrate", "celebrated")
WWW = Path(__file__).parent / "www"
PANEL_JS = "meldetracker-panel.js"

def _new_profile(**kw) -> dict:
    return {**copy.deepcopy(DEFAULT_PROFILE), **kw}


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def migrate_v1(old: dict) -> dict:
    """Altes Ein-Kind-Format (1.x) in ein Profil umwandeln (reine Funktion, testbar).

    Alle Daten bleiben unverändert erhalten. Der HA-Benutzer wird danach unter
    Einstellungen → Profile zugeordnet.
    """
    if "profiles" in old:
        return old
    name = ((old.get("celebrate") or {}).get("name") or "").strip() or "Kind 1"
    p1 = _new_profile(name=name)
    for k in PROFILE_KEYS:
        if k in old:
            p1[k] = copy.deepcopy(old[k])
    return {"profiles": {_new_id(): p1}, "parents": []}


class MeldeData:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict] = Store(hass, 1, DOMAIN)
        self.data: dict = {"profiles": {}, "parents": []}

    async def async_load(self) -> None:
        stored = await self._store.async_load() or {}
        if stored and "profiles" not in stored:
            src = Path(self.hass.config.path(".storage", DOMAIN))
            dst = src.with_name(f"{DOMAIN}.bak-v1")
            if src.exists() and not dst.exists():
                await self.hass.async_add_executor_job(shutil.copy2, src, dst)
            stored = migrate_v1(stored)
            self.data = stored
            await self._store.async_save(self.data)
            _LOGGER.info("Melde-Tracker auf Profile umgestellt (Sicherung: %s)", dst.name)
        elif stored:
            self.data = stored
        self.data.setdefault("profiles", {})
        self.data.setdefault("parents", [])
        if not self.data["profiles"]:  # Neuinstallation: ein leeres Profil zum Start
            self.data["profiles"][_new_id()] = _new_profile(name="Kind 1")
            await self._store.async_save(self.data)
        for pid, p in self.data["profiles"].items():
            self.data["profiles"][pid] = {**copy.deepcopy(DEFAULT_PROFILE), **p}

    @callback
    def save(self) -> None:
        self._store.async_delay_save(lambda: self.data, 2)

    def profile(self, pid: str) -> dict | None:
        return self.data["profiles"].get(pid)

    @staticmethod
    def cfg(prof: dict) -> dict:
        return {**DEFAULT_CELEBRATE, **(prof.get("celebrate") or {})}


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    for cmd in (ws_get, ws_save_subjects, ws_save_timetable, ws_save_day, ws_save_goals,
                ws_save_celebrate, ws_test_celebrate, ws_save_parents, ws_save_profile,
                ws_delete_profile):
        websocket_api.async_register_command(hass, cmd)
    return True


def _file_hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()[:8]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = MeldeData(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    flags = hass.data.setdefault(f"{DOMAIN}_flags", {})
    if not flags.get("static"):
        await hass.http.async_register_static_paths([StaticPathConfig(URL_BASE, str(WWW), False)])
        flags["static"] = True
    js_hash = await hass.async_add_executor_job(_file_hash, WWW / PANEL_JS)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title="Melden",
        sidebar_icon="mdi:hand-back-right",
        module_url=f"{URL_BASE}/{PANEL_JS}?v={VERSION}-{js_hash}",
        require_admin=False,
        config={},
    )

    # Täglich prüfen: abgeschlossene Wochen (Ausfall-/Ferienwochen anteilig) feiern
    @callback
    def _daily(_now) -> None:
        for pid in list(store.data["profiles"]):
            check_and_celebrate(hass, store, pid)

    entry.async_on_unload(async_track_time_change(hass, _daily, hour=16, minute=0, second=0))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    frontend.async_remove_panel(hass, PANEL_PATH)
    hass.data.pop(DOMAIN, None)
    return True


@callback
def check_and_celebrate(hass: HomeAssistant, store: MeldeData, pid: str) -> int:
    """Neue Erfolge eines Profils ermitteln, als gefeiert merken und Feier starten."""
    prof = store.profile(pid)
    if prof is None:
        return 0
    cfg = store.cfg(prof)
    ev = evaluate(prof, dt_util.now().date(), cfg.get("name", ""))
    done = set(prof.get("celebrated") or [])
    new = [ev["earned"][k] for k in ev["earned"] if k not in done]
    if not new:
        return 0
    prof["celebrated"] = sorted(done | set(ev["earned"]))
    store.save()
    new.sort(key=lambda e: (not e.get("big"), e["date"]))
    hass.async_create_background_task(async_celebrate(hass, cfg, new, profile=pid), f"meldetracker_feier_{pid}")
    return len(new)


# ---------- Rechte ----------
def _role(store: MeldeData, user) -> str:
    if user is None:
        return "none"
    if user.is_admin:
        return "admin"
    if user.id in store.data.get("parents", []):
        return "parent"
    return "kid"


def _own_profile(store: MeldeData, user) -> str | None:
    if user is None:
        return None
    return next((pid for pid, p in store.data["profiles"].items() if p.get("user_id") == user.id), None)


def _ctx(hass: HomeAssistant, connection, msg, need_parent: bool = False):
    """(store, Profil-ID, Profil, Rolle) oder None nach Fehlermeldung."""
    store = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Melde-Tracker ist nicht eingerichtet")
        return None
    user = connection.user
    role = _role(store, user)
    if role in ("admin", "parent"):
        pid = msg.get("profile") or _own_profile(store, user) or next(iter(store.data["profiles"]), None)
    else:
        pid = _own_profile(store, user)
        if msg.get("profile") and msg["profile"] != pid:
            connection.send_error(msg["id"], "unauthorized", "Kein Zugriff auf dieses Profil")
            return None
    prof = store.profile(pid) if pid else None
    if prof is None:
        connection.send_error(msg["id"], "no_profile", "Für deinen Benutzer gibt es kein Melde-Profil")
        return None
    if need_parent and role not in ("admin", "parent"):
        connection.send_error(msg["id"], "unauthorized", "Nur für Eltern")
        return None
    return store, pid, prof, role


def _choices(hass: HomeAssistant) -> dict:
    def ents(domain: str) -> list:
        return sorted(
            ({"id": s.entity_id, "name": s.attributes.get("friendly_name") or s.entity_id}
             for s in hass.states.async_all(domain)),
            key=lambda x: x["name"].lower(),
        )

    services = sorted(f"notify.{s}" for s in hass.services.async_services().get("notify", {})
                      if s not in ("send_message", "persistent_notification", "notify"))
    return {"lights": ents("light"), "speakers": ents("notify"), "push": services}


def _summary(store: MeldeData, prof: dict) -> dict:
    today = dt_util.now().date()
    ev = evaluate(prof, today, store.cfg(prof).get("name", ""))
    return {**ev["summary"], "suggest": suggest_goals(prof, today), "this_monday": monday(today).isoformat()}


PROFILE_ARG = {vol.Optional("profile"): cv.string}


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get", **PROFILE_ARG})
@websocket_api.async_response
async def ws_get(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg)
    if ctx is None:
        return
    store, pid, prof, role = ctx
    user = connection.user
    parent = role in ("admin", "parent")
    data = {k: v for k, v in prof.items() if k not in ("celebrated", "user_id")}
    result = {
        **data,
        "profile": pid,
        "role": role,
        "profiles": [{"id": k, "name": p.get("name") or k} for k, p in store.data["profiles"].items()] if parent else [],
        "celebrate": store.cfg(prof),
        "summary": _summary(store, prof),
        "choices": _choices(hass) if parent else {"lights": [], "speakers": [], "push": []},
        "user": {"name": user.name if user else "", "is_admin": bool(user and user.is_admin)},
    }
    if role == "admin":
        users = await hass.auth.async_get_users()
        result["parents"] = list(store.data.get("parents", []))
        for p in result["profiles"]:
            p["user_id"] = store.data["profiles"][p["id"]].get("user_id")
        result["users"] = sorted(
            ({"id": u.id, "name": u.name} for u in users
             if not u.system_generated and u.is_active and not u.is_admin),
            key=lambda x: (x["name"] or "").lower(),
        )
    connection.send_result(msg["id"], result)


SUBJECT = vol.Schema(
    {
        vol.Optional("id"): vol.Any(None, cv.string),
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=40)),
        vol.Required("color"): vol.All(cv.string, vol.Length(max=20)),
        vol.Optional("active", default=True): cv.boolean,
    }
)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/subjects/save", vol.Required("subjects"): [SUBJECT], **PROFILE_ARG}
)
@callback
def ws_save_subjects(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg)
    if ctx is None:
        return
    store, _pid, prof, _role_ = ctx
    subjects = []
    for s in msg["subjects"]:
        subjects.append({**s, "id": s.get("id") or uuid.uuid4().hex[:10], "name": s["name"].strip()})
    known = {s["id"] for s in subjects}
    prof["subjects"] = subjects
    prof["timetable"] = [t for t in prof["timetable"] if t["subject_id"] in known]
    store.save()
    connection.send_result(msg["id"], {"subjects": subjects, "timetable": prof["timetable"]})


LESSON = vol.Schema(
    {
        vol.Required("day"): vol.All(int, vol.Range(min=0, max=4)),
        vol.Required("period"): vol.All(int, vol.Range(min=1, max=12)),
        vol.Required("subject_id"): cv.string,
        vol.Required("length"): vol.In([1, 2]),
    }
)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/timetable/save",
        vol.Required("timetable"): [LESSON],
        vol.Required("periods"): vol.All(int, vol.Range(min=4, max=12)),
        **PROFILE_ARG,
    }
)
@callback
def ws_save_timetable(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg)
    if ctx is None:
        return
    store, _pid, prof, _role_ = ctx
    prof["timetable"] = sorted(msg["timetable"], key=lambda t: (t["day"], t["period"]))
    prof["periods"] = msg["periods"]
    store.save()
    connection.send_result(msg["id"], {"timetable": prof["timetable"], "periods": msg["periods"]})


ENTRY = vol.Schema(
    {
        vol.Required("period"): vol.All(int, vol.Range(min=0, max=12)),
        vol.Required("subject_id"): cv.string,
        vol.Required("length"): vol.In([1, 2]),
        vol.Required("count"): vol.All(int, vol.Range(min=0, max=99)),
        vol.Optional("cancelled", default=False): cv.boolean,
    }
)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/day/save",
        vol.Required("date"): vol.Match(r"^\d{4}-\d{2}-\d{2}$"),
        vol.Required("entries"): [ENTRY],
        **PROFILE_ARG,
    }
)
@callback
def ws_save_day(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg)
    if ctx is None:
        return
    store, pid, prof, _role_ = ctx
    if not msg["entries"]:
        prof["days"].pop(msg["date"], None)
        day = None
    else:
        day = {
            "entries": msg["entries"],
            "updated": dt_util.now().isoformat(timespec="seconds"),
            "by": connection.user.name if connection.user else "",
        }
        prof["days"][msg["date"]] = day
    store.save()
    new = check_and_celebrate(hass, store, pid)
    connection.send_result(msg["id"], {"day": day, "new": new, "summary": _summary(store, prof)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/goals/save",
        vol.Required("from"): vol.Match(r"^\d{4}-\d{2}-\d{2}$"),
        vol.Required("goals"): {cv.string: vol.All(int, vol.Range(min=0, max=99))},
        **PROFILE_ARG,
    }
)
@callback
def ws_save_goals(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg)
    if ctx is None:
        return
    store, pid, prof, _role_ = ctx
    hist = [g for g in prof.get("goals", []) if g["from"] != msg["from"]]
    hist.append({"from": msg["from"], "goals": msg["goals"]})
    prof["goals"] = sorted(hist, key=lambda g: g["from"])
    store.save()
    new = check_and_celebrate(hass, store, pid)
    connection.send_result(msg["id"], {"goals": prof["goals"], "new": new, "summary": _summary(store, prof)})


CELEBRATE = vol.Schema(
    {
        vol.Optional("name"): vol.All(cv.string, vol.Length(max=30)),
        vol.Optional("lights"): [cv.entity_id],
        vol.Optional("speakers"): [cv.entity_id],
        vol.Optional("push_kid"): [cv.string],
        vol.Optional("push_parent"): [cv.string],
        vol.Optional("quiet_start"): vol.Match(r"^\d{2}:\d{2}$"),
        vol.Optional("quiet_end"): vol.Match(r"^\d{2}:\d{2}$"),
        vol.Optional("enable_light"): cv.boolean,
        vol.Optional("enable_voice"): cv.boolean,
        vol.Optional("enable_push"): cv.boolean,
        vol.Optional("enable_parent"): cv.boolean,
    }
)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/celebrate/save", vol.Required("config"): CELEBRATE, **PROFILE_ARG}
)
@callback
def ws_save_celebrate(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg, need_parent=True)
    if ctx is None:
        return
    store, _pid, prof, _role_ = ctx
    prof["celebrate"] = {**store.cfg(prof), **msg["config"]}
    store.save()
    connection.send_result(msg["id"], {"celebrate": store.cfg(prof)})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/celebrate/test", **PROFILE_ARG})
@websocket_api.async_response
async def ws_test_celebrate(hass: HomeAssistant, connection, msg) -> None:
    ctx = _ctx(hass, connection, msg, need_parent=True)
    if ctx is None:
        return
    store, pid, prof, _role_ = ctx
    event = {"kind": "test", "date": dt_util.now().date().isoformat(), "big": True, "icon": "🎉",
             "title": "Test", "text": "Das ist ein Test der Feier im Melde-Tracker."}
    hass.async_create_background_task(
        async_celebrate(hass, store.cfg(prof), [event], test=True, profile=pid), f"meldetracker_test_{pid}")
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/parents/save", vol.Required("parents"): [cv.string]}
)
@websocket_api.require_admin
@callback
def ws_save_parents(hass: HomeAssistant, connection, msg) -> None:
    store = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Melde-Tracker ist nicht eingerichtet")
        return
    store.data["parents"] = sorted(set(msg["parents"]))
    store.save()
    connection.send_result(msg["id"], {"parents": store.data["parents"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/profile/save",
        vol.Optional("id"): vol.Any(None, cv.string),
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=30)),
        vol.Optional("user_id"): vol.Any(None, cv.string),
        vol.Optional("copy_subjects_from"): vol.Any(None, cv.string),
    }
)
@websocket_api.require_admin
@callback
def ws_save_profile(hass: HomeAssistant, connection, msg) -> None:
    """Profil anlegen (ohne id) oder umbenennen/Benutzer zuordnen (mit id)."""
    store = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Melde-Tracker ist nicht eingerichtet")
        return
    profiles = store.data["profiles"]
    uid = msg.get("user_id") or None
    pid = msg.get("id")
    if uid and any(p.get("user_id") == uid for k, p in profiles.items() if k != pid):
        connection.send_error(msg["id"], "user_taken", "Dieser Benutzer hat schon ein Profil")
        return
    name = msg["name"].strip()
    if pid:
        prof = profiles.get(pid)
        if prof is None:
            connection.send_error(msg["id"], "not_found", "Profil nicht gefunden")
            return
        prof["name"] = name
        prof["user_id"] = uid
    else:
        pid = _new_id()
        prof = _new_profile(name=name, user_id=uid, celebrate={"name": name})
        src = profiles.get(msg.get("copy_subjects_from") or "")
        if src:
            prof["subjects"] = [{**s, "id": uuid.uuid4().hex[:10]} for s in src.get("subjects", [])]
            prof["periods"] = src.get("periods", 8)
        profiles[pid] = prof
    store.save()
    connection.send_result(msg["id"], {"id": pid})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/profile/delete", vol.Required("id"): cv.string,
     vol.Required("confirm_name"): cv.string}
)
@websocket_api.require_admin
@callback
def ws_delete_profile(hass: HomeAssistant, connection, msg) -> None:
    """Profil samt aller Einträge löschen; Name muss zur Bestätigung stimmen."""
    store = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Melde-Tracker ist nicht eingerichtet")
        return
    prof = store.data["profiles"].get(msg["id"])
    if prof is None:
        connection.send_error(msg["id"], "not_found", "Profil nicht gefunden")
        return
    if msg["confirm_name"].strip() != (prof.get("name") or "").strip():
        connection.send_error(msg["id"], "confirm", "Name zur Bestätigung stimmt nicht")
        return
    if len(store.data["profiles"]) <= 1:
        connection.send_error(msg["id"], "last", "Das letzte Profil kann nicht gelöscht werden")
        return
    del store.data["profiles"][msg["id"]]
    store.save()
    connection.send_result(msg["id"], {"ok": True})
