"""Conversational (Realtime) round-setup: the tool + instructions the caddie uses
to set up a round by voice.

Unlike the in-round caddie (realtime_relay.DEFAULT_TOOLS, which needs an existing
round), setup happens BEFORE a round exists. The caddie gathers course / players
/ tees (incl. per-player tee groups like "Dan and I on blues, Matt and John on
whites") over a natural back-and-forth, then calls `set_round_setup` once. The
frontend consumes that tool call to create the round — no backend round needed.

Pure module (tool schema + prompt) so it's unit-tested without OpenAI.
"""

# The single tool the setup caddie calls when it has enough to start the round.
SET_ROUND_SETUP_TOOL: dict = {
    "type": "function",
    "name": "set_round_setup",
    "description": (
        "Create the golf round. Call this ONCE you know the course and at least "
        "one player. Include per-player tees when the golfer assigns them "
        "(e.g. 'Dan and I play the blues, Matt and John the whites')."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "courseName": {
                "type": "string",
                "description": "The course the golfer named.",
            },
            "players": {
                "type": "array",
                "description": "Everyone playing, in order. Include the golfer themselves.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "tee": {
                            "type": "string",
                            "description": (
                                "Tee color/name for THIS player if the golfer specified "
                                "one (e.g. 'blue', 'white'). Omit if not said."
                            ),
                        },
                    },
                    "required": ["name"],
                },
            },
            "teeName": {
                "type": "string",
                "description": "Default tee for players without a specific tee (e.g. 'white').",
            },
            "holes": {
                "type": "integer",
                "description": "9 or 18 if the golfer says so; omit otherwise.",
            },
            "gameFormat": {
                "type": "string",
                "description": (
                    "Side game if mentioned: skins, nassau, match play, stroke play, "
                    "best ball, or stableford. Omit if none."
                ),
            },
        },
        "required": ["courseName", "players"],
    },
}

SETUP_TOOLS: list[dict] = [SET_ROUND_SETUP_TOOL]


def build_setup_instructions() -> str:
    """System instructions for the voice round-setup caddie."""
    return (
        "# Role\n"
        "You are Looper's caddie, helping the golfer set up a new round by voice. "
        "Speak briefly and warmly, like a friend on the first tee — never robotic.\n\n"
        "# Goal\n"
        "Gather what's needed, then call set_round_setup:\n"
        "- the COURSE,\n"
        "- WHO is playing (always include the golfer themselves),\n"
        "- the TEES — a default for everyone, or per-player if they split them "
        "(e.g. 'Dan and I on the blues, Matt and John on the whites'),\n"
        "- optionally a side game (skins, nassau, match play, best ball, stableford).\n\n"
        "# How to converse\n"
        "- Ask for ONE missing thing at a time. If they say several at once, take them all.\n"
        "- Required to start: a course and at least one player. Tees and game are "
        "nice-to-have — ask once, but never block if they skip.\n"
        "- When you have the course and players (and have asked about tees once), give a "
        "one-line confirmation ('Pebble with Dan and Matt off the whites — starting you up') "
        "and call set_round_setup with everything you've gathered.\n"
        "- Keep every reply to a sentence or two. Don't over-explain.\n\n"
        "# After\n"
        "Once you call set_round_setup the round opens automatically — tell them "
        "you're starting it, then stop."
    )
