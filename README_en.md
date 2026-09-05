> **2026-09-06 · Important prefix-cache fixes**: Replaced the moving Delta with fixed snapshots at initialization/compaction and retained communication history. Also fixed system-prompt reversion during tool continuations after Runtime message wakes, preventing repeated changes to long-context prefixes.

# Research Pi

[简体中文](README.md) · English

> Session is not enough for research. Project is.

A good coding agent is not necessarily a good research agent.

Research Pi is built for computational research in AI, robotics, communications, optimization, and simulation. Its central questions are not just whether the code is correct, but **whether it supports the experiment, what the experiment tells us, and which experiment would teach us the most next.**

It is neither a longer research prompt nor a skill claiming to automate science. It keeps project progress, experiment records, discussions, and agent collaboration at the Project level, so switching sessions or models does not mean starting the explanation over.

`Pi Core 0.84.2` · `macOS / Linux / WSL2`

## Design principles

1. **Projects outlive conversations.** Sessions end and models change; research questions, experimental results, and key decisions should remain.
2. **Research needs human participation.** Agents can find sources, write code, run experiments, and organize evidence. A successful command does not authorize them to declare a research direction validated.
3. **Remember what matters.** Preserve questions, hypotheses, evidence, failed approaches, and next steps—not every chat message in the model's context.
4. **Let different models do what they do best.** Pi leads the research, Codex handles long-running execution, and Pi-analysis helps the user understand, question, and discuss. They exchange short messages rather than copying entire contexts.
5. **Find the right direction before polishing the code.** Exploration allows substantial replacements, quick trials, and rollbacks. Invest in engineering quality and reproducibility once the direction is worth retaining.

## What makes it different

🧠 **A new conversation, the same research thread.** The harness stores project goals, key decisions, recent progress, and handoffs outside the conversation. New sessions load a role-appropriate project snapshot, and compaction carries memory forward. Everyday conversation uses the existing history without repeatedly injecting dynamic summaries.

🔎 **Find the experiments you have already done.** The experiment ledger records questions, interventions, observations, and validity judgments—including failed experiments. Search the current project by default, or deliberately search globally across indexed experiment records from multiple projects, bringing earlier evidence into the next decision.

📬 **Think independently. Collaborate through short messages.** The Leader advances the research, Codex executes tasks, and Analysis hosts a separate discussion. A durable mailbox connects them: progress updates do not interrupt reasoning; requests for decisions and completed results reach the current Leader. Pending messages survive session replacement.

This flow is simplified from the communication diagram in the thesis:

```mermaid
sequenceDiagram
    actor U as User
    participant L as Pi Leader
    participant R as Project Runtime
    participant C as Codex Executor
    participant A as Pi-analysis
    U->>L: Research question and decisions
    L->>R: Delegate a task
    R->>C: Task and project context
    C-->>R: Progress record (no Leader wake)
    opt Input required
        C->>R: Write ASK to mailbox
        R->>L: Deliver to current Leader
        L->>R: Answer / steer
        R->>C: Resume the same task
    end
    C->>R: Structured result
    R->>L: Deliver result and record receipt
    A->>R: Short synthesis (proposal, not evidence)
    R->>L: Deliver when appropriate, following Leader rotation
    L->>U: Evidence, limitations, and next steps
    Note over L,A: Separate conversations; no full-history copying
```

## My favorite feature: the dual-session workflow

Research Pi's memory, communication, and permission mechanisms let you keep two windows open: **Pi Leader** advances the experiments while **Pi-analysis** stays available for questions, challenges, and new ideas.

![Research Pi dual-session workspace: Pi Leader advances experiments while Pi-analysis hosts an independent discussion and sends only a short synthesis](docs/assets/dual-session-workbench.png)

Long discussions in Pi-analysis stay in their own window instead of crowding the Leader's context. Only when the discussion produces something the research effort should know does it become a short note to the Leader.

Keep Pi Leader running in one terminal and open Pi-analysis in another:

```sh
# Terminal A: advance the research
pi

# Terminal B: understand and discuss without interrupting the Leader
pi --analysis
```

Pi-analysis has access to the same project's current work view, but maintains its own conversation. The discussion can be long; the note to the Leader can be short:

```text
/analysis send Current interpretation, key evidence, remaining uncertainty, and suggested next step
```

The mailbox delivers that synthesis—not the entire conversation. An idle Leader can receive it immediately; if the Leader is working, the note waits for an appropriate delivery point.

