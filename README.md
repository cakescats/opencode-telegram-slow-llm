# opencode-telegram-slow-llm

**A Telegram bridge for [opencode](https://opencode.ai), built for slow local inference.**

🇬🇧 English · [🇷🇺 Русский](README.ru.md)

A local model at 5–15 tokens a second turns an ordinary agent task into several minutes of thinking, tool calls and confirmations. Bridges written for fast cloud models break on that: they time the task out, show a frozen "typing…", stop reading the chat while the model works, and let confirmation buttons expire before anyone sees them. This one is written for the slow case. It was built and tested with Qwen3.8-Flash-Next (a 125B MoE) served on one 16 GB laptop GPU by [qwfnfer](https://github.com/cakescats/QwFNfer-Secure-RU) at about 10–12 tokens a second.

The bot talks to its users in Russian; the code, the logs and this document are in English.

## What it does for slow inference

- **Never stops listening.** Polling Telegram is independent of the running task: `/stop`, confirmation buttons, a newcomer's password and other chats are handled while the model is still working. A message sent during a task is queued, and the bot says so.
- **One live "thinking" message, edited every 3 seconds**: elapsed time, the current step, the agent's latest interim note, and the paragraph of reasoning being written right now (it is replaced, not appended, so the message stays short). No new message per update, so no spam.
- **The answer arrives as its own message** after the thinking, which then settles into "💭 Reasoning · 1:12".
- **Patient timeouts.** A run is aborted only after 20 minutes without a single event, and never while it waits for your button. A confirmation waits 10 minutes, with a countdown in the message. Both are settings.
- **Confirmations that leave a history, not clutter.** A request comes as a message with buttons and a countdown ("in 0:20 on its own: ⛔ reject"). Once answered — by you, by the timeout, or in another window — that message is deleted and a line goes into the thinking message instead: "✅ bash: ls -la · allowed once · waited 0:12". The thinking message stays the last one in the chat and keeps every decision of the task.
- **Settings per chat, from a menu** (⚙️ Settings, edited in place, kept on disk): ask about everything · edits on their own, commands asked · **everything allowed, no prompts** · read only; what happens to an unanswered request (reject or allow once) and after how long (30 s to 10 min); the fast mode.
- **`/fast`**: answers without reasoning (appends `/no_think`, which qwfnfer and other Qwen servers understand), several times faster for simple questions.
- **Survives restarts.** The chat ↔ session map is kept on disk; permission requests the event stream missed are fetched from opencode every 30 seconds and sent as buttons. Both the old (`permission.updated`) and the current (`permission.asked`) opencode event formats are understood.
- **One bot per token.** Only the process started by the service runs the bridge (`OPENCODE_TELEGRAM_BRIDGE=1`), so the opencode Desktop app loading the same plugin does not start a second poller and fight over `getUpdates`.
- **Unreliable networks**: Telegram calls use a fresh connection and a short deadline and are retried; an edit is never waited on by the next one.
- **No tool output in the thinking message**: command output and code stream as parts of their own and are kept out; only the paragraph of reasoning being written right now is shown.

And the basics: password onboarding (whoever sends the password is authorised for good; 5 wrong tries lock a chat for 10 minutes), a command keyboard under the input field and the Telegram command menu, per-chat model and permission mode.

## Requirements

- opencode 1.18 or newer (tested with 1.18.32).
- Linux with systemd user services (anything that can run `opencode serve` in the background works; the script targets systemd).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Install

```bash
git clone https://github.com/cakescats/opencode-telegram-slow-llm.git && cd opencode-telegram-slow-llm
```

```bash
scripts/install.sh --project ~/path/to/your/project
```

It copies `plugin/telegram.ts` and `agent/telegram.md` into `~/.config/opencode` (previous versions go to `~/.config/opencode/backup/`), creates `~/.config/opencode/telegram.env` from the example if there is none, writes `~/.config/systemd/user/opencode-telegram.service` with the project path and a random server password (an existing one is kept), enables and starts it.

Then put the bot token and a password into `~/.config/opencode/telegram.env` and restart:

```bash
systemctl --user restart opencode-telegram
```

Open the bot in Telegram and send it the password.

## Running it

| | |
|---|---|
| Restart (after changing `telegram.env` or updating) | `systemctl --user restart opencode-telegram` |
| Stop / start | `systemctl --user stop opencode-telegram` · `systemctl --user start opencode-telegram` |
| Is it running | `systemctl --user status opencode-telegram` |
| Service log | `journalctl --user -u opencode-telegram -f` |
| Bridge log (opencode's) | `grep -aE 'telegram bridge\|poll\|permission\|stuck' ~/.local/share/opencode/log/opencode.log \| tail` |
| Update | `git pull && scripts/install.sh --project ~/path/to/your/project` |
| Start at boot without logging in | `loginctl enable-linger $USER` |

A healthy start logs `telegram bridge ready as @your_bot … stuck=20m permission=10m`.

Restarting the service ends the task that is running and drops queued messages; send them again afterwards.

## Settings (`~/.config/opencode/telegram.env`)

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `TELEGRAM_PASSWORD` | — | password for new users; also `/password <new>` from the chat |
| `TELEGRAM_ALLOWED` | — | static allow-list of chat/user ids |
| `TELEGRAM_AGENT` | `build` | opencode agent; `telegram` is the one in `agent/telegram.md` |
| `TELEGRAM_MODEL` | opencode default | `provider/model` |
| `TELEGRAM_PERMISSIONS` | `ask` | default mode for chats that have not chosen one: `ask` · `edits` (file edits allowed, commands asked) · `allow` (no prompts) · `deny` (read only) |
| `TELEGRAM_STUCK_MIN` | `20` | minutes without any event before a run is aborted |
| `TELEGRAM_PERMISSION_MIN` | `10` | default time a confirmation waits for chats that have not set their own (⚙️ Settings) |
| `TELEGRAM_DEBUG` | `0` | `1` logs every event type |

State files next to it: `telegram-users.json` (authorised ids), `telegram-settings.json` (each chat's settings) and `telegram-sessions.json` (chat ↔ session). Delete the latter to start every chat from a fresh session.

## Commands

Buttons under the input field: ⏹ Stop · 🆕 New · ⚡ Fast · 📊 Status · 📂 Sessions · ⚙️ Settings.

`/new` new session · `/stop` interrupt · `/fast` toggle answers without reasoning · `/status` · `/sessions` · `/use <id>` attach to a session · `/model [provider/model]` · `/settings` · `/permissions ask|edits|allow|deny` · `/password <new>` · `/who` · `/revoke` log this chat out · `/menu` show the buttons · `/help`

## When something is off

- **The bot does not answer at all.** Check `systemctl --user status opencode-telegram`, then that `TELEGRAM_BOT_TOKEN` is set and the log has `telegram bridge ready`. If the log shows `Conflict`, another process polls the same token: only the service may set `OPENCODE_TELEGRAM_BRIDGE=1`.
- **Messages pile up, the model is idle.** The agent is probably waiting for a confirmation. The thinking message shows "🔐 waiting for your decision"; the buttons come as a separate message and are re-sent within 30 seconds if they were missed.
- **`Cannot connect to API` in the answer.** The model server is down or restarting; send the message again once it is up.
- **The model server answers 401.** It requires a key: set `options.apiKey` for the provider in `opencode.json`.

## Security

- `telegram.env`, the users file and the service file are created mode 0600; keep them that way.
- **Never let an agent `curl` the Telegram API with the token.** opencode logs every command it runs, and the token ends up in `~/.local/share/opencode/log/opencode.log`. If that happened, revoke the token in @BotFather (`/revoke`) and put the new one in `telegram.env`.
- Asking is the default for a reason: everyone who knows the password can make the agent run commands in your project. "Everything allowed" is a per-chat choice in ⚙️ Settings, with a warning.
- The opencode server listens on 127.0.0.1 only and is protected by `OPENCODE_SERVER_PASSWORD`.

## License

MIT, see [LICENSE](LICENSE).
