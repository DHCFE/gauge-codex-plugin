#!/usr/bin/env python3
"""Offline Codex usage meter. Python 3.10+, standard library only.

The rollout adapters are intentionally isolated from pricing and presentation.
Only allowlisted telemetry is persisted; conversation content is discarded.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from datetime import date
from decimal import Decimal

VERSION = "0.5.3"
ROOT = Path(__file__).resolve().parents[1]
FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
          "output_tokens", "reasoning_output_tokens", "total_tokens")
MAX_LINE = 4 * 1024 * 1024
MAX_SCAN = 256 * 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")


class MeterError(ValueError):
    pass


def zero():
    return dict.fromkeys(FIELDS, 0)


def usage(obj):
    """Codex snake_case usage; absent cache-write means unknown, not zero cost."""
    if not isinstance(obj, dict):
        raise MeterError("Usage is missing.")
    result = {}
    for field in FIELDS:
        value = obj.get(field, 0 if field in ("cache_write_input_tokens", "reasoning_output_tokens") else None)
        if type(value) is not int or not 0 <= value <= 10**18:
            raise MeterError("Invalid token counters.")
        result[field] = value
    if result["cached_input_tokens"] + result["cache_write_input_tokens"] > result["input_tokens"]:
        raise MeterError("Cache counters exceed input tokens.")
    if result["reasoning_output_tokens"] > result["output_tokens"]:
        raise MeterError("Reasoning counters exceed output tokens.")
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        raise MeterError("Token total does not equal input plus output.")
    return result


def add(a, b):
    return {k: a[k] + b[k] for k in FIELDS}


def subtract(a, b):
    return usage({k: a[k] - b[k] for k in FIELDS})


def valid_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise MeterError("A valid session_id and turn_id are required.")
    return value


def label(value):
    return value if isinstance(value, str) and ID.fullmatch(value) else None


def fresh():
    return {"version": 2, "cursor": None, "current_turn": None, "model": None,
            "provider": None, "effort": None, "turns": {}, "legacy_total": None,
            "latest_total": None, "warnings": [], "lines": 0}


def warn(target, message, key="warnings"):
    if message not in target.setdefault(key, []):
        target[key].append(message)


def turn(state, turn_id):
    return state["turns"].setdefault(turn_id, {
        "native": {}, "native_total": None, "fallback": [], "warnings": [],
        "status": "observed", "models": [], "efforts": [], "seen_usage": False})


def segment(state, counters, raw, request_known, model=None):
    return {"usage": counters, "model": label(model) or state["model"],
            "provider": state["provider"], "request_known": request_known,
            "cache_write_known": "cache_write_input_tokens" in raw}


def ingest(state, obj, session_id):
    """Accept only observed Codex telemetry shapes; never inspect message text."""
    if not isinstance(obj, dict):
        return
    kind, p = obj.get("type"), obj.get("payload")
    if not isinstance(p, dict):
        return
    if kind == "session_meta":
        if p.get("id") and p["id"] != session_id:
            raise MeterError("Transcript session identity does not match the hook.")
        state["provider"] = label(p.get("model_provider"))
        if p.get("forked_from_id"):
            warn(state, "Fork history may contain inherited usage; cost coverage is checked against native totals.")
    elif kind == "turn_context":
        state["current_turn"] = label(p.get("turn_id")) or state["current_turn"]
        state["model"] = label(p.get("model"))
        state["effort"] = label(p.get("effort"))
        if p.get("model_provider"):
            state["provider"] = label(p["model_provider"])
        if state["current_turn"]:
            t = turn(state, state["current_turn"])
            for key, val in (("models", state["model"]), ("efforts", state["effort"])):
                if val and val not in t[key]:
                    t[key].append(val)
    elif kind == "token_usage_record":
        # Native request and per-turn counters observed in Codex 0.158.0-alpha.2.1.
        if p.get("thread_id") != session_id:
            warn(state, "Foreign/inherited native records were excluded.")
            return
        tid = label(p.get("turn_id"))
        rid = label(p.get("response_id"))
        if not tid or not rid:
            raise MeterError("Native usage record is missing its identity.")
        t = turn(state, tid)
        counters = usage(p.get("usage"))
        cumulative = usage(p.get("turn_token_usage"))
        thread_total = usage(p.get("thread_token_usage"))
        if rid in t["native"]:
            if t["native"][rid]["usage"] != counters:
                warn(t, "Conflicting duplicate response counters; first record retained.")
            return
        if t["native_total"] and any(cumulative[k] < t["native_total"][k] for k in FIELDS):
            warn(t, "Native per-turn counters decreased; usage needs review.")
        entry = segment(state, counters, p["usage"], True, p.get("model"))
        if state["current_turn"] != tid and not label(p.get("model")):
            entry["model"] = None
        t["native"][rid] = entry
        t["native_total"] = cumulative
        t["seen_usage"] = True
        state["latest_total"] = thread_total
        # Also anchor a possible later legacy-only turn at the native total.
        state["legacy_total"] = thread_total
    elif kind == "event_msg":
        event = p.get("type")
        if event == "task_started":
            tid = label(p.get("turn_id"))
            if tid:
                state["current_turn"] = tid
                state["model"] = None
                state["effort"] = None
                turn(state, tid)
        elif event in ("task_complete", "turn_aborted"):
            tid = label(p.get("turn_id")) or state["current_turn"]
            if tid:
                turn(state, tid)["status"] = "completed" if event == "task_complete" else "interrupted"
        elif event == "model_rerouted":
            state["model"] = label(p.get("to_model"))
        elif event == "token_count":
            info = p.get("info")
            if not isinstance(info, dict) or not info.get("total_token_usage"):
                return  # Rate-limit-only events carry no new tokens.
            tid = state["current_turn"] or "unattributed"
            t = turn(state, tid)
            if t["native_total"] is not None:
                # Compaction may emit stale/placeholder legacy counters after a
                # complete native record. They cannot override native telemetry.
                return
            total = usage(info["total_token_usage"])
            last = usage(info["last_token_usage"]) if info.get("last_token_usage") else None
            prev = state["legacy_total"]
            state["legacy_total"] = total
            state["latest_total"] = total
            t["seen_usage"] = True
            if prev == total:
                return  # Duplicate usage / rate-limit notification.
            try:
                delta = subtract(total, prev or zero())
            except MeterError:
                # A reset is not a negative charge, and last alone cannot fill the gap.
                warn(state, "Cumulative counters reset or were corrected; thread coverage is incomplete.")
                warn(t, "Counter reset: only the last known request can be recovered.")
                delta = last
            if delta and delta["total_tokens"]:
                t["fallback"].append(segment(state, delta, info.get("last_token_usage") or {}, delta == last))
                if delta != last:
                    warn(t, "Request boundaries are missing for part of this turn; those tokens are unpriced.", "fallback_warnings")


def tail_hash(handle, offset):
    handle.seek(max(0, offset - 256))
    return hashlib.sha256(handle.read(min(offset, 256))).hexdigest()


def scan(path, state, session_id, budget_seconds=2.0):
    """Incremental JSONL reader: atomic records, bounded memory, replay on rotation."""
    path = Path(path).expanduser().resolve()
    # Nonblocking open avoids hanging on a pipe accidentally supplied as a path.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise MeterError("Transcript must be a regular file.")
        identity = [str(path), st.st_dev, st.st_ino]
        cursor = state.get("cursor")
        if (not cursor or cursor["identity"] != identity or st.st_size < cursor["offset"]
                or tail_hash(f, cursor["offset"]) != cursor["anchor"]
                or (st.st_size == cursor["offset"] and st.st_mtime_ns != cursor["mtime_ns"])):
            state = fresh()
            offset = 0
        else:
            offset = cursor["offset"]
        f.seek(offset)
        start = offset
        deadline = time.monotonic() + budget_seconds
        incomplete = False
        limited = False
        while True:
            line_start = f.tell()
            if line_start - start >= MAX_SCAN or time.monotonic() >= deadline:
                limited = True
                break
            line = f.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                non_usage = re.match(rb'^\s*\{\s*(?:"timestamp"\s*:\s*"[^"]*"\s*,\s*)?(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"(?:response_item|compacted|world_state)"\s*,', line[:512])
                # Skip large conversation/image records without holding them in memory.
                while line and not line.endswith(b"\n"):
                    line = f.readline(MAX_LINE + 1)
                    if f.tell() - start >= MAX_SCAN or time.monotonic() >= deadline:
                        limited = True
                        break
                if not line or limited:
                    f.seek(line_start)
                    incomplete = not limited
                    break
                if not non_usage:
                    warn(state, "Oversized JSONL record skipped; telemetry coverage may be incomplete.")
            elif not line.endswith(b"\n"):
                incomplete = True
                f.seek(line_start)
                break  # Never advance beyond a partially written record.
            else:
                try:
                    obj = json.loads(line)
                except (ValueError, UnicodeError):
                    warn(state, "Malformed JSONL record skipped; telemetry coverage may be incomplete.")
                else:
                    try:
                        ingest(state, obj, session_id)
                    except MeterError as exc:
                        if "identity does not match" in str(exc):
                            raise
                        warn(state, str(exc))
            state["lines"] += 1
            offset = f.tell()
        offset = f.tell()
        state["cursor"] = {"identity": identity, "offset": offset,
                           "anchor": tail_hash(f, offset), "mtime_ns": st.st_mtime_ns}
        state["pending_tail"] = incomplete
        state["scan_limited"] = limited
    return state


class Prices:
    def __init__(self, path=None, aliases=None, tier="standard"):
        self.data = json.loads(Path(path or ROOT / "data/prices.json").read_text(encoding="utf-8"))
        self.tier = tier
        if tier not in ("standard", "fast", "flex", "batch"):
            raise MeterError("Unsupported pricing tier.")
        self.aliases = dict(self.data.get("aliases", {}))
        self.aliases.update(aliases or {})
        if not all(isinstance(k, str) and isinstance(v, str) and v in self.data["models"]
                   for k, v in self.aliases.items()):
            raise MeterError("Model aliases must map to an explicit price-table model.")
        # Validate the entire table, including user-supplied rates, before using it.
        for model in self.data["models"].values():
            for rates in model["tiers"].values():
                for context in rates.values():
                    for amount in context.values():
                        if amount is not None and (not Decimal(str(amount)).is_finite() or Decimal(str(amount)) < 0):
                            raise MeterError("Prices must be finite non-negative numbers.")

    def cost_parts(self, seg):
        """Price each category with this request's model, tier and context length."""
        u = seg["usage"]
        if not u["total_tokens"]:
            return zero_costs(), None
        name = self.aliases.get(seg["model"], seg["model"])
        model = self.data["models"].get(name)
        if not model:
            return None, "Unknown model: " + (seg["model"] or "not recorded")
        if seg.get("provider") not in (None, "openai"):
            return None, "Non-OpenAI provider requires an explicit compatible adapter."
        if not seg["request_known"]:
            return None, "Missing per-request boundaries."
        if model.get("cache_write") and not seg["cache_write_known"]:
            return None, "Cache-write count is missing for this model."
        tier = model["tiers"].get(self.tier)
        if not tier:
            return None, "Pricing tier unavailable for this model."
        threshold = model.get("long_context_threshold")
        context = "long" if threshold and u["input_tokens"] > threshold else "short"
        rates = tier.get(context)
        if not rates:
            return None, "Long-context pricing unavailable for this model/tier."
        uncached = u["input_tokens"] - u["cached_input_tokens"] - u["cache_write_input_tokens"]
        billable = ((uncached, "input"), (u["cached_input_tokens"], "cached_input"),
                    (u["cache_write_input_tokens"], "cache_write"), (u["output_tokens"], "output"))
        amounts = zero_costs()
        for tokens, key in billable:
            if tokens:
                rate = rates.get(key)
                if rate is None:
                    return None, "A required token rate is unavailable."
                amounts[key] = Decimal(tokens) * Decimal(str(rate)) / Decimal(1_000_000)
        return amounts, None

    def cost(self, seg):
        amounts, reason = self.cost_parts(seg)
        return (sum(amounts.values(), Decimal(0)) if amounts is not None else None), reason


