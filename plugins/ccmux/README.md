# ccmux plugin

A Claude Code plugin whose `dispatch` and `relay` skills teach your agent to drive other AI coding agents (Claude Code, Codex, Cursor, OpenCode, Pi, Gemini, or any custom agent): `dispatch` launches and collects work through `ccmux invoke`, and `relay` moves output between sessions that already exist. Your LLM is the router; ccmux is the cross-harness substrate it dispatches work through.

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

The `dispatch` skill triggers when you ask your agent to coordinate, delegate, fan out, or pipeline work across multiple agents (for example, "plan with claude, implement with codex, search with gemini"). It teaches the mechanics of firing, polling, joining, cancelling, and reading worker output, plus where the invoke boundary is: when to hand a long or human-supervised job off to `ccmux spawn` (a live pane) instead of invoking it. You supply the agent-per-task policy in your prompt.

The `relay` skill covers moving output between sessions that already exist: reading a peer's last response with `ccmux last`, relaying one into another session with `ccmux handoff` (so the payload never passes through the orchestrator's context), and what to do with a `[ccmux handoff]` message when your agent is on the receiving end.

Once installed, the skills are available to your agent as `/ccmux:dispatch` and `/ccmux:relay` (and trigger automatically from the descriptions above). See [`skills/dispatch/SKILL.md`](skills/dispatch/SKILL.md) and [`skills/relay/SKILL.md`](skills/relay/SKILL.md) for the full skills.

## Other agents

The plugin wrapper is Claude Code specific, but the skills themselves are standard [Agent Skills](https://agentskills.io) written harness-agnostically: they need only a shell and the ccmux CLI on `PATH`. To use them from another skills-capable agent (Codex, Cursor, OpenCode, and others), copy the skill directories into that agent's skills location, for example:

```bash
cp -r skills/dispatch ~/.codex/skills/dispatch
cp -r skills/relay ~/.codex/skills/relay
```

Check your agent's Agent Skills documentation for where it discovers skills.
