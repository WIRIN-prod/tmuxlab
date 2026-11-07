---
name: tmuxlab
description: Work with other terminals and coding agents on this machine through tmuxlab - list the agents and what they're doing, open a pane beside yours to run a server or tests, start a helper agent, send another agent a prompt, read its output, and wait until it finishes or needs an answer. Use when a task benefits from running things in parallel or from checking on or coordinating with another agent.
---

# tmuxlab

You are running in a tmux pane managed by tmuxlab. The person can see every pane and agent from their browser or phone, so the panes you open are visible to them too.

First check you are in tmux: if `$TMUX_PANE` is empty, say so and don't use these commands.

## See what's running

    tmuxlab agents          # pane, agent, state, session:window.pane, last step or the question it asks

States: `working` (busy), `blocked` (waiting for an answer, e.g. a permission prompt), `done` (finished, nobody has looked yet), `idle` (at its prompt).

## Run something beside you

    tmuxlab split -- npm run dev           # prints the new pane id, e.g. %14
    tmuxlab split --down --cwd ../api -- npm test
    tmuxlab read %14 --lines 40            # check its output

Prefer this over running long-lived servers in your own shell: they keep running and the person can see them.

## Work with another agent

    tmuxlab new review -- claude           # a helper agent in its own session; prints its pane id
    tmuxlab send %15 "Review the diff in src/auth and list bugs only"
    tmuxlab wait %15 --until done --timeout 900
    tmuxlab read %15 --lines 80

`wait` exits 0 when the agent is done, 2 when it is blocked on a question (the question is printed), 124 on timeout. If it is blocked on a permission prompt, don't answer for it: tell the person, or `tmuxlab notify` them.

## Tell the person

    tmuxlab notify "Migration ready" "Needs your review before I run it on staging"

## Rules

- Never send text to a pane you didn't start unless the person asked you to.
- Don't approve permission prompts in other agents' panes.
- Close what you no longer need: `tmux kill-pane -t %14`.