The research can keep moving while the user has a separate place to ask questions and think. An independent Codex discussion session can use the same channel through `pi analysis context` / `pi analysis send`.

## Quick start

Requires Node.js `>=22.19`. Research Pi currently uses a Unix-style toolchain. On Windows, use **WSL2** rather than running the agent directly in native PowerShell.

### macOS / Linux

```sh
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#main'
pi setup
pi paths
```

### Windows (WSL2 recommended)

First, install Ubuntu from an administrator PowerShell:

```powershell
wsl --install -d Ubuntu
```

Then open Ubuntu, install the Linux version of Node.js `>=22.19`, and install from `main` as on Linux:

```sh
sudo apt update
sudo apt install -y git zsh ripgrep fd-find
node --version
npm --version
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#main'
pi setup
pi paths
```

WSL2 is a Linux environment, so it can use `main` directly for the latest features. Keep research projects in the WSL filesystem, such as `~/research/...`, rather than `/mnt/c` or `/mnt/d`. The `windows-research-pi` branch is a security preview that additionally blocks Windows-mounted drives, `.exe` execution, and PowerShell interop. Use it to evaluate stricter host isolation when granting agents greater execution autonomy.

Inside the TUI, use Pi's native `/login` to authenticate with a provider and `/model` to switch models. Research Pi does not maintain a second model/profile catalog. For providers using API keys, or for the small DeepSeek search pass, you can also fill in the `credentialsPath` reported by `pi paths`:

```dotenv
DEEPSEEK_API_KEY=...
ZAI_API_KEY=...
OPENCODE_API_KEY=...
```

Then launch inside your research project:

```sh
cd /path/to/research-project
pi
```

To read results and discuss them without allowing the session to edit code or start experiments:

```sh
pi --analysis
```

When opening an existing project for the first time, try:

```text
First recover the current research state read-only: identify the research goal,
competing hypotheses, existing evidence, failed approaches, and key open questions.
Do not launch a large experiment yet. Explain what ProjectView is missing and
which next action would provide the most useful information.
```

## Core capabilities

| Capability | Purpose |
|---|---|
| Research Contract | Makes exploration, falsification, validity checks, and evidence-driven convergence the default |
| Project Runtime | Maintains Project State, Actors, Actions, the mailbox, and Leader Session ownership |
| Dual Session | Lets the Leader advance the research while Pi-analysis discusses independently and sends only a concise synthesis |
| ProjectView | Loads a fixed snapshot at initialization and compaction: `RESEARCH.md`, Project Brief, and the current frontier; ordinary turns append conversation and tool results |
| Research Memory | Searches historical sessions and experiment records with local full-text indexing, without a vector database |
| Research Compaction | Produces structured state with provenance after the model settles, rather than merely summarizing chat |
| Experiment Records | Writes each result to a lightweight ledger without mechanically duplicating Markdown or raw artifacts; supports research transitions and narrow state amendments |
| Codex Collaboration | Invokes advisors/executors through resumable missions and connects them to Pi through the Runtime mailbox |
| Project Boundary | Restricts model commands to the current project by default; SSH, external files, and host commands require explicit capability grants |
| Research Briefing | Recovers context at major results or handoffs and translates internal terminology into reports the user can assess |

ProjectView is captured once at project-context initialization and after successful compaction. The user-maintained `RESEARCH.md` preserves project intent, Project Brief summarizes the overall direction and closed phases, and the current frontier supplies the handoff point. The snapshot stays unchanged across ordinary turns: no automatic Delta is appended or moved. New progress enters through user messages, tool results, and individually delivered communications; consumed messages remain in history. The live view and experiment ledger remain available on demand. Explicit role or context changes establish a new snapshot, keeping previously sent prefixes stable across ordinary turns.

For long-running research, maintain a short `RESEARCH.md` with enduring information: the problem, final success criteria, overall approach, explicit non-goals, and the user's decision principles. Avoid experiment logs, current runs, and daily TODOs. Research Pi links the file and captures its first 3600 characters when establishing a snapshot. Editing it does not automatically rewrite the current session's prefix. Communicate urgent changes in conversation or ask the agent to read the file; the next compaction or new session will update the snapshot.

```md
# Project North Star

## Problem and final goal
...

## Overall approach
...

## Non-goals and decision principles
...
```

ProjectView is a derived view, with no global clear button that could erase project ledgers. Use `/runtime new clean` for a separate session without inherited project memory. An Analysis Session can pause injection with `/runtime context off`. Removing or editing `RESEARCH.md` affects only the Anchor; experiments, Runtime records, and historical sessions remain.

