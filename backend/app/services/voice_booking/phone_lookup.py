"""
Course → pro-shop phone number via Google Places text search.

Same Places API (New) + server key as app/services/course_finder.py, with the
field mask extended to internationalPhoneNumber. Graceful None (never a raise)
when the key is absent or the lookup fails — the provider then returns
needs_human instead of calling anyone.

NOTE: a Places number is NOT automatically dialable — compliance gates AI
calls to the owner-verified business-landline allowlist (compliance.py).
"""

from __future__ import annotations

import httpx

from app.services import course_finder


async def lookup_course_phone(
    course_name: str,
    area: str | None = None,
    *,
    api_key: str | None = None,
) -> str | None:
    """Best-effort pro-shop phone number for a course. None when unknown."""
    key = api_key if api_key is not None else course_finder.GOOGLE_PLACES_API_KEY
    if not key or not course_name.strip():
        return None
    query = course_name if not area else f"{course_name} near {area}"
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": (
            "places.displayName,places.internationalPhoneNumber,"
            "places.nationalPhoneNumber"
        ),
    }
    body = {"textQuery": query, "includedType": "golf_course", "maxResultCount": 1}
    async with httpx.AsyncClient(timeout=8) as client:
        try:
            resp = await client.post(url, headers=headers, json=body)
            if not resp.is_success:
                return None
            places = resp.json().get("places", [])
            if not places:
                return None
            place = places[0]
            return (
                place.get("internationalPhoneNumber")
                or place.get("nationalPhoneNumber")
                or None
            )
        except Exception:
            return None
