from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError


class ContractValidationError(ValueError):
    pass


def contracts_dir() -> Path:
    configured = os.environ.get("MARGINALIA_CONTRACTS_DIR")
    if configured:
        return Path(configured)
    for candidate in (
        Path(__file__).resolve().parents[2] / "contracts",
        Path(__file__).resolve().parents[3] / "contracts",
        Path(__file__).resolve().parent / "contracts",
    ):
        if candidate.is_dir():
            return candidate
    return Path(__file__).resolve().parents[2] / "contracts"


@lru_cache(maxsize=2)
def _validator(name: str) -> Draft202012Validator:
    path = contracts_dir() / name
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate_contract(instance: Any, name: str) -> None:
    errors = sorted(_validator(name).iter_errors(instance), key=lambda error: list(error.absolute_path))
    if not errors:
        return
    error: ValidationError = errors[0]
    location = ".".join(str(part) for part in error.absolute_path) or "$"
    raise ContractValidationError(f"{name} validation failed at {location}: {error.message}")