## Common entry points

| Command | Purpose |
|---|---|
| `/runtime` | Inspect ProjectView, Actors, Actions, the mailbox, and session status |
| `/runtime rotate` | Create a Leader Session that inherits Project state without copying the old transcript |
| `pi --analysis` | Open a read-only Analysis Session without taking Leader ownership or receiving its mailbox |
| `/analysis send <summary>` | Send a useful synthesis to the Leader; use `/runtime promote <reason>` to become the Leader |
| `pi analysis context/send` | Let an independent Codex session read ProjectView or send a synthesis of at most 1200 characters to the Leader |
| `/runtime context <on\|off>` | Keep Analysis read-only while toggling ProjectView injection for subsequent turns |
| `/runtime new clean` | Create a clean session without inherited ProjectView; restore it with `/runtime inherit` |
| `/memory <query>` | Search the current Project's historical sessions and experiment records |
| `/side <question>` | Ask a question in isolation; promote a useful answer with `/side use <id>` |
| `/watch` | Observe Codex commands, file edits, and subagent activity without adding them to the Leader's context |
| `/actors`, `/inbox` | Inspect active Actors and pending Runtime messages |
| `/login`, `/model`, `/scoped-models` | Use Pi's native authentication, model switching, and model scope; Research Pi does not duplicate the provider catalog |
| `/config` | Inspect unified configuration and switch themes |
| `/boundary doctor` | Check the project, Git, Python, sandbox, and Codex environment |
| `pi --full-access` | Explicitly disable the project sandbox for Leader/Codex executor for this launch; Analysis/advisor remain read-only |

Model-callable research tools include `record_experiment`, `record_research_transition`, `amend_project_state`, `research_checkpoint`, `research_memory_search/read`, `codex_delegate`, and `host_capability`.

## Safety and data

- Model shell commands can read and write the current project and normal Git data by default. Other projects, host credentials, and Unix sockets are not automatically exposed.
- SSH targets, read-only files outside the project, and host commands require explicit approval scoped to one use, the current session, or the current project.
- Private keys, `.env` files, API keys, keychain contents, and cloud credentials must not enter model context.
- When full host access is genuinely needed, explicitly use `pi --full-access`. It applies only to that launch and displays `🔓 full access` in the status bar.
- Configuration, sessions, Runtime state, Codex jobs, capability grants, and traces live in user state directories, outside the research repository.
- Project-local `.pi/` is automatically hidden through `.git/info/exclude`. Old terminal Codex jobs are archived into a central ledger using two retention thresholds.
- `pi-traced` may record complete prompts and tool content; use it only for short diagnostic sessions. Tracing and Codex DEBUG SQLite logging are disabled by default.

## Configuration and directories

```text
~/.config/research-pi/        config.json, schema, credentials.env
~/.local/state/research-pi/   sessions, Runtime, memory, Codex, grants, trace
<research-project>/.pi/      local lightweight experiment ledger (hidden from Git status)
```

Use `pi paths` for the actual paths. Research Pi's `config.json` manages Runtime, compaction, Codex, search, resources, and UI. The Leader's provider, model, thinking level, and custom models are managed through Pi's native configuration:

```sh
pi config show
# Inside the TUI: /login, /model, /scoped-models, /settings
```

Research Pi disables global skill/extension auto-discovery. It loads only explicitly reviewed harness extensions, the bundled `research-briefing` skill, and configured allowlisted resources.

## Development and verification

```sh
git clone git@github.com:RosMarinas/Research-Pi.git
cd Research-Pi
npm install --ignore-scripts
cp .env.example .env
./install-user.sh

npm run check
npm test
npm run test:package
```

- `pi`: run the Research Pi harness.
- `pi-raw`: run the pinned, unmodified Pi Core for behavioral comparison.
- `pi-traced`: temporarily enable sensitive tracing.
- `./run-pi.sh --workspace /path/to/project`: run directly from a source checkout.

## Documentation

- [Basic usage guide](docs/pi-basic-guide.md)
- [Unified configuration](docs/configuration.md)
- [Project Runtime testing and recovery](docs/research-runtime-test-guide.md)
- [Security model and local data](docs/security-model.md)
- [Design thesis](thesis/ResearchPi.pdf)

## License

Original Research Pi code and documentation are available under the [MIT License](LICENSE). Third-party components retain their respective licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).