def money(value):
    return format(value, "f")


def zero_costs():
    return {key: Decimal(0) for key in ("input", "cached_input", "cache_write", "output")}


def cost_breakdown(u, amounts, complete, split_known):
    if u is None:
        return None
    counts = {
        "input": u["input_tokens"] - u["cached_input_tokens"] - u["cache_write_input_tokens"] if split_known else None,
        "cached_input": u["cached_input_tokens"],
        "cache_write": u["cache_write_input_tokens"] if split_known else None,
        "output": u["output_tokens"],
    }
    return {key: {"tokens": counts[key], "usd": money(value) if complete else None,
                  "known_usd": money(value)} for key, value in amounts.items()}


def summarize_turn(t, prices):
    segments = list(t["native"].values()) if t["native"] else t["fallback"]
    observed, priced, amounts = zero(), zero(), zero_costs()
    source_warnings = t["warnings"] + ([] if t["native"] else t.get("fallback_warnings", []))
    notes = list(source_warnings)
    for seg in segments:
        observed = add(observed, seg["usage"])
        parts, reason = prices.cost_parts(seg)
        if parts is None:
            if reason not in notes:
                notes.append(reason)
        else:
            priced = add(priced, seg["usage"])
            for key, amount in parts.items():
                amounts[key] += amount
    total = t["native_total"] or observed
    if observed != total:
        notes.append("Native turn total differs from available request records.")
    complete = t["seen_usage"] and observed == total and priced == total and not source_warnings
    cost = sum(amounts.values(), Decimal(0))
    writes_known = all(s["cache_write_known"] for s in segments)
    return {"usage": total if t["seen_usage"] else None,
            "source": "native-turn-usage" if t["native_total"] else "cumulative-delta",
            "usd": money(cost) if complete else None, "known_usd": money(cost),
            "priced_tokens": priced["total_tokens"], "cost_complete": complete,
            "cost_breakdown": cost_breakdown(total if t["seen_usage"] else None, amounts,
                                             complete, writes_known or complete),
            "status": t["status"], "models": sorted({s["model"] for s in segments if s["model"]}),
            "reasoning_efforts": t["efforts"],
            "cache_write_complete": writes_known,
            "warnings": list(dict.fromkeys(notes))}


