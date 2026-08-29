#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-codex-continue POC: 读取本机 Codex 项目与会话，生成「续作包」预览。
零依赖。对应设计文档 dsh-codex-continue-design.md §3/§4。
用法: python3 poc/codex_reader.py [session_id 过滤词] [--limit N]
"""
import json, os, re, sys, glob
from pathlib import Path
from datetime import datetime

CODEX_HOME = Path(os.path.expanduser("~/.codex"))
SESSIONS = CODEX_HOME / "sessions"
INDEX = CODEX_HOME / "session_index.jsonl"

TOOL_TAIL = 400          # tool output 保留尾部长度
ARGS_PREVIEW = 160       # tool arguments 预览长度
FIRST_MSG_MAX = 800      # goal 截断

SCAFFOLD_MARKERS = (
    "recommended_plugins", "Codex desktop context", "multi_agent_mode",
    "You are '/root'", "You are Codex, a coding agent",
    "You are Codex, a highly capable", "<app-context>",
)


def is_scaffold(text):
    """过滤 rollouts 里的系统脚手架消息（角色可能是 user/assistant）"""
    head = text[:200]
    return any(m in head for m in SCAFFOLD_MARKERS)


def load_index():
    idx = {}
    if INDEX.exists():
        for line in INDEX.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                o = json.loads(line)
                idx[o["id"]] = o
            except Exception:
                continue
    return idx


def parse_rollout(path, idx):
    """返回 (index_entry, events) —— events 为规范事件列表（§3.2）"""
    meta, events = None, []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get("type")
            pl = o.get("payload", {}) or {}
            if t == "session_meta":
                meta = pl
            elif t == "event_msg" and pl.get("type") == "task_started":
                events.append({"kind": "turnStart", "turnId": pl.get("turn_id"), "at": pl.get("started_at")})
            elif t == "response_item":
                pt = pl.get("type")
                if pt == "message":
                    role, parts = pl.get("role"), pl.get("content") or []
                    text = ""
                    if isinstance(parts, str):
                        text = parts
                    elif isinstance(parts, list):
                        for p in parts:
                            if isinstance(p, dict) and p.get("type") in ("input_text", "output_text", "text"):
                                text += p.get("text", "")
                    if text.strip():
                        events.append({"kind": "user" if role == "user" else "assistant", "text": text})
                elif pt == "reasoning":
                    events.append({"kind": "reasoning", "summary": str(pl.get("summary", ""))})
                elif pt == "function_call":
                    args = pl.get("arguments") or ""
                    events.append({"kind": "tool", "name": pl.get("name"), "callId": pl.get("call_id"), "args": args[:ARGS_PREVIEW]})
                elif pt == "function_call_output":
                    out = pl.get("output") or ""
                    if isinstance(out, list):  # 部分版本 output 是部件数组
                        out = "".join(p.get("text", "") for p in out if isinstance(p, dict))
                    if not isinstance(out, str):
                        out = str(out)
                    m = re.search(r"Process exited with code (\d+)", out)
                    events.append({"kind": "toolResult", "callId": pl.get("call_id"),
                                   "exit": int(m.group(1)) if m else None,
                                   "tail": out[-TOOL_TAIL:], "truncated": len(out) > TOOL_TAIL})
    if meta is None:
        return None, []
    entry = idx.get(meta.get("session_id"), {})
    entry = dict(entry)
    entry.update({"sessionId": meta.get("session_id"), "cwd": meta.get("cwd"),
                  "cliVersion": meta.get("cli_version"), "modelProvider": meta.get("model_provider"),
                  "startedAt": meta.get("timestamp")})
    entry["title"] = entry.get("thread_name")  # 索引的 thread_name 即标题
    entry["rolloutPath"] = str(path)
    return entry, events


def compact_events(events, tail=200):
    """§4.2 压缩：tool 成对保留；reasoning 只留 summary；输出截尾"""
    kept, skip_until = [], None
    for e in events:
        if e["kind"] == "tool":
            skip_until = e["callId"]
            kept.append("  ▶ %s: %s" % (e["name"], e["args"].replace("\n", " ")))
        elif e["kind"] == "toolResult":
            if skip_until is not None and e["callId"] != skip_until:
                continue
            skip_until = None
            kept.append("    └ exit=%s tail=%s" % (e["exit"], e["tail"].replace("\n", " ")[:tail]))
        elif e["kind"] == "reasoning":
            if e["summary"]:
                kept.append("  (思考: %s)" % e["summary"][:tail])
        elif e["kind"] == "turnStart":
            kept.append("  --- 回合开始 ---")
        else:
            text = e.get("text", "")
            kept.append(("user: " if e["kind"] == "user" else "agent: ") + text.replace("\n", " ")[:400])
    return kept


def main():
    filter_word = sys.argv[1] if len(sys.argv) > 1 else None
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    idx = load_index()
    rollouts = sorted(glob.glob(str(SESSIONS / "**" / "rollout-*.jsonl"), recursive=True),
                      key=lambda p: p, reverse=True)
    sessions = []
    for p in rollouts:
        entry, events = parse_rollout(p, idx)
        if entry:
            entry["messageCount"] = sum(1 for e in events if e["kind"] in ("user", "assistant"))
            sessions.append((entry, events))
    if filter_word:
        sessions = [s for s in sessions if filter_word.lower() in (s[0].get("title") or "").lower()
                    or filter_word.lower() in (s[0].get("cwd") or "").lower()]
    # 按项目聚合
    projects = {}
    for entry, _ in sessions:
        cwd = entry.get("cwd") or "(unknown)"
        projects.setdefault(cwd, []).append(entry)
    print("== 项目（cwd 聚合，共 %d 个 / %d 个会话）==" % (len(projects), len(sessions)))
    for cwd, ents in sorted(projects.items(), key=lambda kv: -len(kv[1])):
        newest = max(e.get("updatedAt", "") for e in ents)
        print("• %s  (%d 会话, 最近 %s)" % (cwd, len(ents), newest[:16]))
    print()
    print("== 最近会话（标题 / 时间 / 模型 / 消息数）==")
    for entry, _ in sessions[:limit]:
        print("- [%s] %s · %s · msgs=%s · cli=%s" % (
            entry.get("title") or "(无标题)", (entry.get("updatedAt") or entry.get("startedAt") or "")[:16],
            entry.get("modelProvider"), entry.get("messageCount"), entry.get("cliVersion")))
    # 挑一个最热的会话展示 resume bundle 预览
    print()
    if sessions:
        entry, events = sessions[0]
        print("== Resume bundle 预览：%s ==" % (entry.get("title") or entry.get("sessionId")))
        print("cwd      :", entry.get("cwd"))
        print("model    :", entry.get("modelProvider"), "· cli:", entry.get("cliVersion"))
        users = [e["text"] for e in events if e["kind"] == "user" and not is_scaffold(e["text"])]
        assistants = [e["text"] for e in events if e["kind"] == "assistant" and not is_scaffold(e["text"])]
        print("goal     :", (users[0][:FIRST_MSG_MAX] if users else ""))
        print("lastUser :", (users[-1][:300] if users else ""))
        print("lastAgent:", (assistants[-1][:300] if assistants else ""))
        print("compact  :")
        for line in compact_events(events)[:25]:
            print("   " + line[:200])
        print("  ...（共 %d 条压缩事件）" % len(compact_events(events)))


if __name__ == "__main__":
    main()
