"""Feiern: Licht-Show, Sprachausgabe, Push an Kind und Eltern.

Konfiguration (store.data["celebrate"]):
  name          Name des Kindes für die Texte
  lights        [light.*]                 Licht-Show
  speakers      [notify.*] (Entitäten)    Sprachausgabe über notify.send_message
  push_kid      ["notify.mobile_app_…"]  Push an das Kind (Dienste)
  push_parent   ["notify.mobile_app_…"]  Lob-Anlass an Eltern (Dienste)
  quiet_start / quiet_end  "HH:MM"       in der Ruhezeit nur Push, kein Licht/Ton
  enable_light / enable_voice / enable_push / enable_parent  bool
"""
from __future__ import annotations

import asyncio
import logging
from datetime import time

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

DEFAULT_CELEBRATE = {
    "name": "",
    "lights": [],
    "speakers": [],
    "push_kid": [],
    "push_parent": [],
    "quiet_start": "21:00",
    "quiet_end": "07:00",
    "enable_light": True,
    "enable_voice": True,
    "enable_push": True,
    "enable_parent": True,
}

COLORS = [(255, 0, 0), (255, 160, 0), (255, 255, 0), (0, 200, 60), (0, 120, 255), (170, 0, 255)]
EVENT = "meldetracker_erfolg"


def _t(s: str) -> time:
    h, m = (s or "00:00").split(":")[:2]
    return time(int(h), int(m))


def in_quiet(cfg: dict) -> bool:
    now = dt_util.now().time()
    a, b = _t(cfg.get("quiet_start", "21:00")), _t(cfg.get("quiet_end", "07:00"))
    return (a <= now or now < b) if a > b else (a <= now < b)


async def _notify_service(hass: HomeAssistant, svc: str, title: str, message: str, data: dict | None = None) -> None:
    domain, _, service = svc.partition(".")
    if domain != "notify" or not hass.services.has_service("notify", service):
        _LOGGER.warning("Benachrichtigungsdienst %s nicht gefunden", svc)
        return
    payload = {"title": title, "message": message}
    if data:
        payload["data"] = data
    await hass.services.async_call("notify", service, payload, blocking=False)


async def _speak(hass: HomeAssistant, entities: list, message: str) -> None:
    ok = [e for e in entities if (st := hass.states.get(e)) and st.state != "unavailable"]
    if ok:
        await hass.services.async_call("notify", "send_message", {"entity_id": ok, "message": message}, blocking=False)


async def _light_show(hass: HomeAssistant, lights: list, big: bool, scene: str = "meldetracker_vorher") -> None:
    ok = [e for e in lights if (st := hass.states.get(e)) and st.state != "unavailable"]
    if not ok:
        return
    await hass.services.async_call(
        "scene", "create", {"scene_id": scene, "snapshot_entities": ok}, blocking=True
    )
    try:
        for _ in range(3 if big else 1):
            for c in COLORS:
                await hass.services.async_call(
                    "light", "turn_on", {"entity_id": ok, "rgb_color": list(c), "brightness": 255, "transition": 0},
                    blocking=True,
                )
                await asyncio.sleep(0.7)
    finally:
        await hass.services.async_call("scene", "turn_on", {"entity_id": f"scene.{scene}"}, blocking=True)


def _texts(events: list, name: str) -> tuple[str, str, str]:
    """(Push-Titel, Push-Text fürs Kind, Sprachtext)."""
    big = [e for e in events if e.get("big")]
    if len(events) > 4:
        kid = f"{len(events)} neue Erfolge! " + " · ".join(e["title"] for e in events[:4]) + " …"
    else:
        kid = "\n".join(f"{e.get('icon', '⭐')} {e['text']}" for e in events)
    first = (big or events)[0]
    anrede = f"Super, {name}! " if name else "Super! "
    voice = anrede + first["text"].replace("„", "").replace("“", "")
    if len(events) > 1:
        voice += f" Und noch {len(events) - 1} weitere Erfolge. Schau mal in die App."
    title = "🌟 Wochenstern!" if any(e["kind"] == "weekstar" for e in events) else "⭐ Geschafft!"
    return title, kid, voice


async def async_celebrate(hass: HomeAssistant, cfg: dict, events: list, test: bool = False, profile: str = "") -> None:
    if not events:
        return
    cfg = {**DEFAULT_CELEBRATE, **(cfg or {})}
    name = cfg.get("name") or ""
    title, kid_text, voice = _texts(events, name)
    quiet = in_quiet(cfg) and not test
    hass.bus.async_fire(EVENT, {"profil": profile, "name": name, "events": [{k: e.get(k) for k in ("kind", "title", "text", "date")} for e in events]})
    tasks = []
    if cfg["enable_push"]:
        for svc in cfg["push_kid"]:
            tasks.append(_notify_service(hass, svc, title, kid_text, {"url": "/melden"}))
    if cfg["enable_parent"]:
        who = name or "Dein Kind"
        parent = f"Lob-Anlass: {who} – " + "; ".join(e["text"] for e in events[:4])
        parent += "\nEin kurzes Lob wirkt jetzt am besten."
        for svc in cfg["push_parent"]:
            tasks.append(_notify_service(hass, svc, "👏 Melde-Tracker", parent, {"url": "/melden"}))
    if not quiet and cfg["enable_voice"] and cfg["speakers"]:
        tasks.append(_speak(hass, cfg["speakers"], voice))
    if not quiet and cfg["enable_light"] and cfg["lights"]:
        tasks.append(_light_show(hass, cfg["lights"], any(e.get("big") for e in events), f"meldetracker_vorher_{profile}" if profile else "meldetracker_vorher"))
    for res in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(res, Exception):
            _LOGGER.warning("Feiern teilweise fehlgeschlagen: %s", res)
