# ccmux plugin

A Claude Code plugin whose `dispatch` skill teaches your agent to drive other AI coding agents (Claude Code, Codex, Cursor, OpenCode, Pi, Gemini, or any custom agent) through `ccmux invoke`. Your LLM is the router; ccmux is the cross-harness substrate it dispatches work through.

## Prerequisite

This plugin is **additive glue for the ccmux CLI**, which the skill calls (`ccmux invoke`, `ccmux invoke list`, and friends). The skill does nothing without it. Install ccmux first and make sure it is on your `PATH`:

- See the [ccmux install instructions](https://github.com/epilande/ccmux#-installation).
- Verify with `ccmux daemon status`.

## Install

In Claude Code:

```
/plugin marketplace add epilande/ccmux
/plugin install ccmux@ccmux
```

Or from a shell:

```bash
claude plugin marketplace add epilande/ccmux
claude plugin install ccmux@ccmux
```

## What it does

The skill triggers when you ask your agent to coordinate, delegate, fan out, or pipeline work across multiple agents (for example, "plan with claude, implement with codex, search with gemini"). It teaches the mechanics of firing, polling, joining, cancelling, and reading worker output, plus where the invoke boundary is: when to hand a long or human-supervised job off to `ccmux spawn` (a live pane) instead of invoking it. You supply the agent-per-task policy in your prompt.

It also covers moving output between sessions that already exist: reading a peer's last response with `ccmux last`, relaying one into another session with `ccmux handoff` (so the payload never passes through the orchestrator's context), and what to do with a `[ccmux handoff]` message when your agent is on the receiving end.

Once installed, the skill is available to your agent as `/ccmux:dispatch` (and triggers automatically from the descriptions above). See [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) for the full skill.

## Other agents

The plugin wrapper is Claude Code specific, but the skill itself is a standard [Agent Skill](https://agentskills.io) written harness-agnostically: it needs only a shell and the ccmux CLI on `PATH`. To use it from another skills-capable agent (Codex, Cursor, OpenCode, and others), copy the skill directory into that agent's skills location, for example:

```bash
cp -r skills/dispatch ~/.codex/skills/dispatch
```

Check your agent's Agent Skills documentation for where it discovers skills.
