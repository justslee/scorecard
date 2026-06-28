"""Load production secrets from AWS Secrets Manager into the process env at boot.

Production API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
live in a single Secrets Manager secret — a JSON object of NAME -> value, named
"looper/prod" by default. We fetch it once at startup and populate os.environ
for any key not already set, so the rest of the app keeps reading plain
`os.getenv(...)` and an explicit env var / local `.env` always wins.

Best-effort by design: any failure (boto3 absent, no AWS creds, secret missing,
IAM permission denied, non-JSON payload) logs a warning and is a no-op, so the
app still starts and local/dev is unaffected.

Requirements for this to populate keys on the EC2 box:
  - boto3 installed (declared in pyproject).
  - the instance role can `secretsmanager:GetSecretValue` on the secret.
  - the secret's value is a JSON object of env-var-name -> string.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

log = logging.getLogger("looper.secrets")

DEFAULT_SECRET_NAME = "looper/prod"


def _default_client() -> Any:
    # Imported lazily so the dependency is optional where SM isn't used (tests/dev).
    import boto3

    region = (
        os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1"
    )
    return boto3.client("secretsmanager", region_name=region)


def load_secrets_into_env(
    secret_name: Optional[str] = None, client: Any = None
) -> list[str]:
    """Populate os.environ from the Secrets Manager JSON secret.

    Returns the list of env-var names that were newly set (existing env vars are
    left untouched so explicit config wins). Never logs secret VALUES.
    """
    if os.getenv("LOOPER_SECRETS_DISABLED") == "1":
        return []

    name = secret_name or os.getenv("LOOPER_SECRETS_NAME") or DEFAULT_SECRET_NAME

    try:
        c = client or _default_client()
        resp = c.get_secret_value(SecretId=name)
    except Exception as e:  # noqa: BLE001 — boto missing, no creds, AccessDenied, NotFound …
        log.warning(
            "secrets: could not load %s (%s); continuing with env only",
            name,
            type(e).__name__,
        )
        return []

    raw = resp.get("SecretString")
    if not raw:
        log.warning("secrets: %s has no SecretString; skipping", name)
        return []

    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("secrets: %s is not valid JSON; skipping", name)
        return []

    if not isinstance(data, dict):
        log.warning("secrets: %s JSON is not an object; skipping", name)
        return []

    loaded: list[str] = []
    for k, v in data.items():
        if v is None or os.environ.get(k):
            continue  # don't override explicit env / .env
        os.environ[str(k)] = str(v)
        loaded.append(str(k))

    if loaded:
        log.info(
            "secrets: loaded %d key(s) from %s: %s",
            len(loaded),
            name,
            ", ".join(sorted(loaded)),
        )
    return loaded