def build_report(state, session_id, turn_id, prices):
    items = {tid: summarize_turn(t, prices) for tid, t in state["turns"].items()}
    selected = items.get(turn_id)
    known_usage, cost, priced, amounts = zero(), Decimal(0), 0, zero_costs()
    split_known = True
    complete = bool(items)
    notes = list(state["warnings"])
    for item in items.values():
        if item["usage"] is not None:
            known_usage = add(known_usage, item["usage"])
            for key, part in item["cost_breakdown"].items():
                amounts[key] += Decimal(part["known_usd"])
            split_known = split_known and item["cost_breakdown"]["input"]["tokens"] is not None
        cost += Decimal(item["known_usd"])
        priced += item["priced_tokens"]
        # Empty, newly started turns do not make historical thread costs partial.
        if item["usage"] is not None:
            complete = complete and item["cost_complete"]
        notes.extend(item["warnings"])
    total = state["latest_total"] or (known_usage if any(x["usage"] is not None for x in items.values()) else None)
    if total != known_usage:
        complete = False
        notes.append("Thread cumulative count and reconstructed history differ; dollar total is partial.")
    if state.get("pending_tail"):
        notes.append("Transcript has an incomplete final record; usage may still be arriving.")
    if state.get("scan_limited"):
        notes.append("Transcript scan budget reached; refresh to continue reading.")
    if state["warnings"] or state.get("pending_tail") or state.get("scan_limited"):
        complete = False
        if selected:
            selected["usd"] = None
            selected["cost_complete"] = False
            for part in (selected["cost_breakdown"] or {}).values():
                part["usd"] = None
    age = (date.today() - date.fromisoformat(prices.data["verified_at"])).days
    if age > 30:
        notes.append("Price table is more than 30 days old; verify rates before relying on the estimate.")
    return {"schema_version": 1, "plugin_version": VERSION, "session_id": session_id,
            "turn_id": turn_id, "observed_at": int(time.time()),
            "pricing": {"currency": "USD", "tier": prices.tier,
                        "verified_at": prices.data["verified_at"], "kind": "API equivalent, not a subscription bill"},
            "turn": selected,
            "thread": {"usage": total, "usd": money(cost) if complete and total is not None else None,
                       "known_usd": money(cost), "priced_tokens": priced, "cost_complete": bool(complete and total is not None),
                       "cost_breakdown": cost_breakdown(total, amounts, complete, split_known and total == known_usage)},
            "scope": "Current thread only; child threads are not scanned. Local telemetry snapshot.",
            "warnings": list(dict.fromkeys(notes))}
