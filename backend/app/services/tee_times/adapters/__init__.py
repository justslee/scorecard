"""
Rung-1 booking-engine adapters (specs/teetime-availability-everywhere-plan.md
§3/§6). Each adapter implements the same contract as `ForeUpProvider.
slots_for_capability`: `list[TeeTimeSlot]` (real slots), `[]` (verified
empty), or `None` (couldn't check — degrade down the router's ladder). Never
raises. `router_provider.ADAPTERS` maps `cap.platform` -> the adapter
instance that knows how to check that platform's availability.
"""

from __future__ import annotations
