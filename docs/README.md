# docs

| File | What it is |
| --- | --- |
| [UNDERSTANDING-ORDER-OF-PLAY.md](UNDERSTANDING-ORDER-OF-PLAY.md) | The from-scratch explanation: what an AI agent is, what this one does, and how every part of it works. Written for readers with no technical background as well as for engineers. |

---

## Demo video

**There is no demo video yet.** This folder does not contain one, and neither does any release
of this repository. If you were sent here expecting a recording, it does not exist.

Screenshots of the running interface can be produced from the built artifact without any
capabilities, since it renders a complete example day on its own:

```bash
node build.mjs
# then open dist/order-of-play.html in a browser
```

When a walkthrough does get recorded, this sequence covers the parts that distinguish it from
a to-do list:

1. Open with an empty queue.
2. Dump four unsorted tasks in one message and let the agent assign days and order them.
3. Say "I'm sleepy, not starting the write-up" and show the queue re-sequence.
4. Complete a task by the agent, then one by button.
5. Show the profile panel filling with a learned habit.
6. Move a task forward three times to surface the push badge and the agent calling it out.
7. Leave a task overdue, then roll it forward and show the push it costs.
8. Undo the rollover.
9. Toggle Quick / Standard and show the tier readout.
